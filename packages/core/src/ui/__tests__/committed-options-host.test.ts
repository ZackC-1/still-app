import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import { tick, mount, unmount, flushSync } from "svelte";
import { createSubscriber } from "svelte/reactivity";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { STRINGS } from "../strings.js";
import App from "../App.svelte";
import {
  requireModernSettings,
  type StoredSettingsRecord,
} from "../../storage/index.js";
import {
  browser,
  capture,
  flush,
  gate,
  purchase,
} from "./committed-popup-host.fixtures.js";

const presentation = () => ({
  browser: "Chrome" as const,
  loadSettings: () => import("../v3/ExtensionSettings.svelte"),
  help: { onGuide: vi.fn(), onSupport: vi.fn(), onPrivacy: vi.fn() },
});

async function options(state: ReturnType<typeof capture>) {
  const telemetry = vi.fn();
  const view = render(App, {
    controller: state.controller,
    committedPopupBinding: state.binding,
    settingsPresentation: presentation(),
    onCommittedPopupToggle: telemetry,
  });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    ).toBeTruthy(),
  );
  return { ...view, telemetry };
}

describe("actual options presentation on the maintained authority", () => {
  it("opens the approved service section and commits its free feature through the real authority", async () => {
    const f = await browser();
    const state = capture();
    await flush();
    const view = await options(state);
    await fireEvent.click(
      screen.getByRole("button", { name: "YouTube Blocker" }),
    );
    await fireEvent.click(screen.getByRole("switch", { name: "Shorts" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Shorts" })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
    expect(
      requireModernSettings(f.store["still:settings"] as StoredSettingsRecord)
        .sites["youtube.shorts"],
    ).toBe(false);
    expect(f.set).toHaveBeenCalledOnce();
    expect(view.telemetry).not.toHaveBeenCalled();
  });

  it("keeps the saved requested global choice until its real receipt and reports that committed toggle", async () => {
    const f = await browser();
    const state = capture();
    await flush();
    const view = await options(state);
    const entered = gate();
    const held = gate();
    f.port(async (intent) => {
      entered.open();
      await held.promise;
      return f.authority.commitIntent(intent);
    });
    await fireEvent.click(screen.getByRole("switch", { name: "Still" }));
    await entered.promise;
    try {
      expect(screen.getByRole("switch", { name: "Still" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(view.telemetry).not.toHaveBeenCalled();
      held.open();
      await waitFor(() =>
        expect(screen.getByRole("switch", { name: "Still" })).toHaveAttribute(
          "aria-checked",
          "false",
        ),
      );
      await waitFor(() =>
        expect(view.telemetry).toHaveBeenCalledExactlyOnceWith({
          enabled: false,
        }),
      );
      expect(
        requireModernSettings(f.store["still:settings"] as StoredSettingsRecord)
          .globalOn,
      ).toBe(false);
    } finally {
      held.open();
    }
  });
});

describe("current options account, privacy and loader lifetime", () => {
  it.each(["revision", "batched A-B-A"] as const)(
    "rejects the old deletion confirmation after %s without backend work",
    async (replacement) => {
      await browser();
      const p = purchase();
      const state = capture({ purchase: p.deps });
      await flush();
      state.controller.userId = "synthetic-account";
      state.controller.accountEmail = null;
      await options(state);
      expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
      await fireEvent.click(
        screen.getByRole("button", { name: "Delete account" }),
      );
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      // accountRevision is an actual controller epoch, deliberately not an email-derived token.
      state.controller.accountRevision += 1;
      if (replacement === "batched A-B-A") {
        state.controller.userId = "synthetic-replacement";
        state.controller.userId = "synthetic-account";
        state.controller.accountRevision += 1;
      }
      await tick();
      const obsoleteDialog = screen.queryByRole("dialog");
      if (obsoleteDialog)
        await fireEvent.click(
          within(obsoleteDialog).getByRole("button", {
            name: "Delete account",
          }),
        );
      await flush();
      expect(p.auth.deleteAccount).not.toHaveBeenCalled();
      expect(state.controller.userId).toBe("synthetic-account");
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("uses one real confirmation, preserves pending/error and retries the deliberate current deletion", async () => {
    await browser();
    const p = purchase();
    const state = capture({ purchase: p.deps });
    await flush();
    state.controller.userId = "synthetic-account";
    state.controller.accountEmail = null;
    const held = gate();
    p.auth.deleteAccount.mockImplementationOnce(async () => {
      await held.promise;
      throw new Error("Synthetic deletion failure");
    });
    await options(state);
    const request = vi.spyOn(state.controller, "requestDeleteAccount");
    await fireEvent.click(
      screen.getByRole("button", { name: "Delete account" }),
    );
    await fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete account",
      }),
    );
    try {
      await waitFor(() => expect(p.auth.deleteAccount).toHaveBeenCalledOnce());
      expect(screen.getByText(STRINGS.account.deleting)).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Delete account" }),
      ).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      held.open();
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Synthetic deletion failure",
        ),
      );
    } finally {
      held.open();
    }
    expect(request).not.toHaveBeenCalled();
    await fireEvent.click(
      screen.getByRole("button", { name: "Delete account" }),
    );
    await fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete account",
      }),
    );
    await waitFor(() => expect(state.controller.userId).toBeNull());
    expect(p.auth.deleteAccount).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it.each(["opt-out", "unmount", "controller replacement"] as const)(
    "does not mount an obsolete loaded screen after %s",
    async (close) => {
      await browser();
      const state = capture();
      await flush();
      const held = gate();
      const host = {
        ...presentation(),
        loadSettings: () =>
          held.promise.then(() => import("../v3/ExtensionSettings.svelte")),
      };
      const props = {
        controller: state.controller,
        committedPopupBinding: state.binding,
        settingsPresentation: host,
      };
      const view = render(App, props);
      await flush();
      if (close === "unmount") view.unmount();
      else if (close === "opt-out")
        await view.rerender({ ...props, settingsPresentation: undefined });
      else {
        const replacement = capture();
        await flush();
        await view.rerender({
          ...props,
          controller: replacement.controller,
          settingsPresentation: {
            ...presentation(),
            loadSettings: () =>
              Promise.reject(new Error("Synthetic held replacement")),
          },
        });
      }
      held.open();
      await flush();
      await flush();
      expect(
        screen.queryByRole("button", { name: "YouTube Blocker" }),
      ).toBeNull();
    },
  );

  it("keeps actual usage notice and per-device switch once without manufacturing combined consent", async () => {
    await browser();
    const setSharing = vi.fn(async (enabled: boolean) => enabled);
    const acknowledge = vi.fn();
    const state = capture({
      analytics: {
        track() {},
        identify() {},
        reset() {},
        sharing: async () => ({ enabled: true, noticeNeeded: true }),
        setSharing,
        acknowledgeNotice: acknowledge,
      },
    });
    await flush();
    await options(state);
    expect(
      screen.getAllByRole("switch", { name: STRINGS.usage.title }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: STRINGS.usage.noticeTurnOff }),
    ).toHaveLength(1);
    expect(
      screen.queryByText("Share your email and usage data with Still?"),
    ).toBeNull();
    expect(screen.queryByText("Deletion requested")).toBeNull();
    expect(screen.queryByRole("button", { name: "Get Still Pro" })).toBeNull();
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.usage.noticeTurnOff }),
    );
    await waitFor(() => expect(state.controller.usageSharing).toBe(false));
    expect(setSharing).toHaveBeenCalledExactlyOnceWith(false);
    expect(acknowledge).toHaveBeenCalledOnce();
  });
});

