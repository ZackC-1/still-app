import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";
import { unmount } from "svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import {
  ChromeStorageAdapter,
  createSettingsIntentRouter,
  requireModernSettings,
  type SettingsIntent,
} from "@still/core/storage";
import {
  createExtensionUiController,
  CHROMIUM_SURFACE_GUIDANCE,
  STRINGS,
  type CommittedPopupBinding,
  type CommittedPopupToggle,
} from "@still/core/ui";
import { CONSENT_KEY, QUEUE_KEY } from "@still/core/analytics";
import {
  createBackgroundAnalytics,
  createPageAnalytics,
  ANALYTICS_MESSAGE_KIND,
} from "../../../lib/analytics.js";
import PopupApp from "../PopupApp.svelte";

const mounted = vi.hoisted(() => ({
  instances: [] as Record<string, unknown>[],
}));
vi.mock("svelte", async (importOriginal) => {
  const real = await importOriginal<typeof import("svelte")>();
  return {
    ...real,
    mount: (
      component: Parameters<typeof real.mount>[0],
      options: Parameters<typeof real.mount>[1],
    ) => {
      const instance = real.mount(component, options);
      if (options.target instanceof HTMLElement && options.target.id === "app")
        mounted.instances.push(instance);
      return instance;
    },
  };
});
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const instance of mounted.instances.splice(0)) await unmount(instance);
  cleanup();
  for (const stop of stops.splice(0)) stop();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function installBrowser(atomic = true) {
  const store: Record<string, unknown> = {
    "still:settings": {
      settings: structuredClone(DEFAULT_SETTINGS),
      syncMetadata: null,
    },
    [CONSENT_KEY]: false,
  };
  const listeners = new Set<
    (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      area: string,
    ) => void
  >();
  const origin = "chrome-extension://synthetic/";
  // U3-W3: change events can be withheld so recovery cannot depend on their delivery.
  let changeEvents = true;
  const set = async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) {
      const oldValue = store[key];
      store[key] = structuredClone(value);
      if (changeEvents) for (const listener of [...listeners])
        listener(
          { [key]: { oldValue, newValue: structuredClone(value) } },
          "local",
        );
    }
  };
  const fetch = vi.fn(async () => new Response("{}"));
  const background = createBackgroundAnalytics(
    {
      isFirefox: false,
      config: { key: "phc_synthetic", host: "https://analytics.invalid" },
      appVersion: "test",
      local: {
        get: async (key) => store[key] ?? null,
        set: async (key, value) => {
          store[key] = structuredClone(value);
        },
      },
      shared: null,
      sharedGraceMs: 0,
      fetch,
      uuid: () => "00000000-0000-4000-8000-000000000001",
    },
    "synthetic",
    origin,
  );
  background.onStart(null);
  const messages: Record<string, unknown>[] = [];
  const sendMessage = vi.fn((message: Record<string, unknown>) => {
    messages.push(structuredClone(message));
    if (message.kind === ANALYTICS_MESSAGE_KIND)
      return new Promise<unknown>((resolve) => {
        if (
          !background.listener(
            message,
            { id: "synthetic", url: origin + "popup.html" },
            resolve,
          )
        )
          resolve(undefined);
      });
    if (message.action === "getState")
      return Promise.resolve({
        userId: null,
        entitled: false,
        pendingOtp: null,
        checkoutPending: null,
      });
    if (message.action === "getSyncStatus") return Promise.resolve(null);
    if (lostReply && message.kind === "still:settings-intent") {
      // The worker is terminated before it replies: Chrome rejects the page's call, and the
      // reply below is never delivered. "after-write" lets the real router commit first.
      const plan = lostReply;
      lostReply = null;
      return (async () => {
        if (plan.when === "after-write") {
          const persisted = new Promise<void>((resolve) => {
            afterWrite = resolve;
          });
          router(message, { id: "synthetic", url: origin + "popup.html" }, () => {});
          await persisted;
          await plan.between?.();
        }
        throw new Error(
          "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
        );
      })();
    }
    return new Promise<unknown>((resolve) => {
      router(message, { id: "synthetic", url: origin + "popup.html" }, resolve);
    });
  });
  const openOptionsPage = vi.fn(async () => {});
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) =>
          key in store ? { [key]: structuredClone(store[key]) } : {},
        set,
      },
      onChanged: {
        addListener: (
          listener: (
            changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
            area: string,
          ) => void,
        ) => listeners.add(listener),
        removeListener: (
          listener: (
            changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
            area: string,
          ) => void,
        ) => listeners.delete(listener),
      },
    },
    runtime: {
      id: "synthetic",
      getURL: () => origin,
      sendMessage,
      openOptionsPage,
    },
    tabs: { create: async () => ({ id: 1 }) },
  });
  const authority = new ChromeStorageAdapter({ authority: true });
  let lostReply: {
    when: "before-write" | "after-write";
    between?: () => Promise<void>;
  } | null = null;
  let afterWrite: (() => void) | null = null;
  let commit = async (intent: SettingsIntent) => {
    const record = await authority.commitIntent(intent);
    afterWrite?.();
    afterWrite = null;
    return record;
  };
  const router = createSettingsIntentRouter(
    (intent) => commit(intent),
    "synthetic",
    origin,
    (record) => authority.set(record),
  );
  if (atomic) await authority.initializeAtomic("never-linked");
  return {
    authority,
    store,
    background,
    messages,
    fetch,
    sendMessage,
    openOptionsPage,
    port(next: typeof commit) {
      commit = next;
    },
    loseNextIntentReply(plan: NonNullable<typeof lostReply>) {
      lostReply = plan;
    },
    withholdChangeEvents() {
      changeEvents = false;
    },
  };
}

