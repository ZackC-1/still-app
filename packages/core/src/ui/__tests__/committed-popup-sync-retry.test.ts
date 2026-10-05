import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import App from "../App.svelte";
import { STRINGS } from "../strings.js";
import {
  stops,
  flush,
  gate,
  browser,
  capture,
  purchase,
} from "./committed-popup-host.fixtures.js";

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