describe("saved options authority holds and recovery", () => {
  it.each(["paused", "previous-account"] as const)(
    "keeps saved controls focusable and refuses changes under %s",
    async (kind) => {
      const f = await browser();
      const state = capture();
      await flush();
      const view = await options(state);
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
          ownership:
            kind === "previous-account" ? "previous-account" : "never-linked",
        },
      });
      await flush();
      for (const name of ["Still", "Still on YouTube", "Shorts"]) {
        const control = screen.getByRole("switch", { name });
        expect(control).toHaveAttribute("aria-checked", "true");
        expect(control).toHaveAttribute("aria-disabled", "true");
        expect(control).not.toBeDisabled();
        await fireEvent.click(control);
      }
      await flush();
      expect(f.sendMessage).not.toHaveBeenCalled();
      expect(view.telemetry).not.toHaveBeenCalled();
      expect(await f.authority.get()).toEqual({
        ...before,
        atomic: {
          ...before.atomic!,
          sequence: before.atomic!.sequence + 1,
          paused: kind === "paused" ? "ordering-hold" : "ownership-unconfirmed",
          ownership:
            kind === "previous-account" ? "previous-account" : "never-linked",
        },
      });
    },
  );

  it("shows unavailable settings with one pure read retry while auth and privacy remain operational", async () => {
    const f = await browser();
    const p = purchase();
    await f.external({
      settings: { ...structuredClone(DEFAULT_SETTINGS), updatedAt: 999 },
      syncMetadata: null,
    });
    const state = capture({ purchase: p.deps });
    await flush();
    const reread = vi.spyOn(state.binding, "rereadAuthority");
    const held = gate();
    reread.mockImplementation(() =>
      held.promise.then(() => ({
        status: "unavailable" as const,
        reason: "modern-settings-unavailable",
      })),
    );
    render(App, {
      controller: state.controller,
      committedPopupBinding: state.binding,
      settingsPresentation: presentation(),
    });
    await flush();
    await flush();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByText(STRINGS.sync.checking)).toBeNull();
    expect(screen.getByText("Settings are unavailable.")).toBeTruthy();
    const action = screen.getByRole("button", { name: "Try again" });
    try {
      await fireEvent.click(action);
      await fireEvent.click(action);
      expect(reread).toHaveBeenCalledOnce();
      expect(f.sendMessage).not.toHaveBeenCalled();
      expect(action).toBeDisabled();
      held.open();
      await flush();
    } finally {
      held.open();
    }
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.auth.signInCta }),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Privacy policy" }),
    ).toHaveLength(1);
  });
});

