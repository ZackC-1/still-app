import { describe, expect, it, vi } from "vitest";
import { InMemoryEntitlementAdapter } from "../../entitlement/adapter.js";
import type { EntitlementRecord, EntitlementRecordStore } from "../../entitlement/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import {
  createExtensionSession,
  NUDGE_STALENESS_MS,
  NUDGE_THROTTLE_MS,
  type CheckoutPendingRecord,
  type PendingOtpRecord,
  type PersistedSlot,
} from "../extension-session.js";
import type {
  EntitlementRead,
  ReconcileCallOutcome,
  RequestCodeOutcome,
  VerifyCodeOutcome,
  WebCheckoutOutcome,
} from "../ports.js";
import { SyncService } from "../service.js";

// The extension-session money-flow branches (plan U5), with the same discipline as
// apple-session.test.ts: in-memory fakes, an injected clock, and every entitlement-cache write
// asserted. The harness wires a REAL SyncService over the mocked ports so "sync started" means a
// settings edit actually reaches writeProfile — not a fake's say-so.

const T0 = 1_700_000_000_000;

function makeSlot<T>(initial: unknown = null): PersistedSlot<T> & { value: unknown } {
  const slot = {
    value: initial,
    get: async () => slot.value,
    set: async (v: T | null) => {
      slot.value = v;
    },
  };
  return slot;
}

interface HarnessOpts {
  /** The session user `currentUserId` reports; null = signed out. Defaults to "u1". */
  readonly sessionUser?: string | null;
  readonly read?: EntitlementRead;
  readonly checked?: ReconcileCallOutcome;
  readonly checkout?: WebCheckoutOutcome;
  readonly verify?: VerifyCodeOutcome;
  readonly pendingOtpValue?: unknown;
  readonly checkoutPendingValue?: unknown;
  readonly nudgeStampValue?: unknown;
}

function harness(opts: HarnessOpts = {}) {
  let nowMs = T0;
  const now = () => nowMs;
  const advance = (ms: number) => {
    nowMs += ms;
  };

  let sessionUser: string | null = opts.sessionUser === undefined ? "u1" : opts.sessionUser;

  // Cross-dependency ordering log — the identity-switch pin asserts A's downgrade lands BEFORE
  // B's reconcile.
  const events: string[] = [];

  const auth = {
    signInWithMagicLink: vi.fn(async () => ({})),
    signOut: vi.fn(async () => {
      sessionUser = null;
    }),
    currentUserId: vi.fn(async () => sessionUser),
    requestCode: vi.fn(async (): Promise<RequestCodeOutcome> => ({ kind: "sent" })),
    verifyCode: vi.fn(async (): Promise<VerifyCodeOutcome> => {
      const outcome = opts.verify ?? { kind: "verified", userId: "u1" };
      if (outcome.kind === "verified") sessionUser = outcome.userId;
      return outcome;
    }),
  };

  const backend = {
    reconcileEntitlement: vi.fn(async () => {
      events.push("reconcile");
    }),
    reconcileEntitlementChecked: vi.fn(async (): Promise<ReconcileCallOutcome> => {
      events.push("reconcile");
      return opts.checked ?? "ok";
    }),
    readEntitlement: vi.fn(async (): Promise<EntitlementRead> => opts.read ?? "entitled"),
    readProfile: vi.fn(async () => null),
    writeProfile: vi.fn(async () => {}),
    deleteAccount: vi.fn(async () => {}),
    createWebCheckout: vi.fn(
      async (): Promise<WebCheckoutOutcome> =>
        opts.checkout ?? { kind: "checkout-url", url: "https://pay.rev.cat/t/u1" },
    ),
  };

  // The real in-memory record store underneath (its setRecord notifies subscribers — the U1
  // contract the teardown pin relies on), with a write log layered over it for the session.
  const inner = new InMemoryEntitlementAdapter(null, now);
  const recordWrites: EntitlementRecord[] = [];
  const records: EntitlementRecordStore = {
    getRecord: (sessionUserId?: string) => inner.getRecord(sessionUserId),
    setRecord: async (record) => {
      recordWrites.push(record);
      events.push(`record:${String(record.entitled)}`);
      await inner.setRecord(record);
    },
  };
  const entitledNotifications: boolean[] = [];
  inner.subscribe((entitled) => entitledNotifications.push(entitled));

  let lastSynced: string | null = null;
  const identity = {
    get: vi.fn(async () => lastSynced),
    set: vi.fn(async (userId: string) => {
      lastSynced = userId;
    }),
    clear: vi.fn(async () => {
      lastSynced = null;
    }),
  };

  const cache = new SettingsCache(new InMemoryStorageAdapter(null), { now });
  const sync = new SyncService(cache, auth, backend, undefined, identity);

  const pendingOtp = makeSlot<PendingOtpRecord>(opts.pendingOtpValue ?? null);
  const checkoutPending = makeSlot<CheckoutPendingRecord>(opts.checkoutPendingValue ?? null);
  const nudgeStamp = makeSlot<number>(opts.nudgeStampValue ?? null);
  const closeTab = vi.fn(async () => {});
  const clearAuthStorage = vi.fn(async () => {});

  const session = createExtensionSession({
    auth,
    backend,
    records,
    sync,
    identity,
    stores: { pendingOtp, checkoutPending, nudgeStamp },
    closeTab,
    clearAuthStorage,
    now,
  });

  return {
    session,
    auth,
    backend,
    inner,
    recordWrites,
    entitledNotifications,
    identity,
    cache,
    sync,
    pendingOtp,
    checkoutPending,
    nudgeStamp,
    closeTab,
    clearAuthStorage,
    events,
    advance,
    setSessionUser: (userId: string | null) => {
      sessionUser = userId;
    },
    seedIdentity: (userId: string) => {
      lastSynced = userId;
    },
  };
}

