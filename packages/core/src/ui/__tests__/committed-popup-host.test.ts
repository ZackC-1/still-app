import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import {
  ChromeStorageAdapter,
  createSettingsIntentRouter,
  SettingsStorageRecovery,
  type SettingsIntent,
  type StoredSettingsRecord,
  requireModernSettings,
} from "../../storage/index.js";
import {
  createExtensionUiController,
  type ExtensionPurchaseDeps,
} from "../extension-setup.js";
import type { createDesktopPopupBinding } from "../v3/desktop-popup-binding.js";
import App from "../App.svelte";
import { STRINGS } from "../strings.js";
import type { UiAnalytics } from "../controller.svelte.js";

type Binding = ReturnType<typeof createDesktopPopupBinding>;
type Listener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;
const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("actual desktop presentation on the maintained authority", () => {
  async function desktop(state: ReturnType<typeof capture>) {
    const onSettings = vi.fn();
    const telemetry = vi.fn();
    const view = render(App, {
      controller: state.controller,
      committedPopupBinding: state.binding,
      popupPresentation: {
        browser: "Chrome",
        onSettings,
        loadDesktop: () => import("../v3/DesktopPopup.svelte"),
      },
      onCommittedPopupToggle: telemetry,
      compact: true,
    });
    if (state.binding.current().settings)
      await waitFor(() => expect(global()).toBeTruthy());
    return { ...view, onSettings, telemetry };
  }
  it("keeps actual settings and privacy usable when the host presentation loader rejects", async () => {
    await browser();
    const state = capture();
    await flush();
    const onSettings = vi.fn();
    render(App, {
      controller: state.controller,
      committedPopupBinding: state.binding,
      popupPresentation: {
        browser: "Chrome",
        onSettings,
        loadDesktop: () => Promise.reject(new Error("load failed")),
      },
      compact: true,
    });
    await flush();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    await fireEvent.click(
      screen.getByRole("button", { name: "Settings. Find Still in Chrome." }),
    );
    expect(onSettings).toHaveBeenCalledOnce();
    expect(
      screen.getAllByRole("link", { name: "Privacy policy" }),
    ).toHaveLength(1);
  });

  for (const close of ["opt-out", "unmount"] as const) {
    it(`ignores delayed host presentation completion after ${close}`, async () => {
      await browser();
      const state = capture();
      await flush();
      const delayed = gate();
      const loadDesktop = vi.fn(() =>
        delayed.promise.then(() => import("../v3/DesktopPopup.svelte")),
      );
      const view = render(App, {
        controller: state.controller,
        committedPopupBinding: state.binding,
        popupPresentation: {
          browser: "Chrome",
          onSettings: vi.fn(),
          loadDesktop,
        },
        compact: true,
      });
      await flush();
      expect(loadDesktop).toHaveBeenCalledOnce();
      expect(
        screen.queryByRole("switch", { name: "Still" }),
      ).toBeNull();
      if (close === "unmount") view.unmount();
      else
        await view.rerender({
          controller: state.controller,
          committedPopupBinding: state.binding,
          popupPresentation: undefined,
          compact: true,
        });
      delayed.open();
      await flush();
      await flush();
      expect(
        screen.queryByRole("switch", { name: "Still" }),
      ).toBeNull();
      if (close === "opt-out")
        expect(
          screen.getByRole("switch", { name: "Still on/off" }),
        ).toBeTruthy();
    });
  }

  const global = () => screen.getByRole("switch", { name: "Still" });
  const instagram = () =>
    screen.getByRole("switch", { name: "Still on Instagram" });

  it("holds the requested global choice until its real receipt and reports only that committed toggle", async () => {
    const f = await browser();
    const state = capture();
    await flush();
    const view = await desktop(state);
    const entered = gate(),
      held = gate();
    f.port(async (intent) => {
      entered.open();
      await held.promise;
      return f.authority.commitIntent(intent);
    });
    await fireEvent.click(global());
    await entered.promise;
    try {
      expect(global()).toHaveAttribute("aria-checked", "true");
      expect(view.telemetry).not.toHaveBeenCalled();
      held.open();
      await waitFor(() =>
        expect(global()).toHaveAttribute("aria-checked", "false"),
      );
    } finally {
      held.open();
    }
    await waitFor(() =>
      expect(view.telemetry).toHaveBeenCalledExactlyOnceWith({
        enabled: false,
      }),
    );
    const saved = requireModernSettings((await f.authority.get())!);
    expect(saved.services).toEqual({
      youtube: true,
      instagram: true,
      facebook: true,
      tiktok: true,
    });
    expect(saved.sites["youtube.shorts"]).toBe(true);
  });

  it("saves the free core feature without changing its service or reporting a feature analytics event", async () => {
    const f = await browser();
    const state = capture();
    await flush();
    const view = await desktop(state);
    const legacy = vi.spyOn(state.controller, "toggleService");
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
    expect(
      requireModernSettings((await f.authority.get())!).sites[
        "instagram.reels"
      ],
    ).toBe(true);
    expect(legacy).not.toHaveBeenCalled();
    expect(view.telemetry).not.toHaveBeenCalled();
    await fireEvent.click(
      screen.getByRole("button", { name: "Instagram Blocker" }),
    );
    expect(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it.each(["paused", "previous-account"] as const)(
    "preserves choices under %s and refuses captured commands while settings and privacy stay usable",
    async (kind) => {
      const f = await browser();
      const state = capture();
      await flush();
      const view = await desktop(state);
      await fireEvent.click(
        screen.getByRole("button", { name: "YouTube Blocker" }),
      );
      const before = (await f.authority.get())!;
      await f.external({
        ...before,
        atomic: {
          ...before.atomic!,
          sequence: before.atomic!.sequence + 1,
          paused: kind === "paused" ? "ordering-hold" : "ownership-unconfirmed",
          ownership: kind === "previous-account" ? "previous-account" : "never-linked",
        },
      });
      await flush();
      for (const element of [
        global(),
        instagram(),
        screen.getByRole("switch", { name: "Shorts" }),
      ]) {
        expect(element).toHaveAttribute("aria-disabled", "true");
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      await flush();
      expect(f.sendMessage).not.toHaveBeenCalled();
      expect(view.telemetry).not.toHaveBeenCalled();
      expect(global()).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("switch", { name: "Shorts" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await fireEvent.click(
        screen.getByRole("button", { name: /Settings. Find Still in Chrome/ }),
      );
      expect(view.onSettings).toHaveBeenCalledOnce();
      expect(
        screen.getAllByRole("link", { name: "Privacy policy" }),
      ).toHaveLength(1);
      expect(document.querySelectorAll(".still-ui.app")).toHaveLength(1);
    },
  );

  it("shows accepted nonatomic choices disabled without manufacturing command authority", async () => {
    const f = await browser();
    const before = (await f.authority.get())!;
    await f.external({
      ...before,
      settings: {
        ...before.settings,
        updatedAt: before.settings.updatedAt + 1,
      },
      atomic: undefined,
    });
    const state = capture();
    await flush();
    await desktop(state);
    expect(state.binding.current().reason).toBe("atomic-command-unavailable");
    expect(global()).toHaveAttribute("aria-checked", "true");
    expect(global()).toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(global());
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps a missing record unchanged without fake switches or storage Checking sync and preserves usage/OTP/actions", async () => {
    const f = await browser();
    const legacy = {
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        globalOn: false,
        updatedAt: 999,
      },
      syncMetadata: null,
    };
    await f.external(legacy);
    const p = purchase(),
      setSharing = vi.fn(async (enabled: boolean) => enabled);
    const analytics: UiAnalytics = {
      track() {},
      identify() {},
      reset() {},
      sharing: async () => ({ enabled: true, noticeNeeded: true }),
      setSharing,
      acknowledgeNotice() {},
    };
    const state = capture({ purchase: p.deps, analytics });
    await flush();
    const view = await desktop(state);
    expect(screen.queryByRole("switch", { name: "Still" })).toBeNull();
    expect(screen.queryByText(STRINGS.sync.checking)).toBeNull();
    expect(document.querySelector(".hero")).toBeNull();
    expect(
      screen.getAllByRole("link", { name: "Privacy policy" }),
    ).toHaveLength(1);
    await fireEvent.click(
      screen.getByRole("button", { name: /Settings. Find Still in Chrome/ }),
    );
    expect(view.onSettings).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.usage.noticeTurnOff }),
    );
    await flush();
    expect(setSharing).toHaveBeenCalledWith(false);
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.auth.signInCta }),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await fireEvent.input(screen.getByLabelText(STRINGS.auth.emailLabel), {
      target: { value: "synthetic@example.com" },
    });
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.codeAuth.send }),
    );
    await flush();
    expect(p.auth.requestCode).toHaveBeenCalledWith("synthetic@example.com");
    await fireEvent.click(
      within(screen.getByRole("dialog")).getByText(STRINGS.auth.cancel),
    );
    await flush();
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.auth.signInCta }),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(await f.authority.get()).toEqual(legacy);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("uses actual identity with no email and keeps retry/delete/time in one sync card without granting success", async () => {
    await browser();
    const p = purchase();
    const state = capture({ purchase: p.deps });
    await flush();
    state.controller.userId = "synthetic-account";
    state.controller.accountEmail = null;
    await desktop(state);
    expect(screen.queryByRole("button", { name: /Sign in/ })).toBeNull();
    expect(screen.getByText(STRINGS.sync.checking)).toBeTruthy();
    expect(screen.queryByText(STRINGS.sync.synced)).toBeNull();
    state.controller.pendingUpload = true;
    await tick();
    expect(screen.getByText(STRINGS.sync.syncing)).toBeTruthy();
    state.controller.pendingUpload = false;
    state.controller.cloudReachable = false;
    await tick();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(p.retrySync).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.account.delete }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.account.deleteCancel }),
    );
    expect(p.auth.deleteAccount).not.toHaveBeenCalled();
    const held = gate();
    p.auth.deleteAccount.mockImplementationOnce(async () => {
      await held.promise;
      throw new Error("Synthetic deletion failure");
    });
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.account.delete }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.account.deleteConfirm }),
    );
    try {
      expect(
        screen.getByRole("button", { name: STRINGS.account.deleting }),
      ).toBeDisabled();
      held.open();
      await flush();
    } finally {
      held.open();
    }
    expect(state.controller.deleteFlow).toBe("error");
    expect(
      screen.getByRole("button", { name: STRINGS.account.delete }),
    ).toBeTruthy();
    state.controller.cloudReachable = true;
    state.controller.lastSyncedAt = 1000;
    await tick();
    expect(screen.getByText(STRINGS.sync.synced)).toBeTruthy();
    expect(document.querySelectorAll("time")).toHaveLength(1);
    expect(
      screen.getAllByRole("link", { name: "Privacy policy" }),
    ).toHaveLength(1);
    expect(
      document
        .querySelector(".account")
        ?.closest(".card")
        ?.querySelector(".sync-row-title")?.textContent,
    ).toBe("Settings sync");
  });

  it("never reports no-op/refused writes or another actor's matching state as a successful local toggle", async () => {
    const f = await browser();
    const state = capture();
    await flush();
    const view = await desktop(state);
    f.port(async (intent) => {
      await f.authority.commitIntent(intent);
      return f.authority.commitIntent(intent);
    });
    await fireEvent.click(instagram());
    await waitFor(() =>
      expect(instagram()).toHaveAttribute("aria-checked", "false"),
    );
    expect(view.telemetry).not.toHaveBeenCalled();
    f.port(async () => {
      await f.authority.commitIntent({
        path: "globalOn",
        value: false,
        updatedAt: 101,
      });
      return { ...(await f.authority.get())!, intentCommitted: false };
    });
    await fireEvent.click(global());
    await waitFor(() =>
      expect(global()).toHaveAttribute("aria-checked", "false"),
    );
    expect(view.telemetry).not.toHaveBeenCalled();
  });

  it("stops replaced and unmounted bindings without publishing or admitting new commands", async () => {
    await browser();
    const first = capture(),
      second = capture();
    await flush();
    const view = await desktop(first);
    const firstStop = vi.spyOn(first.binding, "stop"),
      secondStop = vi.spyOn(second.binding, "stop");
    await view.rerender({
      controller: second.controller,
      committedPopupBinding: second.binding,
      compact: true,
      popupPresentation: {
        browser: "Firefox",
        onSettings: view.onSettings,
        loadDesktop: () => import("../v3/DesktopPopup.svelte"),
      },
    });
    expect(firstStop).toHaveBeenCalledOnce();
    expect(await first.binding.setFeature("youtube.shorts", false)).toEqual({
      status: "unavailable",
      reason: "stopped",
    });
    view.unmount();
    expect(secondStop).toHaveBeenCalledOnce();
    expect(await second.binding.setGlobalOn(false)).toEqual({
      status: "unavailable",
      reason: "stopped",
    });
  });
});
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
};
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Only the browser boundary is synthetic. Storage, authority serialization, router and binding are real. */
async function browser() {
  const store: Record<string, unknown> = {
    "still:settings": {
      settings: structuredClone(DEFAULT_SETTINGS),
      syncMetadata: null,
    },
  };
  const listeners = new Set<Listener>();
  const set = vi.fn(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) {
      const oldValue = store[key];
      store[key] = structuredClone(value);
      for (const listener of [...listeners])
        listener(
          { [key]: { oldValue, newValue: structuredClone(value) } },
          "local",
        );
    }
  });
  const origin = "chrome-extension://synthetic/";
  const sendMessage = vi.fn(
    (message: unknown) =>
      new Promise((resolve) => {
        router(
          message,
          { id: "synthetic", url: origin + "popup.html" },
          resolve,
        );
      }),
  );
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) =>
          key in store ? { [key]: structuredClone(store[key]) } : {},
        set,
      },
      onChanged: {
        addListener: (l: Listener) => listeners.add(l),
        removeListener: (l: Listener) => listeners.delete(l),
      },
    },
    runtime: { id: "synthetic", getURL: () => origin, sendMessage },
  });
  const authority = new ChromeStorageAdapter({ authority: true });
  let commit = (intent: SettingsIntent) => authority.commitIntent(intent);
  const router = createSettingsIntentRouter(
    (intent) => commit(intent),
    "synthetic",
    origin,
  );
  await authority.initializeAtomic("never-linked");
  set.mockClear();
  return {
    authority,
    store,
    set,
    sendMessage,
    port(next: typeof commit) {
      commit = next;
    },
    async external(record: StoredSettingsRecord) {
      await set({ "still:settings": record });
    },
  };
}
function capture(
  options: {
    purchase?: ExtensionPurchaseDeps;
    analytics?: UiAnalytics;
    onLocalSettingsCommit?: (record: StoredSettingsRecord) => void;
  } = {},
) {
  let binding!: Binding;
  const controller = createExtensionUiController(options.purchase, {
    analytics: options.analytics,
    onLocalSettingsCommit: options.onLocalSettingsCommit,
    onCommittedPopupBinding(value) {
      binding = value;
      stops.push(value.stop);
    },
  });
  return { controller, binding };
}
function globalSwitch() {
  return screen.getByRole("switch", {
    name: "Still on/off",
  }) as HTMLButtonElement;
}
function serviceSwitch(id: string) {
  return within(
    document.querySelector(`[data-service="${id}"]`) as HTMLElement,
  ).getByRole("switch") as HTMLButtonElement;
}
function mount(state: ReturnType<typeof capture>) {
  return render(App, {
    controller: state.controller,
    compact: true,
    committedPopupBinding: state.binding,
  });
}
function purchase() {
  const auth = {
    requestCode: vi.fn(async () => ({ kind: "sent" as const })),
    verifyCode: vi.fn(async () => ({
      kind: "verified" as const,
      userId: "synthetic-account",
    })),
    signOut: vi.fn(async () => {}),
    deleteAccount: vi.fn(async () => {}),
  };
  const persistence = { setPendingOtp: vi.fn(), setPurchaseIntent: vi.fn() };
  const retrySync = vi.fn(async () => {});
  const deps: ExtensionPurchaseDeps = {
    auth,
    persistence,
    retrySync,
    displayPrice: "$1.99",
    getState: async () => ({
      userId: null,
      entitled: false,
      pendingOtp: null,
      checkoutPending: null,
    }),
    checkout: {
      createCheckout: async () => ({ kind: "unavailable" }),
      openCheckoutTab: async () => undefined,
      setPending: () => {},
      reconcile: async () => "unknown",
    },
  };
  return { deps, auth, persistence, retrySync };
}

