import { describe, expect, it, vi } from "vitest";

// The committed page's access re-check exists only with the paid tier compiled on.
vi.mock("@still/shared-types", async (original) => ({
  ...(await original<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import { FEATURE_REGISTRY, type AccessState, type BenefitAccessSnapshot } from "@still/shared-types";
import { ACCESS_BENEFITS, initialAccessSnapshot } from "../../entitlement/index.js";
import { createExtensionUiController } from "../extension-setup.js";
import type { CheckoutReconcileOutcome } from "../controller.svelte.js";
import { browser, flush, gate, purchase, stops } from "./committed-popup-host.fixtures.js";

function access(state: AccessState): BenefitAccessSnapshot {
  const value = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  return { ...value, states: Object.fromEntries(Object.entries(value.states).map(([id, prior]) =>
    [id, FEATURE_REGISTRY.some(row => row.id === id && row.tier === "pro") ? state : prior])) as BenefitAccessSnapshot["states"] };
}

async function page(options: {
  userId?: string | null;
  committed?: boolean;
  pending?: { startedAt?: number; tabId?: number } | null;
  /** The page's account-status read (getSyncStatus): the account it reports, answered at once. */
  status?: string | null;
  /** Holds the background's getState answer until opened. */
  stateGate?: Promise<void>;
} = {}) {
  const f = await browser();
  const events: string[] = [];
  let snapshot = access("verification_required");
  const original = chrome.runtime.sendMessage;
  Object.assign(chrome.runtime, {
    sendMessage: vi.fn(async (message: { kind?: string }) => {
      if (message.kind === "observeBenefits") { events.push(`observe:${snapshot.states["youtube.comments"]}`); return { ok: true, snapshot }; }
      return original(message);
    }),
  });
  const p = purchase();
  const setPending = vi.fn((_pending: unknown) => {});
  let reconcileGate: Promise<void> | null = null;
  const reconcile = vi.fn(async (): Promise<CheckoutReconcileOutcome> => {
    events.push("reconcile");
    if (reconcileGate) await reconcileGate;
    snapshot = access("locked");
    return "not-entitled";
  });
  const deps = {
    ...p.deps,
    getState: async () => {
      if (options.stateGate) await options.stateGate;
      return { userId: options.userId === undefined ? "synthetic-account" : options.userId, entitled: false, pendingOtp: null, checkoutPending: options.pending ?? null };
    },
    ...(options.status === undefined ? {} : {
      readAccountStatus: async () => options.status == null ? null : {
        accountId: options.status, email: null, lastSyncedAt: null, pendingUpload: false, cloudReachable: true, updatedAt: 0,
      },
    }),
    checkout: { ...p.deps.checkout, reconcile, setPending },
  };
  let binding: { current(): { access: BenefitAccessSnapshot }; stop(): void } | undefined;
  const controller = createExtensionUiController(deps, {
    accessHost: "chromium",
    onCommittedPopupBinding: options.committed === false ? undefined : (b) => { binding = b; stops.push(() => b.stop()); },
  });
  stops.push(() => controller.dispose());
  return { f, events, reconcile, setPending, controller, binding: () => binding!, hold(g: Promise<void>) { reconcileGate = g; } };
}

describe("committed paid page access re-check", () => {
  it("re-checks on open and reads access again after the reconcile, so a known none shows", async () => {
    const h = await page();
    await vi.waitFor(() => expect(h.binding().current().access.states["youtube.comments"]).toBe("locked"));
    expect(h.reconcile).toHaveBeenCalledOnce();
    const reconcileAt = h.events.indexOf("reconcile");
    expect(h.events.slice(reconcileAt + 1)).toContain("observe:locked");
  });

  it("shares one flight between the page-open check and the page's own request", async () => {
    const g = gate();
    const h = await page({ userId: null });
    h.hold(g.promise);
    const first = h.controller.recheckAccess!();
    const second = h.controller.recheckAccess!();
    expect(second).toBe(first);
    g.open();
    const result = await first;
    expect(result.outcome).toBe("not-entitled");
    expect(result.access.states["youtube.comments"]).toBe("locked");
    expect(h.reconcile).toHaveBeenCalledOnce();
    // A later request is a new flight.
    await h.controller.recheckAccess!();
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it("a pending checkout on a committed paid page re-checks instead of presenting the legacy priced sheet", async () => {
    const h = await page({ pending: { startedAt: Date.now() - 60_000, tabId: 7 } });
    await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledOnce());
    await flush();
    expect(h.controller.paywallOpen).toBe(false);
    expect(h.controller.checkoutFlow).toBe("none");
    expect(h.setPending).not.toHaveBeenCalled(); // only the background ends a live record
  });

  it("drops a pending record past its lifetime, or without a usable start", async () => {
    for (const pending of [{ startedAt: Date.now() - 25 * 60 * 60_000, tabId: 7 }, { tabId: 7 }]) {
      const h = await page({ pending });
      await vi.waitFor(() => expect(h.setPending).toHaveBeenCalledWith(null));
      expect(h.controller.paywallOpen).toBe(false);
    }
  });

  it("an uncommitted paid page keeps the legacy pending presentation", async () => {
    const h = await page({ committed: false, pending: { startedAt: Date.now() - 60_000 } });
    await vi.waitFor(() => expect(h.controller.paywallOpen).toBe(true));
    expect(h.controller.checkoutFlow).toBe("checking");
  });

  // The account-status read is local (session metadata) while getState verifies the session over
  // the network, so the page usually learns its account first. That first observation is not an
  // account change, and must not cancel the page-open re-check.
  it("re-checks once on open when the account-status read lands before the background's state", async () => {
    const g = gate();
    const h = await page({ status: "synthetic-account", stateGate: g.promise });
    await vi.waitFor(() => expect(h.controller.userId).toBe("synthetic-account"));
    expect(h.reconcile).not.toHaveBeenCalled();
    g.open();
    await vi.waitFor(() => expect(h.binding().current().access.states["youtube.comments"]).toBe("locked"));
    await flush(); await flush();
    expect(h.reconcile).toHaveBeenCalledOnce();
  });

  it("re-checks once on open when the background's state lands first", async () => {
    const h = await page({ status: "synthetic-account" });
    await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.controller.userId).toBe("synthetic-account"));
    await flush(); await flush();
    expect(h.reconcile).toHaveBeenCalledOnce();
  });

  it("drops the open re-check when the account changed before the background answered", async () => {
    for (const status of ["another-account", null]) {
      const g = gate();
      const h = await page({ status, stateGate: g.promise });
      // Signed in elsewhere first (the observed account differs from the one getState reports).
      h.controller.accountRevision++;
      g.open();
      await flush(); await flush(); await flush();
      expect(h.reconcile).not.toHaveBeenCalled();
    }
  });

  it("signed out at open, nothing reconciles", async () => {
    const h = await page({ userId: null });
    await flush(); await flush();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("an uncommitted page gets no re-check capability", async () => {
    const h = await page({ committed: false });
    await flush();
    expect(h.controller.recheckAccess).toBeUndefined();
  });
});

describe("committed paid page lifetime", () => {
  // A disposed page must not keep watching: its access timer (the ISS-0032 quick retry or the
  // freshness refresh) and storage listeners would otherwise keep messaging the background after
  // the page is gone, and in a shared test runtime they land in the next test's browser fixture.
  it("stops observing access and settings once its owner disposes the controller", async () => {
    vi.useFakeTimers();
    try {
      const f = await browser();
      const original = chrome.runtime.sendMessage;
      const observed = vi.fn();
      Object.assign(chrome.runtime, {
        sendMessage: vi.fn(async (message: { kind?: string }) => {
          // An unanswered observation arms the quick retry, so a live page keeps asking.
          if (message.kind === "observeBenefits") { observed(); return { ok: false }; }
          return original(message);
        }),
      });
      let binding: { stop(): void } | undefined;
      const controller = createExtensionUiController(purchase().deps, {
        accessHost: "chromium",
        onCommittedPopupBinding: (b) => { binding = b; },
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(observed.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(controller.settings.globalOn).toBe(true);
      binding!.stop();
      controller.dispose();
      const seen = observed.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      await chrome.storage.local.set({ "still:entitlement": { entitled: true, updatedAt: Date.now(), access: undefined } });
      const saved = f.store["still:settings"] as { settings: { globalOn: boolean } };
      await f.external({ ...saved, settings: { ...saved.settings, globalOn: false } } as Parameters<typeof f.external>[0]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(observed).toHaveBeenCalledTimes(seen);
      expect(controller.settings.globalOn).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