describe("ExtensionSession — verifyCode (the sign-in money path)", () => {
  it("entitled: reconcile-before-read, record written with userId, write-through starts (R9)", async () => {
    const h = harness({ sessionUser: null });
    const outcome = await h.session.verifyCode("a@still.app", "123456");
    expect(outcome).toEqual({ kind: "verified", userId: "u1" });
    expect(h.backend.reconcileEntitlement).toHaveBeenCalledTimes(1); // onSignedIn's self-heal
    expect(h.recordWrites).toContainEqual({ entitled: true, userId: "u1", updatedAt: T0 });
    // Sync started: a local settings edit reaches the cloud through the real SyncService.
    await h.cache.setGlobalOn(false);
    expect(h.backend.writeProfile).toHaveBeenCalledTimes(1);
  });

  it("not entitled: record written explicit false, signed in but NO sync (R7/R9)", async () => {
    const h = harness({ sessionUser: null, read: "not-entitled" });
    await h.session.verifyCode("a@still.app", "123456");
    expect(h.recordWrites).toContainEqual({ entitled: false, userId: "u1", updatedAt: T0 });
    await h.cache.setGlobalOn(false);
    expect(h.backend.writeProfile).not.toHaveBeenCalled();
  });

  it("unknown (offline read): NO record write — never write on couldn't-read (AE6)", async () => {
    const h = harness({ sessionUser: null, read: "unknown" });
    await h.session.verifyCode("a@still.app", "123456");
    expect(h.recordWrites).toHaveLength(0);
  });

  it("reconcile throwing during sign-in: no record write, outcome still verified", async () => {
    const h = harness({ sessionUser: null });
    h.backend.reconcileEntitlement.mockRejectedValueOnce(new Error("net"));
    const outcome = await h.session.verifyCode("a@still.app", "123456");
    expect(outcome).toEqual({ kind: "verified", userId: "u1" });
    expect(h.recordWrites).toHaveLength(0);
  });

  it("success clears the persisted OTP record (code consumed)", async () => {
    const h = harness({
      sessionUser: null,
      pendingOtpValue: { email: "a@still.app", requestedAt: T0 },
    });
    await h.session.verifyCode("a@still.app", "123456");
    expect(h.pendingOtp.value).toBe(null);
  });

  it("a wrong code leaves the persisted OTP record for retry/rehydration (AE2)", async () => {
    const h = harness({
      sessionUser: null,
      verify: { kind: "invalid-code" },
      pendingOtpValue: { email: "a@still.app", requestedAt: T0 },
    });
    const outcome = await h.session.verifyCode("a@still.app", "000000");
    expect(outcome).toEqual({ kind: "invalid-code" });
    expect(h.pendingOtp.value).toEqual({ email: "a@still.app", requestedAt: T0 });
  });
});