describe("maintained App committed popup host", () => {
  it("shows no fabricated switches before modern hydration, then mounts account-free saved controls", async () => {
    const f = await browser();
    const state = capture();
    mount(state);
    expect(screen.queryByRole("switch", { name: "Still on/off" })).toBeNull();
    expect(document.querySelectorAll("[data-service]")).toHaveLength(0);
    expect(screen.getAllByText(STRINGS.sync.checking).length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getByRole("link", { name: STRINGS.account.privacyPolicy }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(globalSwitch().getAttribute("aria-checked")).toBe("true"),
    );
    expect(state.controller.userId).toBeNull();
    expect(globalSwitch().disabled).toBe(false);
    expect(f.set).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("waits for the actual global receipt and keeps service choices when global is Off", async () => {
    const f = await browser();
    const commits = vi.fn();
    const state = capture({ onLocalSettingsCommit: commits });
    await flush();
    mount(state);
    expect(
      screen.queryByRole("switch", { name: "Still on/off" }),
    ).not.toBeNull();
    const reached = gate(),
      held = gate();
    f.port(async (intent) => {
      reached.open();
      await held.promise;
      return f.authority.commitIntent(intent);
    });
    await fireEvent.click(globalSwitch());
    await reached.promise;
    try {
      expect(globalSwitch().getAttribute("aria-checked")).toBe("true");
      held.open();
      await waitFor(() =>
        expect(globalSwitch().getAttribute("aria-checked")).toBe("false"),
      );
    } finally {
      held.open();
    }
    const saved = (await f.authority.get())!;
    expect(saved.settings.globalOn).toBe(false);
    expect(saved.settings.services.youtube).toBe(true);
    expect(commits).toHaveBeenCalledOnce();
    expect(serviceSwitch("youtube").disabled).toBe(true);
  });

  it("commits a free service through the real writer while preserving other choices and optional unsupported access", async () => {
    const f = await browser();
    const state = capture();
    await flush();
    mount(state);
    const before = (await f.authority.get())!;
    await fireEvent.click(serviceSwitch("instagram"));
    await waitFor(() =>
      expect(serviceSwitch("instagram").getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
    const after = (await f.authority.get())!;
    expect(after.atomic!.sequence).toBe(before.atomic!.sequence + 1);
    expect(after.settings.services.instagram).toBe(false);
    expect(after.settings.services.facebook).toBe(true);
    await chrome.storage.local.set({
      "still:entitlement": { entitled: true, updatedAt: Date.now() },
    });
    await flush();
    expect(state.binding.current().access.states["youtube.comments"]).toBe(
      "unsupported",
    );
    expect(document.querySelectorAll(".card.locked")).toHaveLength(0);
    expect(screen.queryByText(STRINGS.paywall.upgradeCta)).toBeNull();
  });

  it.each(["paused", "previous-account"] as const)(
    "keeps saved choices but disables real controls under %s authority, then recovers",
    async (kind) => {
      const f = await browser();
      const state = capture();
      await flush();
      mount(state);
      const saved = (await f.authority.get())!;
      await f.external({
        ...saved,
        atomic: {
          ...saved.atomic!,
          sequence: saved.atomic!.sequence + 1,
          paused: kind === "paused" ? "ordering-hold" : "ownership-unconfirmed",
          ownership: kind === "previous-account" ? "previous-account" : "never-linked",
        },
      });
      await flush();
      expect(globalSwitch().getAttribute("aria-checked")).toBe("true");
      expect(globalSwitch().disabled).toBe(true);
      expect(serviceSwitch("instagram").disabled).toBe(true);
      const before = await f.authority.get();
      const calls = f.sendMessage.mock.calls.length;
      globalSwitch().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
      expect(f.sendMessage).toHaveBeenCalledTimes(calls);
      expect(await f.authority.get()).toEqual(before);
      expect(
        screen.queryByText(/ordering-hold|ownership-unconfirmed/),
      ).toBeNull();
      await f.external({
        ...saved,
        atomic: { ...saved.atomic!, sequence: saved.atomic!.sequence + 2 },
      });
      await flush();
      expect(globalSwitch().disabled).toBe(false);
      await fireEvent.click(globalSwitch());
      await waitFor(() =>
        expect(globalSwitch().getAttribute("aria-checked")).toBe("false"),
      );
    },
  );

  it("does not show false success or optimistic choices after real authority refusal", async () => {
    const f = await browser();
    const commits = vi.fn();
    const state = capture({ onLocalSettingsCommit: commits });
    await flush();
    mount(state);
    const saved = await f.authority.get();
    f.port(async () => {
      throw new SettingsStorageRecovery("authority-unavailable");
    });
    await fireEvent.click(globalSwitch());
    await flush();
    expect(globalSwitch().getAttribute("aria-checked")).toBe("true");
    expect(await f.authority.get()).toEqual(saved);
    expect(commits).not.toHaveBeenCalled();
    expect(screen.queryByText(/saved successfully|changes saved/i)).toBeNull();
  });

  it("observes another actor's matching value without claiming the refused local request committed", async () => {
    const f = await browser();
    const commits = vi.fn();
    const state = capture({ onLocalSettingsCommit: commits });
    await flush();
    mount(state);
    const reached = gate(),
      held = gate();
    f.port(async () => {
      reached.open();
      await held.promise;
      return { ...(await f.authority.get())!, intentCommitted: false };
    });
    await fireEvent.click(globalSwitch());
    await reached.promise;
    try {
      await f.authority.commitIntent({
        path: "globalOn",
        value: false,
        updatedAt: 101,
      });
      held.open();
      await waitFor(() =>
        expect(globalSwitch().getAttribute("aria-checked")).toBe("false"),
      );
      await flush();
    } finally {
      held.open();
    }
    expect(commits).not.toHaveBeenCalled();
    expect(screen.queryByText(/saved successfully|changes saved/i)).toBeNull();
  });

  it("does not fabricate modern settings or silently migrate a legacy-only saved record", async () => {
    const f = await browser();
    const legacy = {
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        globalOn: false,
        updatedAt: 999,
      },
      syncMetadata: null,
    };
    await f.external(legacy);
    f.set.mockClear();
    const state = capture();
    await flush();
    mount(state);
    expect(state.binding.current().settings).toBeNull();
    expect(screen.queryByRole("switch", { name: "Still on/off" })).toBeNull();
    expect(document.querySelectorAll("[data-service]")).toHaveLength(0);
    expect(await f.authority.get()).toEqual(legacy);
    expect(f.set).not.toHaveBeenCalled();
  });

  it("preserves accepted nonatomic choices but holds all blocking commands", async () => {
    const f = await browser();
    const saved = (await f.authority.get())!;
    await f.external({
      ...saved,
      settings: { ...saved.settings, updatedAt: 101 },
      atomic: undefined,
    });
    f.set.mockClear();
    const state = capture();
    await flush();
    mount(state);
    expect(state.binding.current().reason).toBe("atomic-command-unavailable");
    expect(globalSwitch().getAttribute("aria-checked")).toBe("true");
    expect(globalSwitch().disabled).toBe(true);
    expect(f.set).not.toHaveBeenCalled();
  });

  it("retains privacy and actual usage off controls while modern blocking is held", async () => {
    await browser();
    const setSharing = vi.fn(async (enabled: boolean) => enabled);
    const analytics: UiAnalytics = {
      track: () => {},
      identify: () => {},
      reset: () => {},
      sharing: async () => ({ enabled: true, noticeNeeded: true }),
      setSharing,
      acknowledgeNotice: () => {},
    };
    const state = capture({ analytics });
    state.binding.stop();
    mount(state);
    await flush();
    expect(
      screen.getByRole("link", { name: STRINGS.account.privacyPolicy }),
    ).toBeTruthy();
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.usage.noticeTurnOff }),
    );
    await flush();
    expect(setSharing).toHaveBeenCalledWith(false);
    expect(state.controller.usageSharing).toBe(false);
  });

  it("retains actual optional OTP sign-in, deliberate dismiss and reopen while commands are held", async () => {
    await browser();
    const p = purchase();
    const state = capture({ purchase: p.deps });
    await flush();
    state.binding.stop();
    mount(state);
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.auth.signInCta }),
    );
    await fireEvent.input(screen.getByLabelText(STRINGS.auth.emailLabel), {
      target: { value: "synthetic@example.com" },
    });
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.codeAuth.send }),
    );
    await flush();
    expect(p.auth.requestCode).toHaveBeenCalledWith("synthetic@example.com");
    expect(screen.getByLabelText(STRINGS.codeAuth.codeLabel)).toBeTruthy();
    await fireEvent.click(
      within(screen.getByRole("dialog")).getByText(STRINGS.auth.cancel),
    );
    await flush();
    expect(state.controller.signInOpen).toBe(false);
    expect(p.persistence.setPendingOtp).toHaveBeenCalledWith(null);
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.auth.signInCta }),
    );
    expect(screen.getByLabelText(STRINGS.auth.emailLabel)).toBeTruthy();
    state.controller.dismissSignIn();
  });

  it("keeps checking, pending, retry and account deletion routes on the same actual controller", async () => {
    await browser();
    const p = purchase();
    const state = capture({ purchase: p.deps });
    await flush();
    state.binding.stop();
    state.controller.userId = "synthetic-account";
    state.controller.accountEmail = "synthetic@example.com";
    mount(state);
    expect(screen.getAllByText(STRINGS.sync.checking).length).toBeGreaterThan(
      0,
    );
    state.controller.pendingUpload = true;
    await tick();
    expect(screen.getByText(STRINGS.sync.syncing)).toBeTruthy();
    state.controller.pendingUpload = false;
    state.controller.cloudReachable = false;
    await tick();
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.sync.retry }),
    );
    expect(p.retrySync).toHaveBeenCalledOnce();
    state.controller.cloudReachable = true;
    await tick();
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.account.delete }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.account.deleteCancel }),
    );
    expect(p.auth.deleteAccount).not.toHaveBeenCalled();
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.account.delete }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.account.deleteConfirm }),
    );
    await flush();
    expect(p.auth.deleteAccount).toHaveBeenCalledOnce();
    expect(state.controller.userId).toBeNull();
  });

  it("stops the replaced binding, observes only the new instance and stops it on unmount", async () => {
    const f = await browser();
    const first = capture();
    const second = capture();
    await flush();
    const view = mount(first);
    const stopFirst = vi.spyOn(first.binding, "stop");
    const stopSecond = vi.spyOn(second.binding, "stop");
    await view.rerender({
      controller: second.controller,
      compact: true,
      committedPopupBinding: second.binding,
    });
    expect(stopFirst).toHaveBeenCalledOnce();
    expect(stopSecond).not.toHaveBeenCalled();
    expect(await first.binding.setGlobalOn(false)).toEqual({
      status: "unavailable",
      reason: "stopped",
    });
    await f.authority.commitIntent({
      path: "globalOn",
      value: false,
      updatedAt: 101,
    });
    await flush();
    expect(globalSwitch().getAttribute("aria-checked")).toBe("false");
    view.unmount();
    expect(stopSecond).toHaveBeenCalledOnce();
    expect(await second.binding.setGlobalOn(true)).toEqual({
      status: "unavailable",
      reason: "stopped",
    });
  });

  it("does not report a real no-op receipt when another actor already committed the requested value", async () => {
    const f = await browser();
    const state = capture();
    await flush();
    const observer = vi.fn();
    render(App, {
      controller: state.controller,
      compact: true,
      committedPopupBinding: state.binding,
      onCommittedPopupToggle: observer,
    });
    f.port(async (intent) => {
      await f.authority.commitIntent(intent);
      return f.authority.commitIntent(intent);
    });
    await fireEvent.click(globalSwitch());
    await waitFor(() =>
      expect(globalSwitch().getAttribute("aria-checked")).toBe("false"),
    );
    await flush();
    expect(observer).not.toHaveBeenCalled();
    expect((await f.authority.get())!.settings.globalOn).toBe(false);
  });

  it("reports only committed requested toggles, never refused or external edits, and telemetry failures leave saved state intact", async () => {
    const f = await browser();
    const state = capture();
    await flush();
    const observer = vi.fn(() => {
      throw new Error("Synthetic telemetry refusal");
    });
    render(App, {
      controller: state.controller,
      compact: true,
      committedPopupBinding: state.binding,
      onCommittedPopupToggle: observer,
    });
    await fireEvent.click(serviceSwitch("instagram"));
    await waitFor(() =>
      expect(observer).toHaveBeenCalledWith({
        service: "instagram",
        enabled: false,
      }),
    );
    expect((await f.authority.get())!.settings.services.instagram).toBe(false);
    await f.authority.commitIntent({
      path: "services.facebook",
      value: false,
      updatedAt: 101,
    });
    await flush();
    expect(observer).toHaveBeenCalledOnce();
    f.port(async () => ({
      ...(await f.authority.get())!,
      intentCommitted: false,
    }));
    await fireEvent.click(globalSwitch());
    await flush();
    expect(observer).toHaveBeenCalledOnce();
    expect(globalSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("unmount stops observations and new commands without cancelling an admitted durable write", async () => {
    const f = await browser();
    const state = capture();
    await flush();
    const view = mount(state);
    const reached = gate(),
      held = gate();
    f.port(async (intent) => {
      reached.open();
      await held.promise;
      return f.authority.commitIntent(intent);
    });
    await fireEvent.click(globalSwitch());
    await reached.promise;
    view.unmount();
    try {
      expect(await state.binding.setGlobalOn(false)).toEqual({
        status: "unavailable",
        reason: "stopped",
      });
      held.open();
      await waitFor(async () =>
        expect((await f.authority.get())!.settings.globalOn).toBe(false),
      );
    } finally {
      held.open();
    }
    expect(state.controller.settings.globalOn).toBe(false);
    expect(document.querySelector(".hero")).toBeNull();
  });
});


describe("current-authority recovery in the same mounted host", () => {
  async function readyHost(route = "desktop-global") {
    const f = await browser();
    await f.authority.commitIntent({
      path: "services.instagram",
      value: false,
      updatedAt: 101,
    });
    await f.authority.commitIntent({
      path: "sites.youtube.shorts",
      value: false,
      updatedAt: 102,
    });
    const state = capture();
    await flush();
    const telemetry = vi.fn(),
      onSettings = vi.fn();
    const desktop = route.startsWith("desktop");
    const props = {
      controller: state.controller,
      committedPopupBinding: state.binding,
      compact: true,
      onCommittedPopupToggle: telemetry,
      popupPresentation: desktop
        ? {
            browser: "Chrome" as const,
            onSettings,
            loadDesktop: () => import("../v3/DesktopPopup.svelte"),
          }
        : undefined,
    };
    const view = render(App, props);
    const global = () =>
      desktop ? screen.getByRole("switch", { name: "Still" }) : globalSwitch();
    await waitFor(() => expect(global()).toBeTruthy());
    await flush();
    if (route === "desktop-feature")
      await fireEvent.click(
        screen.getByRole("button", { name: "YouTube Blocker" }),
      );
    const control = () =>
      route.endsWith("feature")
        ? screen.getByRole("switch", { name: "Shorts" })
        : route.endsWith("service")
          ? desktop
            ? screen.getByRole("switch", { name: "Still on Instagram" })
            : serviceSwitch("instagram")
          : global();
    const saved = (await f.authority.get())!;
    const get = vi.spyOn(chrome.storage.local, "get");
    const reread = vi.spyOn(state.binding, "rereadAuthority");
    get.mockClear();
    f.set.mockClear();
    f.sendMessage.mockClear();
    return {
      f,
      state,
      view,
      props,
      telemetry,
      onSettings,
      get,
      reread,
      control,
      saved,
    };
  }

  it.each([
    "desktop-global",
    "desktop-service",
    "desktop-feature",
    "legacy-global",
    "legacy-service",
  ])(
    "%s recovers one failed durable write with one read, no replay, then commits only the next deliberate click",
    async (route) => {
      const h = await readyHost(route);
      h.f.set.mockRejectedValueOnce(new Error("Synthetic local.set refusal"));
      await fireEvent.click(h.control());
      await waitFor(() => expect(h.reread).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(h.state.binding.current().commandAvailability).toBe("ready"),
      );
      expect(h.f.set).toHaveBeenCalledOnce();
      expect(h.f.sendMessage).toHaveBeenCalledOnce();
      expect(h.get).toHaveBeenCalledTimes(2); // writer's admission read plus the single recovery read
      expect(h.telemetry).not.toHaveBeenCalled();
      expect(await h.f.authority.get()).toEqual(h.saved);
      expect(h.control()).toHaveAttribute(
        "aria-checked",
        route.endsWith("global") ? "true" : "false",
      );
      await fireEvent.click(h.control());
      await waitFor(() =>
        expect(h.control()).toHaveAttribute(
          "aria-checked",
          route.endsWith("global") ? "false" : "true",
        ),
      );
      expect(h.reread).toHaveBeenCalledOnce();
      expect(h.f.set).toHaveBeenCalledTimes(2);
      expect(h.f.sendMessage).toHaveBeenCalledTimes(2);
      const saved = requireModernSettings((await h.f.authority.get())!);
      expect(saved.globalOn).toBe(!route.endsWith("global"));
      expect(saved.services.instagram).toBe(route.endsWith("service"));
      expect(saved.sites["youtube.shorts"]).toBe(route.endsWith("feature"));
      expect(saved.services.facebook).toBe(true);
      if (route.endsWith("feature")) expect(h.telemetry).not.toHaveBeenCalled();
      else
        await waitFor(() =>
          expect(h.telemetry).toHaveBeenCalledExactlyOnceWith(
            route.endsWith("global")
              ? { enabled: false }
              : { service: "instagram", enabled: true },
          ),
        );
    },
  );

  it.each(["read-failure", "previous-account"] as const)(
    "keeps %s held after the one read without replay or false commit",
    async (reason) => {
      const h = await readyHost();
      const get = h.get.getMockImplementation()!;
      if (reason === "read-failure")
        h.get
          .mockImplementationOnce(get)
          .mockRejectedValueOnce(new Error("Synthetic read refusal"));
      h.f.set.mockImplementationOnce(async () => {
        if (reason === "previous-account")
          h.f.store["still:settings"] = {
            ...h.saved,
            atomic: {
              ...h.saved.atomic!,
              ownership: "previous-account",
              paused: "ownership-unconfirmed",
              scope: { ...h.saved.atomic!.scope, generation: h.saved.atomic!.scope.generation + 1 },
              sequence: h.saved.atomic!.sequence + 1,
            },
          };
        throw new Error("Synthetic write refusal without notification");
      });
      await fireEvent.click(h.control());
      await waitFor(() => expect(h.reread).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(h.state.binding.current().reason).toBe(
          reason === "previous-account" ? "ownership-unconfirmed" : "read-failed",
        ),
      );
      expect(h.state.binding.current().commandAvailability).toBe("unavailable");
      expect(h.control()).toHaveAttribute("aria-disabled", "true");
      expect(h.control()).toHaveAttribute("aria-checked", "true");
      expect(h.f.set).toHaveBeenCalledOnce();
      expect(h.f.sendMessage).toHaveBeenCalledOnce();
      expect(h.telemetry).not.toHaveBeenCalled();
      h.control().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
      expect(h.reread).toHaveBeenCalledOnce();
      expect(h.f.sendMessage).toHaveBeenCalledOnce();
    },
  );

  it("keeps a newer durable hold when an admitted recovery read returns an older healthy snapshot", async () => {
    const h = await readyHost();
    const get = h.get.getMockImplementation()!;
    const entered = gate(),
      held = gate();
    h.get.mockImplementationOnce(get).mockImplementationOnce(async () => {
      entered.open();
      await held.promise;
      return { "still:settings": h.saved };
    });
    h.f.set.mockRejectedValueOnce(new Error("Synthetic write refusal"));
    await fireEvent.click(h.control());
    await entered.promise;
    try {
      const newer = {
        ...h.saved,
        atomic: {
          ...h.saved.atomic!,
          sequence: h.saved.atomic!.sequence + 1,
          paused: "ordering-hold",
        },
      };
      await h.f.external(newer);
      held.open();
      await flush();
      await flush();
      expect(h.state.binding.current().reason).toBe("ordering-hold");
      expect(h.state.binding.current().commandAvailability).toBe("unavailable");
      expect(h.reread).toHaveBeenCalledOnce();
      expect(h.control()).toHaveAttribute("aria-checked", "true");
      expect(h.telemetry).not.toHaveBeenCalled();
      expect(await h.f.authority.get()).toEqual(newer);
    } finally {
      held.open();
    }
  });

  it.each(["unmount", "replacement"] as const)(
    "fences a previously admitted read after %s without replaying its failed intent",
    async (close) => {
      const h = await readyHost();
      const get = h.get.getMockImplementation()!;
      const entered = gate(),
        held = gate();
      h.get.mockImplementationOnce(get).mockImplementationOnce(async () => {
        entered.open();
        await held.promise;
        return { "still:settings": h.saved };
      });
      h.f.set.mockRejectedValueOnce(new Error("Synthetic write refusal"));
      await fireEvent.click(h.control());
      await entered.promise;
      try {
        const stopped = h.state.binding.current();
        if (close === "unmount") h.view.unmount();
        else {
          const replacement = capture();
          await flush();
          const otherRead = vi.spyOn(replacement.binding, "rereadAuthority");
          await h.view.rerender({
            ...h.props,
            controller: replacement.controller,
            committedPopupBinding: replacement.binding,
          });
          await fireEvent.click(h.control());
          await waitFor(() =>
            expect(h.control()).toHaveAttribute("aria-checked", "false"),
          );
          expect(otherRead).not.toHaveBeenCalled();
        }
        held.open();
        await flush();
        await flush();
        expect(h.state.binding.current()).toEqual({
          ...stopped,
          commandAvailability: "unavailable",
          reason: "stopped",
        });
        expect(h.reread).toHaveBeenCalledOnce();
        if (close === "unmount") {
          expect(h.f.set).toHaveBeenCalledOnce();
          expect(h.telemetry).not.toHaveBeenCalled();
          expect(await h.f.authority.get()).toEqual(h.saved);
        } else {
          expect(h.f.set).toHaveBeenCalledTimes(2);
          expect(h.control()).toHaveAttribute("aria-checked", "false");
          expect(h.telemetry).toHaveBeenCalledExactlyOnceWith({
            enabled: false,
          });
        }
      } finally {
        held.open();
      }
    },
  );

  it.each(["unmount", "replacement"] as const)(
    "does not recover a late rejected command after %s",
    async (close) => {
      const h = await readyHost();
      const entered = gate(),
        held = gate();
      vi.spyOn(h.state.binding, "setGlobalOn").mockImplementationOnce(
        async () => {
          entered.open();
          await held.promise;
          throw new Error("Synthetic late command rejection");
        },
      );
      await fireEvent.click(h.control());
      await entered.promise;
      try {
        if (close === "unmount") h.view.unmount();
        else {
          const replacement = capture();
          await flush();
          await h.view.rerender({
            ...h.props,
            controller: replacement.controller,
            committedPopupBinding: replacement.binding,
          });
        }
        held.open();
        await flush();
        await flush();
        expect(h.reread).not.toHaveBeenCalled();
        expect(h.telemetry).not.toHaveBeenCalled();
        expect(h.f.set).not.toHaveBeenCalled();
        expect(await h.f.authority.get()).toEqual(h.saved);
      } finally {
        held.open();
      }
    },
  );

  it("does not recover an older failed command after a newer deliberate command", async () => {
    const h = await readyHost();
    const entered = gate(),
      held = gate();
    vi.spyOn(h.state.binding, "setGlobalOn").mockImplementationOnce(
      async () => {
        entered.open();
        await held.promise;
        return { status: "unavailable", reason: "authority-unavailable" };
      },
    );
    await fireEvent.click(h.control());
    await entered.promise;
    try {
      await fireEvent.click(
        screen.getByRole("switch", { name: "Still on Instagram" }),
      );
      await waitFor(() =>
        expect(h.telemetry).toHaveBeenCalledExactlyOnceWith({
          service: "instagram",
          enabled: true,
        }),
      );
      held.open();
      await flush();
      await flush();
      expect(h.reread).not.toHaveBeenCalled();
      expect(h.telemetry).toHaveBeenCalledOnce();
      expect(requireModernSettings((await h.f.authority.get())!)).toMatchObject(
        { globalOn: true, services: { instagram: true } },
      );
    } finally {
      held.open();
    }
  });

  it("reports each real overlapping commit once while the same view remains current", async () => {
    const h = await readyHost();
    const entered = gate(),
      held = gate();
    h.f.port(async (intent) => {
      if (intent.path === "globalOn") {
        entered.open();
        await held.promise;
      }
      return h.f.authority.commitIntent(intent);
    });
    await fireEvent.click(h.control());
    await entered.promise;
    try {
      await fireEvent.click(
        screen.getByRole("switch", { name: "Still on Instagram" }),
      );
      await waitFor(() =>
        expect(h.telemetry).toHaveBeenCalledExactlyOnceWith({
          service: "instagram",
          enabled: true,
        }),
      );
      held.open();
      await waitFor(() => expect(h.telemetry).toHaveBeenCalledTimes(2));
      expect(h.telemetry.mock.calls).toEqual([
        [{ service: "instagram", enabled: true }],
        [{ enabled: false }],
      ]);
      expect(h.reread).not.toHaveBeenCalled();
      expect(requireModernSettings((await h.f.authority.get())!)).toMatchObject(
        { globalOn: false, services: { instagram: true } },
      );
    } finally {
      held.open();
    }
  });

  it("recovers a current rejected command promise once without manufacturing a commit", async () => {
    const h = await readyHost();
    vi.spyOn(h.state.binding, "setGlobalOn").mockRejectedValueOnce(
      new Error("Synthetic boundary rejection"),
    );
    await fireEvent.click(h.control());
    await waitFor(() => expect(h.reread).toHaveBeenCalledOnce());
    expect(h.f.set).not.toHaveBeenCalled();
    expect(h.f.sendMessage).not.toHaveBeenCalled();
    expect(h.telemetry).not.toHaveBeenCalled();
    expect(h.get).toHaveBeenCalledOnce();
    expect(h.control()).toHaveAttribute("aria-checked", "true");
  });

  it("does not reread or replay healthy no-op or invalid/inactive outcomes", async () => {
    const h = await readyHost();
    h.f.port(async () => ({ ...h.saved, intentCommitted: false }));
    await fireEvent.click(h.control());
    await flush();
    expect(h.reread).not.toHaveBeenCalled();
    expect(h.telemetry).not.toHaveBeenCalled();
    vi.spyOn(h.state.binding, "setGlobalOn").mockResolvedValueOnce({
      status: "rejected",
      reason: "invalid-input",
    });
    await fireEvent.click(h.control());
    await flush();
    expect(h.reread).not.toHaveBeenCalled();
    expect(h.telemetry).not.toHaveBeenCalled();
    expect(h.f.set).not.toHaveBeenCalled();
    expect(h.f.sendMessage).toHaveBeenCalledOnce();
  });
});

describe("mounted sync retry lifecycle", () => {
  const account = (accountId: string, cloudReachable: boolean) => ({
    accountId,
    email: `${accountId}@example.com`,
    lastSyncedAt: 1000,
    pendingUpload: false,
    cloudReachable,
    updatedAt: 1100,
  });

  async function observedAccount(
    state: ReturnType<typeof capture>,
    id: string,
    reachable: boolean,
  ) {
    const { watchAccountStatus } = await import("../account-status.js");
    const read = vi.fn(async () => account(id, reachable));
    stops.push(watchAccountStatus(state.controller, read));
    await flush();
    expect(state.controller.userId).toBe(id);
    return async (nextId: string, nextReachable: boolean) => {
      const count = read.mock.calls.length;
      read.mockResolvedValue(account(nextId, nextReachable));
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(count + 1));
      await flush();
      expect(state.controller.userId).toBe(nextId);
      expect(state.controller.cloudReachable).toBe(nextReachable);
    };
  }

  for (const route of ["desktop", "legacy"] as const) {
    const retry = () =>
      screen.getByRole("button", {
        name: route === "desktop" ? "Try again" : STRINGS.sync.retry,
      });
    const props = (state: ReturnType<typeof capture>) => ({
      controller: state.controller,
      committedPopupBinding: state.binding,
      compact: true,
      ...(route === "desktop"
        ? {
            popupPresentation: {
              browser: "Chrome" as const,
              onSettings: vi.fn(),
              loadDesktop: () => import("../v3/DesktopPopup.svelte"),
            },
          }
        : {}),
    });

    it.each(["account-switch", "account-return", "controller-replacement"])(
      `${route} ignores deferred retry rejection after %s`,
      async (transition) => {
        const f = await browser();
        const p = purchase();
        const held = gate();
        p.retrySync.mockImplementationOnce(async () => {
          await held.promise;
          throw new Error("Synthetic delayed sync retry failure");
        });
        const state = capture({ purchase: p.deps });
        await flush();
        const refresh = await observedAccount(state, "accountA", false);
        const revision = state.controller.accountRevision;
        const view = render(App, props(state));
        await waitFor(() => expect(retry()).toBeTruthy());
        const saved = await f.authority.get();
        await fireEvent.click(retry());
        expect(p.retrySync).toHaveBeenCalledOnce();
        let current = state;
        try {
          if (transition === "controller-replacement") {
            await refresh("accountA", true);
            const replacementPurchase = purchase();
            current = capture({ purchase: replacementPurchase.deps });
            await flush();
            await observedAccount(current, "accountB", true);
            // Equal revisions discriminate controller identity from the revision fence.
            expect(current.controller.accountRevision).toBe(revision);
            await view.rerender(props(current));
            expect(replacementPurchase.retrySync).not.toHaveBeenCalled();
          } else {
            await refresh("accountB", true);
            if (transition === "account-return")
              await refresh("accountA", true);
            expect(current.controller.accountRevision).toBeGreaterThan(
              revision,
            );
          }
          expect(screen.getByText(STRINGS.sync.synced)).toBeTruthy();
          held.open();
          await flush();
          expect(current.controller.cloudReachable).toBe(true);
          expect(state.controller.cloudReachable).toBe(true);
          expect(screen.getByText(STRINGS.sync.synced)).toBeTruthy();
          expect(screen.queryByText(STRINGS.sync.unreachable)).toBeNull();
          expect(p.retrySync).toHaveBeenCalledOnce();
          expect(f.sendMessage).not.toHaveBeenCalled();
          expect(await f.authority.get()).toEqual(saved);
        } finally {
          held.open();
        }
      },
    );

    it.each(["rejected", "fulfilled"])(
      `${route} preserves current-lifecycle %s retry behavior`,
      async (outcome) => {
        await browser();
        const p = purchase();
        const held = gate();
        p.retrySync.mockImplementationOnce(async () => {
          await held.promise;
          if (outcome === "rejected")
            throw new Error("Synthetic current sync retry failure");
        });
        const state = capture({ purchase: p.deps });
        await flush();
        const refresh = await observedAccount(state, "accountA", false);
        const revision = state.controller.accountRevision;
        render(App, props(state));
        await waitFor(() => expect(retry()).toBeTruthy());
        await fireEvent.click(retry());
        expect(p.retrySync).toHaveBeenCalledOnce();
        try {
          // A same-account health refresh does not retire the retry's lifecycle.
          await refresh("accountA", true);
          expect(state.controller.accountRevision).toBe(revision);
          held.open();
          await flush();
          expect(state.controller.cloudReachable).toBe(outcome === "fulfilled");
          expect(
            screen.getByText(
              outcome === "fulfilled"
                ? STRINGS.sync.synced
                : STRINGS.sync.unreachable,
            ),
          ).toBeTruthy();
        } finally {
          held.open();
        }
      },
    );

    it(`${route} omits retry when its optional port is absent`, async () => {
      await browser();
      const p = purchase();
      const state = capture({ purchase: { ...p.deps, retrySync: undefined } });
      await flush();
      await observedAccount(state, "accountA", false);
      render(App, props(state));
      await waitFor(() =>
        expect(screen.getByText(STRINGS.sync.unreachable)).toBeTruthy(),
      );
      expect(
        screen.queryByRole("button", {
          name: route === "desktop" ? "Try again" : STRINGS.sync.retry,
        }),
      ).toBeNull();
      expect(p.retrySync).not.toHaveBeenCalled();
      expect(state.controller.cloudReachable).toBe(false);
    });
  }
});

