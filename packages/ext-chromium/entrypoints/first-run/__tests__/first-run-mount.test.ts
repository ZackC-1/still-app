import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { ChromeStorageAdapter, createSettingsIntentRouter } from "@still/core/storage";
import {
  createExtensionUiController,
  type CommittedPopupBinding,
  type LegacyPopupAuthority,
  type UiAnalytics,
} from "@still/core/ui";
import { createExtensionPurchaseDeps } from "../../../lib/purchase-wiring.js";
import { firstRunAnalytics } from "../first-run-ports.js";
// Only the browser boundary is synthetic; the controller factory, caches and UI are actual.
vi.mock("wxt/browser", () => ({
  get browser() {
    return globalThis.chrome;
  },
}));
import FirstRunApp from "../FirstRunApp.svelte";
import { stillManifest } from "../../../wxt.config.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ACCOUNT = "00000000-0000-4000-8000-0000000000aa";

function installBrowser(store: Record<string, unknown> = {}) {
  const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string | null) =>
          key === null
            ? structuredClone(store)
            : key in store
              ? { [key]: structuredClone(store[key]) }
              : {},
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            const oldValue = store[key];
            store[key] = structuredClone(value);
            for (const l of [...listeners]) l({ [key]: { oldValue, newValue: value } }, "local");
          }
        },
        remove: async () => {},
      },
      onChanged: {
        addListener: (l: (changes: Record<string, unknown>, area: string) => void) => listeners.add(l),
        removeListener: (l: (changes: Record<string, unknown>, area: string) => void) =>
          listeners.delete(l),
      },
    },
    runtime: {
      id: "synthetic",
      getURL: (p = "") => `chrome-extension://synthetic/${p}`,
      // Settings commands reach the actual background intent router, as in the options mount.
      sendMessage: (message: unknown) =>
        new Promise((resolve) => {
          if (!router(message, { id: "synthetic", url: "chrome-extension://synthetic/first-run.html" }, resolve))
            resolve(undefined);
        }),
    },
  });
  const authority = new ChromeStorageAdapter({ authority: true });
  const router = createSettingsIntentRouter(
    (intent) => authority.commitIntent(intent),
    "synthetic",
    "chrome-extension://synthetic/",
    (record) => authority.set(record),
  );
  return authority;
}

function pageAnalytics(enabled: boolean, noticeNeeded: boolean) {
  const page = {
    track: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    sharing: vi.fn(async () => ({ enabled, noticeNeeded })),
    setSharing: vi.fn(async (next: boolean) => next),
    acknowledgeNotice: vi.fn(),
  } satisfies UiAnalytics;
  return page;
}

function session(signedIn: boolean) {
  return createExtensionPurchaseDeps((async (message: { action: string }) => {
    if (message.action === "getState")
      return { userId: signedIn ? ACCOUNT : null, entitled: false, checkoutPending: null, pendingOtp: null };
    if (message.action === "getSyncStatus")
      return signedIn
        ? {
            accountId: ACCOUNT,
            email: "person@fixture.test",
            lastSyncedAt: null,
            pendingUpload: false,
            cloudReachable: true,
            updatedAt: 1,
          }
        : null;
    return undefined;
  }) as never);
}

function permissionsApi(granted: boolean) {
  return {
    contains: vi.fn(async () => granted),
    request: vi.fn(async () => true),
  };
}

const ORIGINS = ["*://*.youtube.com/*", "*://*.instagram.com/*", "*://*.facebook.com/*", "*://*.tiktok.com/*"];