describe("ExtensionSession — identity switch (AE5)", () => {
  it("verifyCode as B after entitled A: A's grant + pending purged BEFORE B's reconcile", async () => {
    const h = harness({ sessionUser: null, verify: { kind: "verified", userId: "B" } });
    h.seedIdentity("A");
    await h.inner.setRecord({ entitled: true, userId: "A", updatedAt: T0 });
    h.checkoutPending.value = { startedAt: T0, tabId: 7 };

    await h.session.verifyCode("b@still.app", "123456");

    // The downgrade write (A's cache reset) precedes B's reconcile — nothing of B's landed first.
    expect(h.events.indexOf("record:false")).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf("record:false")).toBeLessThan(h.events.indexOf("reconcile"));
    // A's checkout tab is closed (it still carries A's identity) and the pending flag is gone.
    expect(h.closeTab).toHaveBeenCalledWith(7);
    expect(h.checkoutPending.value).toBe(null);
    expect(h.identity.clear).toHaveBeenCalled();
    // B's own definitive answer lands after, bound to B.
    expect(h.recordWrites.at(-1)).toEqual({ entitled: true, userId: "B", updatedAt: T0 });
  });

  it("a free user re-signing in after an involuntary 401 keeps their own pending purchase (U4 continuation)", async () => {
    const h = harness({ sessionUser: null, read: "not-entitled" });
    await h.inner.setRecord({ entitled: false, userId: "u1", updatedAt: T0 });
    h.checkoutPending.value = { startedAt: T0 };

    await h.session.verifyCode("a@still.app", "123456");

    expect(h.checkoutPending.value).toEqual({ startedAt: T0 });
    expect(h.closeTab).not.toHaveBeenCalled();
    expect(h.identity.clear).not.toHaveBeenCalled();
  });
});

describe("ExtensionSession — reconcile / restore", () => {
  it("definitive entitled: record rewritten with a fresh updatedAt, pending cleared (R7/AE3)", async () => {
    const h = harness({ checkoutPendingValue: { startedAt: T0 } });
    h.advance(1000);
    const outcome = await h.session.reconcile();
    expect(outcome).toBe("entitled");
    expect(h.recordWrites.at(-1)).toEqual({ entitled: true, userId: "u1", updatedAt: T0 + 1000 });
    // The plan's sequence: "write cache, clear pending" — background-side, the popup may never open.
    expect(h.checkoutPending.value).toBe(null);
  });

  it("explicit not-entitled: record written false, subscribers notified (refund downgrade)", async () => {
    const h = harness({ read: "not-entitled" });
    const outcome = await h.session.reconcile();
    expect(outcome).toBe("not-entitled");
    expect(h.recordWrites.at(-1)).toEqual({ entitled: false, userId: "u1", updatedAt: T0 });
    expect(h.entitledNotifications).toContain(false);
  });

  it("unavailable (offline): unknown, no write, no read (AE6)", async () => {
    const h = harness({ checked: "unavailable" });
    expect(await h.session.reconcile()).toBe("unknown");
    expect(h.recordWrites).toHaveLength(0);
    expect(h.backend.readEntitlement).not.toHaveBeenCalled();
  });

  it("401 → auth-required: cache and pending untouched, NO teardown (KTD)", async () => {
    const h = harness({ checked: "auth-required", checkoutPendingValue: { startedAt: T0 } });
    await h.inner.setRecord({ entitled: true, userId: "u1", updatedAt: T0 });
    expect(await h.session.reconcile()).toBe("auth-required");
    expect(h.recordWrites).toHaveLength(0);
    expect(h.checkoutPending.value).toEqual({ startedAt: T0 });
    expect(h.auth.signOut).not.toHaveBeenCalled();
    expect(h.identity.clear).not.toHaveBeenCalled();
  });

  it("signed out: signed-out outcome, no backend call", async () => {
    const h = harness({ sessionUser: null });
    expect(await h.session.reconcile()).toBe("signed-out");
    expect(h.backend.reconcileEntitlementChecked).not.toHaveBeenCalled();
  });

  it("restore() is the same reconcile spine (the web Restore button, R5)", async () => {
    const h = harness();
    expect(await h.session.restore()).toBe("entitled");
    expect(h.recordWrites.at(-1)).toEqual({ entitled: true, userId: "u1", updatedAt: T0 });
  });
});