describe("retained local-only authority in the actual desktop host", () => {
  it("saves deliberate free controls after a retained Off migration without creating cloud requests", async () => {
    const f = await browser();
    f.store["still:settings"] = { settings: { ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 21,
      services: { ...DEFAULT_SETTINGS.services, facebook: false, tiktok: false } }, syncMetadata: null, syncEpoch: 0 };
    await f.authority.initializeAtomic("unknown");
    const state = capture(); await flush();
    const telemetry = vi.fn();
    const view = render(App, { controller: state.controller, committedPopupBinding: state.binding,
      popupPresentation: { browser: "Chrome", onSettings: vi.fn(), loadDesktop: () => import("../v3/DesktopPopup.svelte") },
      onCommittedPopupToggle: telemetry, compact: true });
    const global = () => screen.getByRole("switch", { name: "Still" });
    await waitFor(() => expect(global()).toHaveAttribute("aria-checked", "false"));
    expect(global()).not.toHaveAttribute("aria-disabled", "true");
    expect(telemetry).not.toHaveBeenCalled();
    await fireEvent.click(global());
    await waitFor(() => expect(global()).toHaveAttribute("aria-checked", "true"));
    await fireEvent.click(screen.getByRole("button", { name: "YouTube Blocker" }));
    await fireEvent.click(screen.getByRole("switch", { name: "Shorts" }));
    await waitFor(() => expect(requireModernSettings((f.store["still:settings"] as StoredSettingsRecord)).sites["youtube.shorts"]).toBe(false));
    const saved = (await f.authority.get())!;
    expect(saved).toMatchObject({ settings: { globalOn: true, services: { facebook: false, tiktok: false },
      clocks: { globalOn: { localStep: 1 }, "sites.youtube.shorts": { localStep: 1 } } },
      atomic: { ownership: "unknown", sequence: 2, pending: [], paused: null } });
    expect(telemetry).toHaveBeenCalledExactlyOnceWith({ enabled: true });
    view.unmount(); state.binding.stop();
    const reopened = capture(); await flush();
    expect(reopened.binding.current().commandAvailability).toBe("ready");
    expect(reopened.binding.current().settings!.sites["youtube.shorts"]).toBe(false);
    expect(await f.authority.get()).toEqual(saved);
  });
});