describe("first-run host mount", () => {
  it("Chrome: working once saved choices and site access are read, with the existing usage switch in place of combined consent", async () => {
    installBrowser();
    const page = pageAnalytics(true, true);
    let legacy: LegacyPopupAuthority | undefined;
    const controller = createExtensionUiController(session(false), {
      analytics: firstRunAnalytics(page),
      onLegacyPopupAuthority: (authority) => {
        legacy = authority;
      },
    });
    const onOpenSettings = vi.fn();
    render(FirstRunApp, {
      props: {
        controller,
        browser: "chrome",
        legacy,
        permissions: permissionsApi(true),
        origins: ORIGINS,
        action: { getUserSettings: async () => ({ isOnToolbar: true }) },
        onOpenSettings,
      },
    });
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Still is on."));
    expect(screen.getByText("Still is pinned.")).toBeTruthy();
    // No combined email-and-usage question; the existing one-time notice and switch instead.
    expect(screen.queryByText("Share your email and usage data with Still?")).toBeNull();
    expect(screen.getByText(/Still shares usage data to help improve the app/)).toBeTruthy();
    const sharing = screen.getByRole("switch", { name: "Share usage data" });
    expect(sharing.getAttribute("aria-checked")).toBe("true");
    await fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(page.acknowledgeNotice).toHaveBeenCalledOnce();
    await fireEvent.click(sharing);
    expect(page.setSharing).toHaveBeenCalledWith(false);
    await fireEvent.click(screen.getByRole("button", { name: "Open Still settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    // The page itself records nothing.
    expect(page.track).not.toHaveBeenCalled();
  });

  it("Firefox: sharing starts off and is never switched on by this page", async () => {
    installBrowser();
    const page = pageAnalytics(false, false);
    const controller = createExtensionUiController(undefined, { analytics: firstRunAnalytics(page) });
    render(FirstRunApp, {
      props: { controller, browser: "firefox", permissions: permissionsApi(false), origins: ORIGINS },
    });
    const sharing = await screen.findByRole("switch", { name: "Share usage data" });
    expect(sharing.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/Still shares usage data to help improve the app/)).toBeNull();
    expect(page.setSharing).not.toHaveBeenCalled();
    expect(
      screen.getByText("Click the puzzle piece in the toolbar, then the gear next to Still, then Pin to toolbar."),
    ).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("Firefox for Android: no pin step, the same Allow request, and the sign-in step renumbered", async () => {
    installBrowser();
    const page = pageAnalytics(false, false);
    const controller = createExtensionUiController(undefined, { analytics: firstRunAnalytics(page) });
    const permissions = permissionsApi(false);
    render(FirstRunApp, {
      props: { controller, browser: "firefox", permissions, origins: ORIGINS, toolbar: false },
    });
    const allow = await screen.findByRole("button", { name: "Allow" });
    await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("Pin Still to your toolbar")).toBeNull();
    expect(
      screen.queryByText("Click the puzzle piece in the toolbar, then the gear next to Still, then Pin to toolbar."),
    ).toBeNull();
    expect([...document.querySelectorAll("ol.steps > li.step .num")].map((n) => n.textContent?.trim())).toEqual([
      "1",
      "2",
    ]);
    await fireEvent.click(allow);
    expect(permissions.request).toHaveBeenCalledWith({ origins: ORIGINS });
    expect(page.track).not.toHaveBeenCalled();
  });

  it("modern settings: Still switched off never reads as working", async () => {
    const authority = installBrowser({
      "still:settings": { settings: structuredClone(DEFAULT_SETTINGS), syncMetadata: null },
    });
    await authority.initializeAtomic("never-linked");
    let binding: CommittedPopupBinding | undefined;
    const controller = createExtensionUiController(undefined, {
      onCommittedPopupBinding: (b) => {
        binding = b;
      },
    });
    render(FirstRunApp, {
      props: { controller, browser: "chrome", binding, permissions: permissionsApi(true), origins: ORIGINS },
    });
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Still is on."));
    await binding!.setGlobalOn(false);
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("One step to finish setup."),
    );
  });

  it("uses the existing optional sign-in and shows the reported account", async () => {
    installBrowser({ "still:settings": { settings: structuredClone(DEFAULT_SETTINGS), syncMetadata: null } });
    const controller = createExtensionUiController(session(false), {});
    render(FirstRunApp, {
      props: { controller, browser: "chrome", permissions: permissionsApi(true), origins: ORIGINS },
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(controller.signInOpen).toBe(true);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    cleanup();

    const signedIn = createExtensionUiController(session(true), {});
    render(FirstRunApp, {
      props: { controller: signedIn, browser: "chrome", permissions: permissionsApi(true), origins: ORIGINS },
    });
    expect(await screen.findByText("Signed in as person@fixture.test.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });
});

describe("first-run main (the real entrypoint)", () => {
  // The page main asks the browser for its platform before rendering; nothing else decides it.
  for (const [os, pinShown] of [
    ["android", false],
    ["mac", true],
  ] as const) {
    it(`Firefox build, platform "${os}": the pin step is ${pinShown ? "shown" : "left out"}`, async () => {
      installBrowser();
      const runtime = (globalThis as unknown as { chrome: { runtime: Record<string, unknown> } }).chrome.runtime;
      runtime.getPlatformInfo = vi.fn(async () => ({ os }));
      runtime.getManifest = () => stillManifest("firefox");
      runtime.openOptionsPage = vi.fn();
      (globalThis as unknown as { chrome: Record<string, unknown> }).chrome.permissions = {
        ...permissionsApi(false),
        onAdded: { addListener: () => {}, removeListener: () => {} },
        onRemoved: { addListener: () => {}, removeListener: () => {} },
      };
      vi.stubEnv("FIREFOX", "true");
      document.body.innerHTML = '<div id="app"></div>';
      try {
        // A distinct module id per case, so each one runs the entrypoint afresh.
        const main = os === "android" ? "../main.js?platform-android" : "../main.js?platform-mac";
        await import(main);
        await screen.findByRole("button", { name: "Allow" });
        expect(runtime.getPlatformInfo).toHaveBeenCalled();
        expect(screen.queryByText("Pin Still to your toolbar") !== null).toBe(pinShown);
        expect(document.querySelectorAll("ol.steps > li.step")).toHaveLength(pinShown ? 3 : 2);
      } finally {
        vi.unstubAllEnvs();
        document.body.innerHTML = "";
      }
    });
  }
});