describe("actual Chromium popup mount", () => {
  it("configured default main preserves legacy controls and operational Settings/auth/privacy routes", async () => {
    const f = await installBrowser(false);
    vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "");
    vi.stubEnv("VITE_SUPABASE_URL", "https://synthetic.invalid");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "synthetic-public-key");
    const settingsBefore = structuredClone(f.store["still:settings"]);
    document.body.innerHTML = '<div id="app"></div>';
    const legacyMain = "../main.js?legacy-compatibility";
    await import(legacyMain);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Still on/off" })).toBeTruthy(),
    );
    expect(
      screen.queryByRole("button", { name: "YouTube Blocker" }),
    ).toBeNull();
    expect(f.store["still:settings"]).toEqual(settingsBefore);
    // The existing bounded core-intent path serializes a legacy save in the same writer.
    await fireEvent.click(screen.getByRole("switch", { name: "Still on/off" }));
    await waitFor(() =>
      expect(
        (f.store["still:settings"] as { settings: { globalOn: boolean } })
          .settings.globalOn,
      ).toBe(false),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Still on/off" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(
      (f.store["still:settings"] as { atomic?: unknown }).atomic,
    ).toBeUndefined();
    await fireEvent.click(screen.getByRole("switch", { name: "Still on/off" }));
    await waitFor(() =>
      expect(
        (f.store["still:settings"] as { settings: { globalOn: boolean } })
          .settings.globalOn,
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Still on/off" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on Instagram Reels" }),
    );
    await waitFor(() =>
      expect(
        (
          f.store["still:settings"] as {
            settings: { services: { instagram: boolean } };
          }
        ).settings.services.instagram,
      ).toBe(false),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: /Open settings & setup guide/ }),
    );
    expect(f.openOptionsPage).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole("button", { name: /Sign in/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(STRINGS.emailConsent.disclosureTitle)).toBeTruthy();
    await f.background.client.flush();
    expect(f.store[QUEUE_KEY] ?? []).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  async function mountDesktop() {
    let binding!: CommittedPopupBinding;
    const controller = createExtensionUiController(undefined, {
      onCommittedPopupBinding(value) {
        binding = value;
        stops.push(value.stop);
      },
    });
    await flush();
    const view = render(PopupApp, {
      controller,
      committedPopupBinding: binding,
      surfaceGuidance: CHROMIUM_SURFACE_GUIDANCE,
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "YouTube Blocker" }),
      ).toBeTruthy(),
    );
    return view;
  }

  it("remembers one open section on this origin across popup lifetimes without changing saved blocking choices", async () => {
    const f = await installBrowser();
    const saved = await f.authority.get();
    const first = await mountDesktop();
    expect(
      screen
        .getByRole("button", { name: "YouTube Blocker" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "Instagram Blocker" }),
    );
    expect(localStorage.getItem("still-popup-open")).toBe("instagram");
    first.unmount();
    const second = await mountDesktop();
    expect(
      screen
        .getByRole("button", { name: "Instagram Blocker" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "YouTube Blocker" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await fireEvent.click(
      screen.getByRole("button", { name: "Instagram Blocker" }),
    );
    expect(localStorage.getItem("still-popup-open")).toBeNull();
    expect(await f.authority.get()).toEqual(saved);
    second.unmount();
  });

  it.each(["malformed", "throwing-read", "throwing-write"])(
    "keeps real controls usable with %s presentation memory",
    async (mode) => {
      const f = await installBrowser();
      localStorage.setItem("still-popup-open", "not-a-service");
      if (mode === "throwing-read")
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
          throw new Error("Synthetic storage denial");
        });
      if (mode === "throwing-write")
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new Error("Synthetic storage denial");
        });
      await mountDesktop();
      expect(
        screen
          .getByRole("button", { name: "YouTube Blocker" })
          .getAttribute("aria-expanded"),
      ).toBe("false");
      await fireEvent.click(
        screen.getByRole("button", { name: "YouTube Blocker" }),
      );
      await fireEvent.click(screen.getByRole("switch", { name: "Shorts" }));
      await waitFor(async () =>
        expect(
          requireModernSettings((await f.authority.get())!).sites[
            "youtube.shorts"
          ],
        ).toBe(false),
      );
      expect(
        requireModernSettings((await f.authority.get())!).services.youtube,
      ).toBe(true);
    },
  );

  it("mounts the desktop expander and commits Shorts through the actual authority without a legacy setter", async () => {
    const f = await installBrowser();
    let binding!: CommittedPopupBinding;
    const controller = createExtensionUiController(undefined, {
      onCommittedPopupBinding(value) {
        binding = value;
        stops.push(value.stop);
      },
    });
    await flush();
    const legacy = vi.spyOn(controller, "toggleService");
    render(PopupApp, {
      controller,
      committedPopupBinding: binding,
      surfaceGuidance: CHROMIUM_SURFACE_GUIDANCE,
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "YouTube Blocker" }),
      ).toBeTruthy(),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    const before = (await f.authority.get())!;
    await fireEvent.click(screen.getByRole("switch", { name: "Shorts" }));
    await waitFor(async () =>
      expect(
        requireModernSettings((await f.authority.get())!).sites[
          "youtube.shorts"
        ],
      ).toBe(false),
    );
    const after = (await f.authority.get())!;
    expect(after.atomic!.sequence).toBe(before.atomic!.sequence + 1);
    expect(requireModernSettings(after).services.youtube).toBe(true);
    expect(requireModernSettings(after).sites["instagram.reels"]).toBe(true);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("real main captures the factory binding, preserves actual Settings/auth routes and emits only committed toggle messages", async () => {
    const f = await installBrowser();
    vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true");
    vi.stubEnv("VITE_SUPABASE_URL", "https://synthetic.invalid");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "synthetic-public-key");
    document.body.innerHTML = '<div id="app"></div>';
    await import("../main.js");
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Still" })).toBeTruthy(),
    );
    const toggles = () =>
      f.messages.filter(
        (message) =>
          message.action === "track" &&
          ["global_toggled", "service_toggled"].includes(String(message.name)),
      );
    expect(toggles()).toEqual([]);
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await waitFor(() =>
      expect(toggles()).toEqual([
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "global_toggled",
          props: { enabled: false, where: "popup" },
        },
      ]),
    );
    expect((await f.authority.get())!.settings.globalOn).toBe(false);
    await f.authority.commitIntent({
      path: "globalOn",
      value: true,
      updatedAt: 101,
    });
    await flush();
    expect(toggles()).toHaveLength(1);
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on Instagram" }),
    );
    await waitFor(() => expect(toggles()).toHaveLength(2));
    expect(toggles()[1]).toMatchObject({
      name: "service_toggled",
      props: { service: "instagram", enabled: false, where: "popup" },
    });
    f.port(async () => ({
      ...(await f.authority.get())!,
      intentCommitted: false,
    }));
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await flush();
    expect(toggles()).toHaveLength(2);
    await fireEvent.click(
      screen.getByRole("button", { name: /Settings. Find Still in Chrome/ }),
    );
    expect(f.openOptionsPage).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(STRINGS.emailConsent.disclosureTitle)).toBeTruthy();
    await f.background.client.flush();
    expect(f.store[QUEUE_KEY] ?? []).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("Settings stays available with no accepted modern record and default host rendering remains opt-in", async () => {
    const f = await installBrowser();
    await chrome.storage.local.set({
      "still:settings": {
        settings: { ...structuredClone(DEFAULT_SETTINGS), updatedAt: 999 },
        syncMetadata: null,
      },
    });
    let binding!: CommittedPopupBinding;
    const controller = createExtensionUiController(undefined, {
      onCommittedPopupBinding(value) {
        binding = value;
        stops.push(value.stop);
      },
    });
    await flush();
    const view = render(PopupApp, {
      controller,
      committedPopupBinding: binding,
      surfaceGuidance: CHROMIUM_SURFACE_GUIDANCE,
    });
    expect(screen.queryByRole("switch", { name: "Still" })).toBeNull();
    await fireEvent.click(
      screen.getByRole("button", { name: /Settings. Find Still in Chrome/ }),
    );
    expect(f.openOptionsPage).toHaveBeenCalledOnce();
    view.unmount();
    render(PopupApp, {
      controller,
      surfaceGuidance: CHROMIUM_SURFACE_GUIDANCE,
    });
    expect(screen.getByRole("switch", { name: "Still on/off" })).toBeTruthy();
  });

  it("actual Firefox page analytics keeps the prompt in the usage toggle's gesture and failed transport never affects saving", async () => {
    const f = await installBrowser();
    const request = vi.fn(async () => false),
      remove = vi.fn(async () => true);
    Object.assign(chrome, { permissions: { request, remove } });
    const send = vi.fn(async (message: Record<string, unknown>) => {
      if (message.action === "sharing")
        return { enabled: true, noticeNeeded: true };
      if (message.action === "setSharing") return false;
      throw new Error("Synthetic unreachable analytics");
    });
    const analytics = createPageAnalytics(true, send);
    let binding!: CommittedPopupBinding;
    const controller = createExtensionUiController(undefined, {
      analytics,
      onCommittedPopupBinding(value) {
        binding = value;
        stops.push(value.stop);
      },
    });
    await flush();
    render(PopupApp, {
      controller,
      committedPopupBinding: binding,
      onCommittedPopupToggle: ({ enabled }: CommittedPopupToggle) =>
        analytics.track("global_toggled", { enabled, where: "popup" }),
      surfaceGuidance: CHROMIUM_SURFACE_GUIDANCE,
    });
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.usage.noticeTurnOff }),
    );
    expect(remove).toHaveBeenCalledWith({
      data_collection: ["technicalAndInteraction"],
    });
    expect(request).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Still" })).toBeTruthy(),
    );
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await waitFor(async () =>
      expect((await f.authority.get())!.settings.globalOn).toBe(false),
    );
    expect(controller.usageSharing).toBe(false);
  });
});

