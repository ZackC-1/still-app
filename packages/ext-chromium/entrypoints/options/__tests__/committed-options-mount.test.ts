import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import {
  ChromeStorageAdapter,
  createSettingsIntentRouter,
  requireModernSettings,
  type SettingsIntent,
} from "@still/core/storage";
import { CONSENT_KEY, QUEUE_KEY } from "@still/core/analytics";
import {
  createBackgroundAnalytics,
  ANALYTICS_MESSAGE_KIND,
} from "../../../lib/analytics.js";
// Only the browser boundary is synthetic; factory, caches, router and UI remain actual.
vi.mock("wxt/browser", () => ({
  get browser() {
    return globalThis.chrome;
  },
}));
import OptionsApp from "../OptionsApp.svelte";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});
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
  const set = async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) {
      const oldValue = store[key];
      store[key] = structuredClone(value);
      for (const listener of [...listeners])
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
            { id: "synthetic", url: origin + "options.html" },
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
    return new Promise<unknown>((resolve) => {
      router(
        message,
        { id: "synthetic", url: origin + "options.html" },
        resolve,
      );
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
      getURL: (path = "") => origin + path.replace(/^\//, ""),
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
  };
}

describe("actual Chromium options mount", () => {
  it("uses the actual factory runtime binding and commits free choices with options-only telemetry", async () => {
    const f = await installBrowser();
    vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true");
    vi.stubEnv("VITE_SUPABASE_URL", "https://synthetic.invalid");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "synthetic-public-key");
    render(OptionsApp);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "YouTube Blocker" }),
      ).toBeTruthy(),
    );
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
    const toggles = () =>
      f.messages.filter(
        (message) =>
          message.action === "track" &&
          ["global_toggled", "service_toggled"].includes(String(message.name)),
      );
    expect(toggles()).toEqual([]);
    await fireEvent.click(
      screen.getByRole("switch", { name: "Still on Instagram" }),
    );
    await waitFor(() => expect(toggles()).toHaveLength(1));
    expect(toggles()[0]).toMatchObject({
      name: "service_toggled",
      props: { service: "instagram", enabled: false, where: "options" },
    });
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await waitFor(() => expect(toggles()).toHaveLength(2));
    expect(toggles()[1]).toMatchObject({
      name: "global_toggled",
      props: { enabled: false, where: "options" },
    });
    expect((await f.authority.get())!.settings.globalOn).toBe(false);
    await f.background.client.flush();
    expect(f.store[QUEUE_KEY] ?? []).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe("actual options default runtime isolation", () => {
  it("retains configured legacy choices without promoting a document or mounting D03", async () => {
    const f = await installBrowser(false);
    vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "");
    vi.stubEnv("VITE_SUPABASE_URL", "https://synthetic.invalid");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "synthetic-public-key");
    const before = structuredClone(f.store["still:settings"]);
    render(OptionsApp);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Still on/off" })).toBeTruthy(),
    );
    expect(
      screen.queryByRole("button", { name: "YouTube Blocker" }),
    ).toBeNull();
    expect(f.store["still:settings"]).toEqual(before);
    await fireEvent.click(screen.getByRole("switch", { name: "Still on/off" }));
    await waitFor(() =>
      expect(
        (f.store["still:settings"] as { settings: { globalOn: boolean } })
          .settings.globalOn,
      ).toBe(false),
    );
    expect(
      (f.store["still:settings"] as { atomic?: unknown }).atomic,
    ).toBeUndefined();
  });
});

describe("real options help and local disclosure memory", () => {
  it.each([false, true])(
    "uses actual help ports and local-only section memory (Firefox=%s)",
    async (firefox) => {
      const f = await installBrowser();
      vi.stubEnv("VITE_SUPABASE_URL", "");
      vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
      vi.stubEnv("FIREFOX", firefox ? "true" : "");
      localStorage.setItem("still-options-open", "instagram");
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      render(OptionsApp);
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Instagram Blocker" })
            .getAttribute("aria-expanded"),
        ).toBe("true"),
      );
      expect(
        screen
          .getByRole("button", { name: "YouTube Blocker" })
          .getAttribute("aria-expanded"),
      ).toBe("false");
      await fireEvent.click(
        screen.getByRole("button", { name: "YouTube Blocker" }),
      );
      expect(localStorage.getItem("still-options-open")).toBe("youtube");
      expect(
        screen
          .getByRole("button", { name: "Instagram Blocker" })
          .getAttribute("aria-expanded"),
      ).toBe("false");
      await fireEvent.click(
        screen.getByRole("button", { name: "Setup guide" }),
      );
      await fireEvent.click(
        screen.getByRole("button", { name: "Privacy policy" }),
      );
      const config = await import("../../../../core/src/ui/config.js");
      expect(open.mock.calls).toEqual([
        // Setup guide reopens the extension's own first-run page, not the website.
        ["chrome-extension://synthetic/first-run.html", "_blank", "noopener,noreferrer"],
        [config.PRIVACY_POLICY_URL, "_blank", "noopener,noreferrer"],
      ]);
      expect(
        f.messages.filter(
          (message) => message.kind === "still:settings-intent",
        ),
      ).toEqual([]);
      expect(
        screen.getByRole("button", { name: "Contact support" }),
      ).toBeTruthy();
    },
  );
});