describe("options loader failure recovery actions", () => {
  it("keeps real help and optional sign-in callable without invented settings when the screen loader rejects", async () => {
    await browser();
    const p = purchase();
    const state = capture({ purchase: p.deps });
    await flush();
    const host = {
      ...presentation(),
      loadSettings: () => Promise.reject(new Error("Synthetic loader failure")),
    };
    render(App, {
      controller: state.controller,
      committedPopupBinding: state.binding,
      settingsPresentation: host,
    });
    await flush();
    await flush();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    await fireEvent.click(screen.getByRole("button", { name: "Setup guide" }));
    await fireEvent.click(
      screen.getByRole("button", { name: "Contact support" }),
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "Privacy policy" }),
    );
    expect(host.help.onGuide).toHaveBeenCalledOnce();
    expect(host.help.onSupport).toHaveBeenCalledOnce();
    expect(host.help.onPrivacy).toHaveBeenCalledOnce();
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.auth.signInCta }),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});

describe("options deliberate-command recovery", () => {
  it.each(["global", "service", "feature"] as const)(
    "recovers a refused %s write once without replaying it",
    async (route) => {
      const f = await browser();
      const state = capture();
      await flush();
      const view = await options(state);
      if (route === "feature")
        await fireEvent.click(
          screen.getByRole("button", { name: "YouTube Blocker" }),
        );
      const name =
        route === "global"
          ? "Still"
          : route === "service"
            ? "Still on Instagram"
            : "Shorts";
      const saved = (await f.authority.get())!;
      const reread = vi.spyOn(state.binding, "rereadAuthority");
      f.set.mockRejectedValueOnce(new Error("Synthetic local.set refusal"));
      await fireEvent.click(screen.getByRole("switch", { name }));
      await waitFor(() => expect(reread).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(state.binding.current().commandAvailability).toBe("ready"),
      );
      expect(f.set).toHaveBeenCalledOnce();
      expect(f.sendMessage).toHaveBeenCalledOnce();
      expect(view.telemetry).not.toHaveBeenCalled();
      expect(await f.authority.get()).toEqual(saved);
      await fireEvent.click(screen.getByRole("switch", { name }));
      await waitFor(() =>
        expect(screen.getByRole("switch", { name })).toHaveAttribute(
          "aria-checked",
          "false",
        ),
      );
      expect(reread).toHaveBeenCalledOnce();
      expect(f.set).toHaveBeenCalledTimes(2);
      expect(f.sendMessage).toHaveBeenCalledTimes(2);
      if (route === "feature") expect(view.telemetry).not.toHaveBeenCalled();
      else await waitFor(() => expect(view.telemetry).toHaveBeenCalledOnce());
    },
  );
});