describe("ExtensionSession — createCheckout", () => {
  it("200: passes checkout-url through; the pending flag is the controller's to persist (U4 split)", async () => {
    const h = harness();
    const outcome = await h.session.createCheckout();
    expect(outcome).toEqual({ kind: "checkout-url", url: "https://pay.rev.cat/t/u1" });
    expect(h.checkoutPending.value).toBe(null);
    expect(h.backend.reconcileEntitlementChecked).not.toHaveBeenCalled();
  });

  it("409: reconcile runs and the cache write lands BEFORE the already-entitled outcome returns (R5/AE4)", async () => {
    const h = harness({ checkout: { kind: "already-entitled" } });
    const outcome = await h.session.createCheckout();
    expect(outcome).toEqual({ kind: "already-entitled" });
    expect(h.backend.reconcileEntitlementChecked).toHaveBeenCalledTimes(1);
    expect(h.recordWrites.at(-1)).toEqual({ entitled: true, userId: "u1", updatedAt: T0 });
  });

  it("401: auth-required passthrough — cache and pending untouched (re-sign-in, not teardown)", async () => {
    const h = harness({
      checkout: { kind: "auth-required" },
      checkoutPendingValue: { startedAt: T0 },
    });
    await h.inner.setRecord({ entitled: true, userId: "u1", updatedAt: T0 });
    const outcome = await h.session.createCheckout();
    expect(outcome).toEqual({ kind: "auth-required" });
    expect(h.recordWrites).toHaveLength(0);
    expect(h.checkoutPending.value).toEqual({ startedAt: T0 });
  });
});