describe("mounted sync retry attachment lifetime", () => {
  async function observe(
    state: ReturnType<typeof capture>,
    reachable: boolean,
  ) {
    const { watchAccountStatus } = await import("../account-status.js");
    const snapshot = (cloudReachable: boolean) => ({
      accountId: "accountA",
      email: "accountA@example.com",
      lastSyncedAt: 1000,
      pendingUpload: false,
      cloudReachable,
      updatedAt: 1100,
    });
    const read = vi.fn(async () => snapshot(reachable));
    stops.push(watchAccountStatus(state.controller, read));
    await flush();
    expect(state.controller.userId).toBe("accountA");
    expect(state.controller.cloudReachable).toBe(reachable);
    return async (nextReachable: boolean) => {
      const count = read.mock.calls.length;
      read.mockResolvedValue(snapshot(nextReachable));
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(count + 1));
      await flush();
      expect(state.controller.cloudReachable).toBe(nextReachable);
    };
  }

  for (const route of ["desktop", "legacy"] as const) {
    const retry = () =>
      screen.getByRole("button", {
        name: route === "desktop" ? "Try again" : STRINGS.sync.retry,
      });
    const props = (
      state: ReturnType<typeof capture>,
      controller = state.controller,
    ) => ({
      controller,
      compact: true,
      ...(route === "desktop"
        ? {
            committedPopupBinding: state.binding,
            popupPresentation: {
              browser: "Chrome" as const,
              onSettings: vi.fn(),
              loadDesktop: () => import("../v3/DesktopPopup.svelte"),
            },
          }
        : {}),
    });

    it.each(["unmount-remount", "controller-return"] as const)(
      `${route} ignores old retry rejection after attachment %s`,
      async (transition) => {
        const f = await browser();
        const p = purchase();
        const held = gate();
        p.retrySync.mockImplementationOnce(async () => {
          await held.promise;
          throw new Error("Synthetic obsolete attachment retry failure");
        });
        const state = capture({ purchase: p.deps });
        await flush();
        const refresh = await observe(state, false);
        const revision = state.controller.accountRevision;
        const view = render(App, props(state));
        await waitFor(() => expect(retry()).toBeTruthy());
        const saved = await f.authority.get();
        await fireEvent.click(retry());
        expect(p.retrySync).toHaveBeenCalledOnce();
        try {
          await refresh(true);
          const replacement = capture();
          await flush();
          if (transition === "unmount-remount") {
            view.unmount();
            // The new component reuses the exact same controller. A desktop
            // mount gets fresh settings observation after the old binding stops.
            render(App, props(replacement, state.controller));
          } else {
            await observe(replacement, true);
            expect(replacement.controller.accountRevision).toBe(revision);
            // Keep the settings binding fixed: this is a controller attachment
            // change, independent of the settings-command lifetime.
            await view.rerender(props(state, replacement.controller));
            expect(screen.getByText(STRINGS.sync.synced)).toBeTruthy();
            await view.rerender(props(state));
          }
          if (route === "desktop")
            await waitFor(() =>
              expect(
                screen.getByRole("switch", { name: "Still" }),
              ).toBeTruthy(),
            );
          await waitFor(() =>
            expect(screen.getByText(STRINGS.sync.synced)).toBeTruthy(),
          );
          expect(state.controller.accountRevision).toBe(revision);
          expect(state.controller.cloudReachable).toBe(true);
          held.open();
          await flush();
          expect(state.controller.cloudReachable).toBe(true);
          expect(screen.getByText(STRINGS.sync.synced)).toBeTruthy();
          expect(screen.queryByText(STRINGS.sync.unreachable)).toBeNull();
          expect(p.retrySync).toHaveBeenCalledOnce();
          expect(f.sendMessage).not.toHaveBeenCalled();
          expect(await f.authority.get()).toEqual(saved);
        } finally {
          held.open();
        }
      },
    );

    it.each(["rejected", "fulfilled", "absent"] as const)(
      `${route} keeps current attachment %s retry behavior`,
      async (outcome) => {
        await browser();
        const p = purchase();
        const held = gate();
        p.retrySync.mockImplementationOnce(async () => {
          await held.promise;
          if (outcome === "rejected")
            throw new Error("Synthetic current attachment retry failure");
        });
        const state = capture({
          purchase:
            outcome === "absent" ? { ...p.deps, retrySync: undefined } : p.deps,
        });
        await flush();
        const refresh = await observe(state, false);
        const revision = state.controller.accountRevision;
        render(App, props(state));
        if (route === "desktop")
          await waitFor(() =>
            expect(screen.getByRole("switch", { name: "Still" })).toBeTruthy(),
          );
        await waitFor(() =>
          expect(screen.getByText(STRINGS.sync.unreachable)).toBeTruthy(),
        );
        if (outcome === "absent") {
          expect(
            screen.queryByRole("button", {
              name: route === "desktop" ? "Try again" : STRINGS.sync.retry,
            }),
          ).toBeNull();
          expect(p.retrySync).not.toHaveBeenCalled();
          expect(state.controller.cloudReachable).toBe(false);
          return;
        }
        await fireEvent.click(retry());
        expect(p.retrySync).toHaveBeenCalledOnce();
        try {
          await refresh(true);
          expect(state.controller.accountRevision).toBe(revision);
          held.open();
          await flush();
          expect(state.controller.cloudReachable).toBe(outcome === "fulfilled");
          expect(
            screen.getByText(
              outcome === "fulfilled"
                ? STRINGS.sync.synced
                : STRINGS.sync.unreachable,
            ),
          ).toBeTruthy();
        } finally {
          held.open();
        }
      },
    );
  }
});