describe("options returning presentation attachment", () => {
  it("waits for the new A attachment loader after A-B-A instead of reusing the obsolete mounted screen", async () => {
    await browser();
    const state = capture();
    await flush();
    const held = gate();
    let calls = 0;
    const a = {
      ...presentation(),
      loadSettings: () => {
        calls += 1;
        return calls === 1
          ? import("../v3/ExtensionSettings.svelte")
          : held.promise.then(() => import("../v3/ExtensionSettings.svelte"));
      },
    };
    const b = {
      ...presentation(),
      loadSettings: () =>
        held.promise.then(() => import("../v3/ExtensionSettings.svelte")),
    };
    // Testing Library's shallow props proxy invalidates every object prop on rerender.
    // Use the actual Svelte mount with independently reactive host presentation instead.
    let host = a;
    let notify = () => {};
    const subscribe = createSubscriber((update) => {
      notify = update;
      return () => {
        notify = () => {};
      };
    });
    const component = mount(App, {
      target: document.body,
      props: {
        controller: state.controller,
        committedPopupBinding: state.binding,
        get settingsPresentation() {
          subscribe();
          return host;
        },
      },
    });
    flushSync();
    try {
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "YouTube Blocker" }),
        ).toBeTruthy(),
      );
      host = b;
      notify();
      flushSync();
      await flush();
      expect(state.binding.current().reason).not.toBe("stopped");
      expect(
        screen.queryByRole("button", { name: "YouTube Blocker" }),
      ).toBeNull();
      host = a;
      notify();
      flushSync();
      await flush();
      expect(calls).toBe(2);
      expect(
        screen.queryByRole("button", { name: "YouTube Blocker" }),
      ).toBeNull();
      held.open();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "YouTube Blocker" }),
        ).toBeTruthy(),
      );
    } finally {
      held.open();
      flushSync(() => {
        void unmount(component);
      });
    }
  });
});