describe("ExtensionSession — onNudge (content-script reconcile nudge, R4)", () => {
  it("no session → no-op, no backend call", async () => {
    const h = harness({ sessionUser: null });
    expect(await h.session.onNudge()).toBe("no-op");
    expect(h.backend.reconcileEntitlementChecked).not.toHaveBeenCalled();
  });

  it("pending flag set → one reconcile; the throttle holds across a second nudge", async () => {
    const h = harness({ read: "not-entitled", checkoutPendingValue: { startedAt: T0 } });
    expect(await h.session.onNudge()).toBe("reconciled");
    expect(h.backend.reconcileEntitlementChecked).toHaveBeenCalledTimes(1);
    h.advance(NUDGE_THROTTLE_MS - 1);
    expect(await h.session.onNudge()).toBe("throttled");
    expect(h.backend.reconcileEntitlementChecked).toHaveBeenCalledTimes(1);
    h.advance(2); // past the 6h window
    expect(await h.session.onNudge()).toBe("reconciled");
    expect(h.backend.reconcileEntitlementChecked).toHaveBeenCalledTimes(2);
  });

  it("fresh cache (younger than NUDGE_STALENESS_MS) + no pending → no-op", async () => {
    const h = harness();
    await h.inner.setRecord({ entitled: true, userId: "u1", updatedAt: T0 });
    h.advance(NUDGE_STALENESS_MS - 1);
    expect(await h.session.onNudge()).toBe("no-op");
    expect(h.backend.reconcileEntitlementChecked).not.toHaveBeenCalled();
  });

  it("cache older than NUDGE_STALENESS_MS → reconcile (refund revocation ≤ ~24h online)", async () => {
    const h = harness();
    await h.inner.setRecord({ entitled: true, userId: "u1", updatedAt: T0 });
    h.advance(NUDGE_STALENESS_MS);
    expect(await h.session.onNudge()).toBe("reconciled");
    expect(h.backend.reconcileEntitlementChecked).toHaveBeenCalledTimes(1);
  });

  it("two CONCURRENT nudges (session-restore burst) → exactly one reconcile", async () => {
    const h = harness({ read: "not-entitled", checkoutPendingValue: { startedAt: T0 } });
    let release!: (v: ReconcileCallOutcome) => void;
    h.backend.reconcileEntitlementChecked.mockImplementationOnce(
      () =>
        new Promise<ReconcileCallOutcome>((resolve) => {
          release = resolve;
        }),
    );
    const first = h.session.onNudge();
    const second = h.session.onNudge(); // in flight before the first's reconcile resolves
    await vi.waitFor(() => expect(h.backend.reconcileEntitlementChecked).toHaveBeenCalledTimes(1));
    release("ok");
    expect(await first).toBe("reconciled");
    expect(await second).toBe("throttled");
    expect(h.backend.reconcileEntitlementChecked).toHaveBeenCalledTimes(1);
  });

  it("a non-definitive reconcile (offline → unknown) rolls the throttle stamp back — no 6h mute (F4)", async () => {
    const h = harness({ checked: "unavailable", checkoutPendingValue: { startedAt: T0 } });
    expect(await h.session.onNudge()).toBe("reconciled");
    // The stamp was written before the await, then rolled back to its prior value (null) because
    // the reconcile couldn't confirm — the next nudge must not be muted for 6h.
    expect(h.nudgeStamp.value).toBe(null);
    expect(await h.session.onNudge()).toBe("reconciled");
    expect(h.backend.reconcileEntitlementChecked).toHaveBeenCalledTimes(2);
  });
});

describe("ExtensionSession — resume (background wake, R2 hard rule)", () => {
  it("entitled cache: a settings edit reaches writeProfile with ZERO reconcile calls", async () => {
    const h = harness();
    await h.inner.setRecord({ entitled: true, userId: "u1", updatedAt: T0 });
    expect(await h.session.resume()).toBe("resumed-entitled");
    await h.cache.setGlobalOn(false);
    expect(h.backend.writeProfile).toHaveBeenCalledTimes(1);
    expect(h.backend.reconcileEntitlement).not.toHaveBeenCalled();
    expect(h.backend.reconcileEntitlementChecked).not.toHaveBeenCalled();
  });

  it("free cache: resumed without write-through (no RC query either)", async () => {
    const h = harness();
    await h.inner.setRecord({ entitled: false, userId: "u1", updatedAt: T0 });
    expect(await h.session.resume()).toBe("resumed-free");
    await h.cache.setGlobalOn(false);
    expect(h.backend.writeProfile).not.toHaveBeenCalled();
  });

  it("a record bound to another user reads as no cache (R8): resumes free", async () => {
    const h = harness();
    await h.inner.setRecord({ entitled: true, userId: "A", updatedAt: T0 });
    expect(await h.session.resume()).toBe("resumed-free");
  });

  it("no persisted session → signed-out, gracefully", async () => {
    const h = harness({ sessionUser: null });
    expect(await h.session.resume()).toBe("signed-out");
  });
});

