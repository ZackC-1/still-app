import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import { tick } from "svelte";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import {
  SettingsStorageRecovery,
  type StoredSettingsRecord,
  requireModernSettings,
} from "../../storage/index.js";
import App from "../App.svelte";
import { STRINGS } from "../strings.js";
import { FIRST_READ_BOUND_MS } from "../v3/popup-view-binding.svelte.js";
import type { UiAnalytics } from "../controller.svelte.js";
import {
  flush,
  gate,
  browser,
  capture,
  globalSwitch,
  serviceSwitch,
  mount,
  purchase,
} from "./committed-popup-host.fixtures.js";

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

describe("maintained App committed popup host", () => {
  type Local = { get: (key: string) => Promise<Record<string, unknown>> };
  function holdSettingsRead(behaviour: "gate" | "fail" | "hang") {
    const local = (globalThis as unknown as { chrome: { storage: { local: Local } } }).chrome.storage.local;
    const real = local.get;
    const g = gate();
    // Only the settings slot: entitlement and other reads keep answering normally.
    local.get = (key) =>
      key !== "still:settings"
        ? real(key)
        : behaviour === "fail"
        ? Promise.reject(new Error("synthetic storage failure"))
        : behaviour === "hang"
          ? new Promise(() => {})
          : g.promise.then(() => real(key));
    return g;
  }
  const unavailable = () => screen.queryByText("Settings are unavailable.");

  it("a slow first read shows checking, never unavailable, then the saved choices", async () => {
    const f = await browser();
    const saved = JSON.stringify(f.store["still:settings"]);
    const read = holdSettingsRead("gate");
    const state = capture();
    mount(state);
    for (let i = 0; i < 5; i++) await flush();
    expect(state.binding.current().commandAvailability).toBe("unavailable");
    expect(screen.getByRole("status").textContent).toBe(STRINGS.sync.checking);
    expect(unavailable()).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Still on/off" })).toBeNull();
    read.open();
    await waitFor(() => expect(globalSwitch().disabled).toBe(false));
    expect(unavailable()).toBeNull();
    expect(screen.queryByText(STRINGS.sync.checking)).toBeNull();
    expect(f.set).not.toHaveBeenCalled();
    expect(JSON.stringify(f.store["still:settings"])).toBe(saved);
  });

  it("a first read that fails still shows unavailable and Try again", async () => {
    const f = await browser();
    holdSettingsRead("fail");
    const state = capture();
    mount(state);
    await waitFor(() => expect(unavailable()).toBeTruthy());
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(STRINGS.sync.checking)).toBeNull();
    expect(f.set).not.toHaveBeenCalled();
  });

  it("a first read that never answers turns unavailable after the bound, not before", async () => {
    const f = await browser();
    holdSettingsRead("hang");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const state = capture();
      mount(state);
      await tick();
      vi.advanceTimersByTime(FIRST_READ_BOUND_MS - 1);
      await tick();
      expect(unavailable()).toBeNull();
      expect(screen.getByRole("status").textContent).toBe(STRINGS.sync.checking);
      vi.advanceTimersByTime(1);
      await tick();
      expect(unavailable()).toBeTruthy();
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
      expect(screen.queryByText(STRINGS.sync.checking)).toBeNull();
      expect(f.set).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows no fabricated switches before modern hydration, then mounts account-free saved controls", async () => {
    const f = await browser();
    const state = capture();
    mount(state);
    expect(screen.queryByRole("switch", { name: "Still on/off" })).toBeNull();
    expect(document.querySelectorAll("[data-service]")).toHaveLength(0);
    // Startup defaults are not an answer: checking, never "unavailable", until the read lands.
    expect(screen.getByRole("status").textContent).toBe(STRINGS.sync.checking);
    expect(screen.queryByText("Settings are unavailable.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
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