describe("actual options sync and auth operations", () => {
  it("shows actual checking, pending and last-sync states, then signs out and opens the real email form", async () => {
    await browser();
    const p = purchase();
    const state = capture({ purchase: p.deps });
    await flush();
    state.controller.userId = "synthetic-account";
    state.controller.accountEmail = null;
    state.controller.cloudReachable = true;
    state.controller.lastSyncedAt = null;
    state.controller.pendingUpload = false;
    await options(state);
    expect(screen.getByText(STRINGS.sync.checking)).toBeTruthy();
    state.controller.pendingUpload = true;
    await tick();
    expect(screen.getByText(STRINGS.sync.syncing)).toBeTruthy();
    state.controller.pendingUpload = false;
    state.controller.lastSyncedAt = 1000;
    await tick();
    expect(screen.getByText(STRINGS.sync.synced)).toBeTruthy();
    expect(document.querySelector("time")).toHaveAttribute(
      "datetime",
      new Date(1000).toISOString(),
    );
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(p.auth.signOut).toHaveBeenCalledOnce());
    await waitFor(() => expect(state.controller.userId).toBeNull());
    await fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("textbox")).toHaveAttribute("type", "email");
    expect(p.auth.requestCode).not.toHaveBeenCalled();
  });
  it("runs the deliberate sync retry and discards its rejection after the actual account revision changes", async () => {
    const f = await browser();
    const p = purchase();
    const held = gate();
    p.retrySync.mockImplementationOnce(async () => {
      await held.promise;
      throw new Error("Synthetic obsolete retry");
    });
    const state = capture({ purchase: p.deps });
    await flush();
    state.controller.userId = "synthetic-account";
    state.controller.accountEmail = null;
    state.controller.cloudReachable = false;
    await options(state);
    const before = await f.authority.get();
    await fireEvent.click(
      screen.getByRole("button", { name: STRINGS.sync.retry }),
    );
    expect(p.retrySync).toHaveBeenCalledOnce();
    try {
      state.controller.accountRevision += 1;
      state.controller.cloudReachable = true;
      state.controller.lastSyncedAt = 1000;
      await tick();
      held.open();
      await flush();
      expect(state.controller.cloudReachable).toBe(true);
      expect(screen.getByText(STRINGS.sync.synced)).toBeTruthy();
      expect(screen.queryByText(STRINGS.sync.unreachable)).toBeNull();
      expect(await f.authority.get()).toEqual(before);
      expect(f.sendMessage).not.toHaveBeenCalled();
    } finally {
      held.open();
    }
  });
});

describe("options current deletion through sync status refreshes", () => {
  it.each(["cloudReachable", "pendingUpload", "lastSyncedAt"] as const)(
    "keeps the real confirmation actionable through a %s refresh and deletes once",
    async (field) => {
      await browser();
      const p = purchase();
      const state = capture({ purchase: p.deps });
      await flush();
      state.controller.userId = "synthetic-account";
      state.controller.accountEmail = "synthetic@example.invalid";
      state.controller.cloudReachable = true;
      state.controller.pendingUpload = false;
      state.controller.lastSyncedAt = null;
      const held = gate();
      p.auth.deleteAccount.mockImplementationOnce(() => held.promise);
      await options(state);
      await fireEvent.click(
        screen.getByRole("button", { name: "Delete account" }),
      );
      const dialog = screen.getByRole("dialog");
      const confirm = within(dialog).getByRole("button", {
        name: "Delete account",
      });
      if (field === "cloudReachable") state.controller.cloudReachable = false;
      else if (field === "pendingUpload") state.controller.pendingUpload = true;
      else state.controller.lastSyncedAt = 1000;
      await tick();
      expect(screen.queryByRole("dialog")).toBe(dialog);
      expect(confirm).not.toBeDisabled();
      expect(p.auth.deleteAccount).not.toHaveBeenCalled();
      expect(
        screen.getByText(
          field === "cloudReachable"
            ? STRINGS.sync.unreachable
            : field === "pendingUpload"
              ? STRINGS.sync.syncing
              : STRINGS.sync.synced,
        ),
      ).toBeTruthy();
      try {
        await fireEvent.click(confirm);
        await fireEvent.click(confirm);
        await waitFor(() =>
          expect(p.auth.deleteAccount).toHaveBeenCalledOnce(),
        );
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.getByText(STRINGS.account.deleting)).toBeTruthy();
        expect(
          screen.queryByRole("button", { name: "Delete account" }),
        ).toBeNull();
        held.open();
        await waitFor(() => expect(state.controller.userId).toBeNull());
        expect(p.auth.deleteAccount).toHaveBeenCalledOnce();
      } finally {
        held.open();
      }
    },
  );
});