// U3-W3: the background worker is terminated between a deliberate choice and its reply. Change
// events are withheld, so the screen must recover by reading the stored record, not by luck.
describe("Chromium popup when the worker dies before replying", () => {
  type Saved = {
    settings: { globalOn: boolean };
    atomic: {
      sequence: number;
      pending: { operations: { value: boolean; localStep: number }[] }[];
    };
  };
  async function mountMain(tag: string) {
    const f = await installBrowser();
    vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true");
    vi.stubEnv("VITE_SUPABASE_URL", "https://synthetic.invalid");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "synthetic-public-key");
    document.body.innerHTML = '<div id="app"></div>';
    const main = `../main.js?${tag}`;
    await import(/* @vite-ignore */ main);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Still" })).toBeTruthy(),
    );
    const saved = () => f.store["still:settings"] as Saved;
    return {
      f,
      saved,
      before: structuredClone(saved()),
      checked: () =>
        screen.getByRole("switch", { name: "Still" }).getAttribute("aria-checked"),
      intents: () =>
        f.messages.filter((message) => message.kind === "still:settings-intent"),
      reported: () =>
        f.messages.filter(
          (message) =>
            message.action === "track" &&
            ["global_toggled", "service_toggled"].includes(String(message.name)),
        ),
    };
  }

  it("after the durable write: shows the saved choice from storage, reports nothing and never resends", async () => {
    const m = await mountMain("lost-after-write");
    m.f.withholdChangeEvents();
    m.f.loseNextIntentReply({ when: "after-write" });
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await waitFor(() => expect(m.checked()).toBe("false"));
    expect(m.saved().settings.globalOn).toBe(false);
    expect(m.saved().atomic.sequence).toBe(m.before.atomic.sequence + 1);
    expect(m.saved().atomic.pending).toHaveLength(1);
    expect(m.intents()).toHaveLength(1);
    expect(m.reported()).toEqual([]);
    // Settings stay usable: the next deliberate choice commits and is reported once.
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await waitFor(() => expect(m.reported()).toHaveLength(1));
    expect(m.checked()).toBe("true");
    expect(m.saved().atomic.pending).toHaveLength(2);
    expect(m.intents()).toHaveLength(2);
  });

  it("before the write: nothing is saved, nothing is claimed, and the switch works again", async () => {
    const m = await mountMain("lost-before-write");
    m.f.withholdChangeEvents();
    m.f.loseNextIntentReply({ when: "before-write" });
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await waitFor(() => expect(m.intents()).toHaveLength(1));
    for (let i = 0; i < 5; i += 1) await flush();
    expect(m.saved()).toEqual(m.before);
    expect(m.checked()).toBe("true");
    expect(m.reported()).toEqual([]);
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await waitFor(() => expect(m.reported()).toHaveLength(1));
    expect(m.saved().settings.globalOn).toBe(false);
    expect(m.checked()).toBe("false");
    expect(m.intents()).toHaveLength(2);
  });

  it("a newer choice saved before recovery is shown and kept; the lost choice is not replayed", async () => {
    const m = await mountMain("lost-then-newer");
    const service = (name: string) =>
      screen.getByRole("switch", { name }).getAttribute("aria-checked");
    expect(service("Still on Instagram")).toBe("true");
    expect(service("Still on YouTube")).toBe("true");
    m.f.withholdChangeEvents();
    m.f.loseNextIntentReply({
      when: "after-write",
      // Another extension page saves a different field after the lost Instagram Off was saved.
      between: async () => {
        await m.f.authority.commitIntent({ path: "services.youtube", value: false, updatedAt: 500 });
      },
    });
    await fireEvent.click(screen.getByRole("switch", { name: "Still on Instagram" }));
    // Change events are withheld: only the recovery read can show either saved choice.
    await waitFor(() => expect(service("Still on YouTube")).toBe("false"));
    expect(service("Still on Instagram")).toBe("false");
    const saved = m.f.store["still:settings"] as {
      settings: { services: { instagram: boolean; youtube: boolean } };
      atomic: { sequence: number; pending: { operations: { path: string; value: boolean }[] }[] };
    };
    expect(saved.settings.services).toMatchObject({ instagram: false, youtube: false });
    expect(saved.atomic.sequence).toBe(m.before.atomic.sequence + 2);
    expect(saved.atomic.pending.map((p) => p.operations[0])).toEqual([
      expect.objectContaining({ path: "services.instagram", value: false }),
      expect.objectContaining({ path: "services.youtube", value: false }),
    ]);
    expect(m.intents()).toHaveLength(1);
    expect(m.reported()).toEqual([]);
  });
});
