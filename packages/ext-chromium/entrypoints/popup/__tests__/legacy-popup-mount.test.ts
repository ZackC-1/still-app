import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { unmount } from "svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import {
  ChromeStorageAdapter,
  createSettingsIntentRouter,
  type SettingsIntent,
} from "@still/core/storage";
import { STRINGS } from "@still/core/ui";
import { CONSENT_KEY } from "@still/core/analytics";
import {
  createBackgroundAnalytics,
  ANALYTICS_MESSAGE_KIND,
} from "../../../lib/analytics.js";

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
const pageIntervals = new Set<ReturnType<typeof setInterval>>();
let trackingPageIntervals = false;
function trackPageIntervals() {
  if (trackingPageIntervals) return;
  trackingPageIntervals = true;
  const startInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation((...args) => {
    const handle = startInterval(...args);
    pageIntervals.add(handle);
    return handle;
  });
}

// The browser adapter may retain an earlier fixture transport; count actual reads on every port.
let accountStatusReads = 0;
async function closeFixturePage() {
  // Production owns these timers until the browser page closes. Node outlives this jsdom page.
  for (const handle of pageIntervals) clearInterval(handle);
  pageIntervals.clear();
  for (const instance of mounted.instances.splice(0)) await unmount(instance);
  cleanup();
  for (const stop of stops.splice(0)) stop();
}
afterEach(async () => {
  await closeFixturePage();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  trackingPageIntervals = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function installBrowser(
  initial: unknown = {
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      globalOn: false,
      updatedAt: 100,
      schemaVersion: 1,
    },
    syncMetadata: null,
  },
  present = true,
) {
  const store: Record<string, unknown> = {
    ...(present ? { "still:settings": structuredClone(initial) } : {}),
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
  let delivery: (reply: unknown) => Promise<unknown> = async (reply) => reply;
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
    if (message.action === "getSyncStatus") {
      accountStatusReads++;
      return Promise.resolve(null);
    }
    return new Promise<unknown>((resolve, reject) => {
      router(
        message,
        { id: "synthetic", url: origin + "popup.html" },
        (reply) => {
          void delivery(reply).then(resolve, reject);
        },
      );
    });
  });
  const openOptionsPage = vi.fn(async () => {});
  const local = {
    get: vi.fn(async (key: string) =>
      key in store ? { [key]: structuredClone(store[key]) } : {},
    ),
    set: vi.fn(set),
  };
  vi.stubGlobal("chrome", {
    storage: {
      local,
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
  let commit = (intent: SettingsIntent) => authority.commitIntent(intent);
  const router = createSettingsIntentRouter(
    (intent) => commit(intent),
    "synthetic",
    origin,
    (record) => authority.set(record),
  );

  return {
    authority,
    local,
    delayReply(next: typeof delivery) {
      delivery = next;
    },
    store,
    background,
    messages,
    fetch,
    sendMessage,
    openOptionsPage,
    port(next: typeof commit) {
      commit = next;
    },
    withholdChangeEvents() {
      changeEvents = false;
    },
  };
}

function configured() {
  vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "");
  vi.stubEnv("VITE_SUPABASE_URL", "https://synthetic.invalid");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "synthetic-public-key");
}
async function main(tag: string) {
  trackPageIntervals();
  document.body.innerHTML = '<div id="app"></div>';
  const path = `../main.js?legacy-receipt-${tag}`;
  await import(path);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const toggles = (f: Awaited<ReturnType<typeof installBrowser>>) =>
  f.messages.filter(
    (m) =>
      m.kind === ANALYTICS_MESSAGE_KIND &&
      m.action === "track" &&
      ["global_toggled", "service_toggled"].includes(String(m.name)),
  );

describe("actual configured legacy main", () => {
  it("does not present startup defaults while the actual factory saved read is pending", async () => {
    const f = await installBrowser();
    configured();
    const gate = deferred<Record<string, unknown>>();
    f.local.get.mockImplementation(async (key) =>
      key === "still:settings" ? gate.promise : {},
    );
    await main("loading");
    await flush();
    expect(screen.queryByRole("switch", { name: "Still on/off" })).toBeNull();
    expect(
      document
        .querySelector(".still-ui")
        ?.getAttribute("data-settings-receipt"),
    ).toBe("loading");
    expect(f.local.set).not.toHaveBeenCalled();
    gate.resolve({ "still:settings": f.store["still:settings"] });
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Still on/off" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
  });
  it("waits for the real broker true receipt before reporting the existing closed event", async () => {
    const f = await installBrowser();
    configured();
    await main("durable-receipt");
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Still on/off" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    const gate = deferred<void>();
    f.delayReply(async (reply) => {
      await gate.promise;
      return reply;
    });
    await fireEvent.click(screen.getByRole("switch", { name: "Still on/off" }));
    await flush();
    expect(
      (f.store["still:settings"] as { settings: { globalOn: boolean } })
        .settings.globalOn,
    ).toBe(true);
    expect(toggles(f)).toHaveLength(0);
    gate.resolve();
    await waitFor(() => expect(toggles(f)).toHaveLength(1));
  });
  it("holds failed durable writes and sends no toggle event", async () => {
    const f = await installBrowser();
    configured();
    await main("write-failure");
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Still on/off" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    f.local.set.mockRejectedValueOnce(new Error("synthetic write failed"));
    await fireEvent.click(screen.getByRole("switch", { name: "Still on/off" }));
    await waitFor(() =>
      expect(screen.getByText("Settings are unavailable.")).toBeTruthy(),
    );
    expect(toggles(f)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(
      (f.store["still:settings"] as { settings: { globalOn: boolean } })
        .settings.globalOn,
    ).toBe(false);
  });
});

describe("actual legacy factory recovery and preserved host operations", () => {
  it.each(["read-failed", "keyed-null", "corrupt", "future"])(
    "holds %s on real initial hydration without unhandled rejection or implicit writes",
    async (kind) => {
      const initial =
        kind === "keyed-null"
          ? null
          : kind === "corrupt"
            ? "corrupt"
            : {
                settings: {
                  ...structuredClone(DEFAULT_SETTINGS),
                  schemaVersion: kind === "future" ? 3 : 1,
                  globalOn: false,
                  updatedAt: 100,
                },
                syncMetadata: null,
              };
      const f = await installBrowser(initial);
      configured();
      if (kind === "read-failed") {
        const real = f.local.get.getMockImplementation()!;
        let failed = false;
        f.local.get.mockImplementation(async (key) => {
          if (key === "still:settings" && !failed) {
            failed = true;
            throw new Error("initial read down");
          }
          return real(key);
        });
      }
      await main(`initial-${kind}`);
      await waitFor(() =>
        expect(screen.getByText("Settings are unavailable.")).toBeTruthy(),
      );
      expect(screen.queryByRole("switch", { name: "Still on/off" })).toBeNull();
      expect(f.local.set).not.toHaveBeenCalled();
      expect(toggles(f)).toHaveLength(0);
      expect(
        screen.getByRole("button", { name: STRINGS.auth.signInCta }),
      ).toBeTruthy();
      const settings = screen.getByRole("button", { name: /settings/i });
      await fireEvent.click(settings);
      expect(f.openOptionsPage).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("link", { name: "Privacy policy" })).toBeTruthy();
    },
  );
  it("singleflights explicit retry through one real settings get and never replays the failed action", async () => {
    const f = await installBrowser();
    configured();
    await main("pure-retry");
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Still on/off" })).toBeTruthy(),
    );
    f.local.set.mockRejectedValueOnce(new Error("save down"));
    await fireEvent.click(screen.getByRole("switch", { name: "Still on/off" }));
    await waitFor(() =>
      expect(screen.getByText("Settings are unavailable.")).toBeTruthy(),
    );
    const gets = f.local.get.mock.calls.filter(
      (c) => c[0] === "still:settings",
    ).length;
    const commands = f.messages.filter(
      (m) => m.kind === "still:settings-intent",
    ).length;
    const real = f.local.get.getMockImplementation()!;
    const gate = deferred<Record<string, unknown>>();
    f.local.get.mockImplementation(async (key) =>
      key === "still:settings" ? gate.promise : real(key),
    );
    const retry = screen.getByRole("button", { name: "Try again" });
    await fireEvent.click(retry);
    await fireEvent.click(retry);
    await flush();
    expect(
      f.local.get.mock.calls.filter((c) => c[0] === "still:settings"),
    ).toHaveLength(gets + 1);
    expect(f.local.set).toHaveBeenCalledTimes(1);
    expect(toggles(f)).toHaveLength(0);
    gate.resolve({ "still:settings": f.store["still:settings"] });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("switch", {
            name: "Still on/off",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(
      f.messages.filter((m) => m.kind === "still:settings-intent"),
    ).toHaveLength(commands);
    expect(f.local.set).toHaveBeenCalledTimes(1);
  });
  // U3-W3: legacy mode keeps the existing manual recovery. A reply lost after the durable write
  // shows "Settings are unavailable."; only Try again re-reads, once, and nothing is replayed.
  it("a reply lost after the durable write holds until Try again re-reads once, with no replay", async () => {
    const f = await installBrowser();
    configured();
    await main("lost-reply");
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Still on/off" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    f.withholdChangeEvents();
    f.delayReply(async () => {
      throw new Error(
        "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
      );
    });
    await fireEvent.click(screen.getByRole("switch", { name: "Still on/off" }));
    await waitFor(() =>
      expect(screen.getByText("Settings are unavailable.")).toBeTruthy(),
    );
    expect(
      (f.store["still:settings"] as { settings: { globalOn: boolean } })
        .settings.globalOn,
    ).toBe(true);
    const intents = () =>
      f.messages.filter((m) => m.kind === "still:settings-intent");
    expect(intents()).toHaveLength(1);
    expect(toggles(f)).toHaveLength(0);
    for (let i = 0; i < 5; i += 1) await flush();
    // No automatic read: the hold stays until the person asks.
    expect(screen.getByText("Settings are unavailable.")).toBeTruthy();
    const reads = () =>
      f.local.get.mock.calls.filter((c) => c[0] === "still:settings").length;
    const readsBefore = reads();
    const writesBefore = f.local.set.mock.calls.length;
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Still on/off" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(screen.queryByText("Settings are unavailable.")).toBeNull();
    expect(reads()).toBe(readsBefore + 1);
    expect(f.local.set.mock.calls.length).toBe(writesBefore);
    expect(intents()).toHaveLength(1);
    expect(toggles(f)).toHaveLength(0);
  });
  it("closing the actual main view suppresses the late event while its durable write survives", async () => {
    const f = await installBrowser();
    configured();
    await main("closed");
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Still on/off" })).toBeTruthy(),
    );
    const gate = deferred<void>();
    f.delayReply(async (reply) => {
      await gate.promise;
      return reply;
    });
    await fireEvent.click(screen.getByRole("switch", { name: "Still on/off" }));
    await flush();
    expect(
      (f.store["still:settings"] as { settings: { globalOn: boolean } })
        .settings.globalOn,
    ).toBe(true);
    for (const instance of mounted.instances.splice(0)) await unmount(instance);
    gate.resolve();
    await flush();
    expect(toggles(f)).toHaveLength(0);
  });
});

describe("actual main recovery regression", () => {
  it("projects unsaved package defaults after saved Off is absent and commits one deliberate Off", async () => {
    const f = await installBrowser();
    configured();
    await main("prior-off-absence-regression");
    const global = () => screen.getByRole("switch", { name: "Still on/off" });
    await waitFor(() =>
      expect(global().getAttribute("aria-checked")).toBe("false"),
    );
    f.local.set.mockRejectedValueOnce(new Error("save down"));
    await fireEvent.click(global());
    await waitFor(() =>
      expect(screen.getByText("Settings are unavailable.")).toBeTruthy(),
    );
    delete f.store["still:settings"];
    const writes = f.local.set.mock.calls.length;
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        document
          .querySelector(".still-ui")
          ?.getAttribute("data-settings-receipt"),
      ).toBe("absent"),
    );
    expect(global().getAttribute("aria-checked")).toBe("true");
    expect(f.local.set).toHaveBeenCalledTimes(writes);
    expect(toggles(f)).toHaveLength(0);
    await fireEvent.click(global());
    await waitFor(() => expect(toggles(f)).toHaveLength(1));
    expect(f.local.set).toHaveBeenCalledTimes(writes + 1);
    expect(
      (f.store["still:settings"] as { settings: { globalOn: boolean } })
        .settings.globalOn,
    ).toBe(false);
    expect(toggles(f)[0]).toEqual({
      kind: "still:analytics",
      action: "track",
      name: "global_toggled",
      props: { enabled: false, where: "popup" },
    });
    for (const instance of mounted.instances.splice(0)) await unmount(instance);
    await main("prior-off-absence-reopen");
    await waitFor(() =>
      expect(global().getAttribute("aria-checked")).toBe("false"),
    );
    expect(toggles(f)).toHaveLength(1);
  });

  it("a late rejected older broker operation cannot hold newer actual saved choices", async () => {
    const f = await installBrowser({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        schemaVersion: 1,
        globalOn: true,
        services: {
          ...DEFAULT_SETTINGS.services,
          youtube: false,
          tiktok: false,
        },
        updatedAt: 100,
      },
      syncMetadata: null,
    });
    configured();
    await main("late-failed-after-newer-ready");
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Still on YouTube Shorts" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    const old = deferred<void>();
    let admitted = 0;
    f.port(async (intent) => {
      if (++admitted === 1) await old.promise;
      return f.authority.commitIntent(intent);
    });
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on YouTube Shorts" }),
    );
    await flush();
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on TikTok website" }),
    );
    await waitFor(() => expect(toggles(f)).toHaveLength(1));
    old.reject(new Error("older operation failed"));
    await flush();
    expect(screen.queryByText("Settings are unavailable.")).toBeNull();
    expect(
      (
        screen.getByRole("switch", {
          name: "Still on/off",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      screen
        .getByRole("switch", { name: "Still on TikTok website" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(f.local.set).toHaveBeenCalledTimes(1);
    expect(toggles(f)).toHaveLength(1);
  });
});


describe("actual main page timer ownership", () => {
  it("teardown cancels page polling while preserving an unrelated interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // This interval belongs to another owner and exists before the page mounts.
    const unrelated = vi.fn();
    const otherTimer = setInterval(unrelated, 2_000);
    try {
      await installBrowser();
      configured();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await main("page-timer-owner");
      await waitFor(() =>
        expect(screen.getByRole("switch", { name: "Still on/off" })).toBeTruthy(),
      );
      const accountReads = () => accountStatusReads;
      const mountedReads = accountReads();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(accountReads()).toBeGreaterThan(mountedReads);
      expect(unrelated).toHaveBeenCalledTimes(1);
      await closeFixturePage();
      expect(document.querySelector(".still-ui")).toBeNull();
      const closedReads = accountReads();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(unrelated).toHaveBeenCalledTimes(4);
      expect(accountReads()).toBe(closedReads);
    } finally {
      clearInterval(otherTimer);
    }
  });
});
