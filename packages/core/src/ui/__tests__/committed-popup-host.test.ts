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

  it.each(["paused", "unknown"] as const)(
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
          paused: kind === "paused" ? "ordering-hold" : null,
          ownership: kind === "unknown" ? "unknown" : "never-linked",
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