describe("ExtensionSession — teardown parity (voluntary sign-out / delete, R8)", () => {
  /** Both exits must land the SAME local purge — asserted for each (the shared-helper pin). */
  function expectFullTeardown(h: ReturnType<typeof harness>): void {
    expect(h.recordWrites.at(-1)).toEqual({ entitled: false, updatedAt: T0 });
    expect(h.entitledNotifications).toContain(false); // explicit write — subscribers fire
    expect(h.pendingOtp.value).toBe(null);
    expect(h.checkoutPending.value).toBe(null);
    expect(h.nudgeStamp.value).toBe(null);
    expect(h.closeTab).toHaveBeenCalledWith(7);
    expect(h.identity.clear).toHaveBeenCalled();
    expect(h.clearAuthStorage).toHaveBeenCalled(); // offline-proof session removal (F1)
  }

  function seededHarness(): ReturnType<typeof harness> {
    const h = harness({
      pendingOtpValue: { email: "a@still.app", requestedAt: T0 },
      checkoutPendingValue: { startedAt: T0, tabId: 7 },
      nudgeStampValue: T0,
    });
    h.seedIdentity("u1");
    return h;
  }

  it("signOut: auth signed out + the full local purge", async () => {
    const h = seededHarness();
    await h.inner.setRecord({ entitled: true, userId: "u1", updatedAt: T0 });
    expect(await h.session.signOut()).toBe("signed-out");
    expect(h.auth.signOut).toHaveBeenCalled();
    expectFullTeardown(h);
  });

  it("signOut with a rejected auth sign-out still lands the local purge (voluntary exit)", async () => {
    const h = seededHarness();
    h.auth.signOut.mockRejectedValueOnce(new Error("offline"));
    expect(await h.session.signOut()).toBe("signed-out");
    expectFullTeardown(h);
  });

  it("deleteAccount: backend delete first, then the SAME purge (parity pin)", async () => {
    const h = seededHarness();
    await h.inner.setRecord({ entitled: true, userId: "u1", updatedAt: T0 });
    expect(await h.session.deleteAccount()).toBe("deleted");
    expect(h.backend.deleteAccount).toHaveBeenCalled();
    expectFullTeardown(h);
  });

  it("a failed backend delete keeps the session AND the local state intact (server-first)", async () => {
    const h = seededHarness();
    h.backend.deleteAccount.mockRejectedValueOnce(new Error("backend"));
    expect(await h.session.deleteAccount()).toBe("delete-failed");
    expect(h.recordWrites).toHaveLength(0);
    expect(h.checkoutPending.value).toEqual({ startedAt: T0, tabId: 7 });
    expect(h.auth.signOut).not.toHaveBeenCalled();
    expect(h.identity.clear).not.toHaveBeenCalled();
  });

  it("a sign-out that lands DURING an in-flight reconcile is not overwritten by a stale entitled write (F2)", async () => {
    const h = harness({ read: "entitled" });
    // The reconcile's entitlement read resolves only after a concurrent sign-out has run its full
    // teardown — the TOCTOU window. Without the generation guard the reconcile would re-write
    // entitled:true after teardown wrote entitled:false, resurrecting Pro for a signed-out browser.
    h.backend.readEntitlement.mockImplementationOnce(async () => {
      await h.session.signOut();
      return "entitled";
    });
    const outcome = await h.session.reconcile();
    expect(outcome).toBe("signed-out"); // the reconcile bails at the post-await guard
    expect(h.recordWrites.at(-1)).toEqual({ entitled: false, updatedAt: T0 }); // teardown's write wins
    expect(h.recordWrites.filter((r) => r.entitled === true)).toHaveLength(0);
  });
});