describe("options deletion attachment replacement safeguards", () => {
  it.each([
    "address",
    "revision",
    "batched A-B-A",
    "controller",
    "host",
    "loader",
    "binding",
    "stopped binding",
    "unmount",
  ] as const)(
    "denies the obsolete confirmation after %s and requires a fresh current choice",
    async (replacement) => {
      await browser();
      const p = purchase();
      const state = capture({ purchase: p.deps });
      await flush();
      state.controller.userId = "synthetic-account";
      state.controller.accountEmail = null;
      let controller = state.controller;
      const host = presentation();
      const props = {
        controller,
        committedPopupBinding: state.binding,
        settingsPresentation: host,
      };
      let attachment = props;
      const signal = () => {
        let notify = () => {};
        const subscribe = createSubscriber((update) => {
          notify = update;
          return () => {
            notify = () => {};
          };
        });
        return { subscribe, update: () => notify() };
      };
      const signals = [signal(), signal(), signal()] as const;
      const component = mount(App, {
        target: document.body,
        props: {
          get controller() {
            signals[0].subscribe();
            return attachment.controller;
          },
          get committedPopupBinding() {
            signals[1].subscribe();
            return attachment.committedPopupBinding;
          },
          get settingsPresentation() {
            signals[2].subscribe();
            return attachment.settingsPresentation;
          },
        },
      });
      const close = () =>
        flushSync(() => {
          void unmount(component);
        });
      flushSync();
      try {
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: "YouTube Blocker" }),
          ).toBeTruthy(),
        );
        await fireEvent.click(
          screen.getByRole("button", { name: "Delete account" }),
        );
        const obsoleteConfirm = within(screen.getByRole("dialog")).getByRole(
          "button",
          { name: "Delete account" },
        );
        if (replacement === "address")
          controller.accountEmail = "synthetic@example.invalid";
        else if (replacement === "revision") {
          controller.accountRevision += 1;
          // The maintained controller publishes its non-reactive epoch with sync status.
          controller.cloudReachable = false;
        } else if (replacement === "batched A-B-A") {
          controller.userId = "synthetic-replacement";
          controller.accountRevision += 1;
          controller.userId = "synthetic-account";
          controller.accountRevision += 1;
        } else if (replacement === "controller") {
          const next = capture({ purchase: p.deps });
          await flush();
          controller = next.controller;
          controller.userId = "synthetic-account";
          controller.accountEmail = null;
          attachment = { ...props, controller };
          signals[0].update();
        } else if (replacement === "host" || replacement === "loader") {
          attachment = {
            ...props,
            settingsPresentation:
              replacement === "host"
                ? presentation()
                : {
                    ...host,
                    loadSettings: async () =>
                      import("../v3/ExtensionSettings.svelte"),
                  },
          };
          signals[2].update();
        } else if (replacement === "binding") {
          const next = capture();
          await flush();
          attachment = { ...props, committedPopupBinding: next.binding };
          signals[1].update();
        } else if (replacement === "stopped binding") state.binding.stop();
        else close();
        await tick();
        await fireEvent.click(obsoleteConfirm);
        await flush();
        expect(p.auth.deleteAccount).not.toHaveBeenCalled();
        expect(screen.queryByRole("dialog")).toBeNull();
        if (replacement === "unmount" || replacement === "stopped binding")
          return;
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: "YouTube Blocker" }),
          ).toBeTruthy(),
        );
        await fireEvent.click(
          screen.getByRole("button", { name: "Delete account" }),
        );
        // Even a reopened same-account dialog cannot revive the previous click target.
        await fireEvent.click(obsoleteConfirm);
        expect(p.auth.deleteAccount).not.toHaveBeenCalled();
        await fireEvent.click(
          within(screen.getByRole("dialog")).getByRole("button", {
            name: "Delete account",
          }),
        );
        await waitFor(() => expect(controller.userId).toBeNull());
        expect(p.auth.deleteAccount).toHaveBeenCalledOnce();
      } finally {
        close();
      }
    },
  );
});