describe("ExtensionSession — requestCode + purchase-intent continuation", () => {
  it("requestCode persists the pending-OTP record for popup-death rehydration (AE2)", async () => {
    const h = harness({ sessionUser: null });
    expect(await h.session.requestCode("a@still.app")).toEqual({ kind: "sent" });
    expect(h.pendingOtp.value).toEqual({ email: "a@still.app", requestedAt: T0 });
  });

  it("a send failure persists nothing", async () => {
    const h = harness({ sessionUser: null });
    h.auth.requestCode.mockResolvedValueOnce({ kind: "send-failed" });
    expect(await h.session.requestCode("a@still.app")).toEqual({ kind: "send-failed" });
    expect(h.pendingOtp.value).toBe(null);
  });

  it("purchase intent staged before the code request rides the persisted record (AE1)", async () => {
    const h = harness({ sessionUser: null });
    await h.session.setPurchaseIntent(true);
    await h.session.requestCode("a@still.app");
    expect(h.pendingOtp.value).toEqual({
      email: "a@still.app",
      requestedAt: T0,
      purchaseIntent: true,
    });
    // Deliberate withdrawal strips the flag from the persisted record.
    await h.session.setPurchaseIntent(false);
    expect(h.pendingOtp.value).toEqual({ email: "a@still.app", requestedAt: T0 });
  });

  it("setPendingOtp(null) clears the record (deliberate 'Not now' dismiss)", async () => {
    const h = harness({
      sessionUser: null,
      pendingOtpValue: { email: "a@still.app", requestedAt: T0, purchaseIntent: true },
    });
    await h.session.setPendingOtp(null);
    expect(h.pendingOtp.value).toBe(null);
  });
});

describe("ExtensionSession — getState (the popup's mount snapshot)", () => {
  it("returns userId, entitlement, and both persisted records", async () => {
    const h = harness({
      pendingOtpValue: { email: "a@still.app", requestedAt: T0, purchaseIntent: true },
      checkoutPendingValue: { startedAt: T0, tabId: 7 },
    });
    await h.inner.setRecord({ entitled: true, userId: "u1", updatedAt: T0 });
    expect(await h.session.getState()).toEqual({
      userId: "u1",
      entitled: true,
      checkoutPending: { startedAt: T0, tabId: 7 },
      pendingOtp: { email: "a@still.app", requestedAt: T0, purchaseIntent: true },
    });
  });

  it("no session: signed-out snapshot, entitlement read like the content scripts see it (TTL rides)", async () => {
    const h = harness({ sessionUser: null });
    await h.inner.setRecord({ entitled: true, userId: "u1", updatedAt: T0 });
    expect(await h.session.getState()).toEqual({
      userId: null,
      entitled: true, // an involuntary session death never downgrades the cache (AE6)
      checkoutPending: null,
      pendingOtp: null,
    });
  });
});

describe("ExtensionSession — malformed persisted state (defensive boot)", () => {
  it("garbage slots read as absent: no throw across getState/resume/onNudge", async () => {
    const h = harness({
      pendingOtpValue: 42,
      checkoutPendingValue: "garbage",
      nudgeStampValue: "not-a-stamp",
    });
    const state = await h.session.getState();
    expect(state.pendingOtp).toBe(null);
    expect(state.checkoutPending).toBe(null);
    expect(await h.session.resume()).toBe("resumed-free");
    // No record + garbage stamp (reads as absent) → the nudge still self-heals via reconcile.
    expect(await h.session.onNudge()).toBe("reconciled");
  });

  it("a recognizable pending record with a garbage startedAt keeps flowing, field dropped (U4 expired-pending)", async () => {
    const h = harness({ checkoutPendingValue: { startedAt: "yesterday", tabId: 7 } });
    const state = await h.session.getState();
    expect(state.checkoutPending).toEqual({ tabId: 7 });
  });

  it("a pending OTP with a garbage requestedAt salvages the email", async () => {
    const h = harness({ pendingOtpValue: { email: "a@still.app", requestedAt: "noon" } });
    const state = await h.session.getState();
    expect(state.pendingOtp).toEqual({ email: "a@still.app" });
  });
});
