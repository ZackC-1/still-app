import { describe, expect, it, vi } from "vitest";
import { InMemoryEntitlementAdapter } from "../../entitlement/adapter.js";
import type { EntitlementRecord, EntitlementRecordStore } from "../../entitlement/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { UiController } from "../../ui/controller.svelte.js";
import { createAppleSession } from "../apple-session.js";
import {
  createExtensionSession,
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

// The teardown-parity CONTRACT (plan R3/U3): ONE shared suite run against BOTH session
// orchestrators, pinning the invariants their comments promise ("teardown parity",
// "server-first", "apple-session parity") but which no single test asserted across the pair:
//   (a) a failed account delete leaves the session intact — no local purge, no signed-out state
//       (never appear signed out while the account still exists);
//   (b) a VOLUNTARY sign-out completes the local purge/signed-out transition even when the remote
//       sign-out rejects (the user asked to leave; offline must not trap them signed-in);
//   (c) neither path throws to its caller-facing surface;
//   (d) neither path erases the record of who last synced on this device. The shared-machine rule
//       exists for the moment AFTER someone signs out, so the two hosts must not drift on it.
// The orchestrators are NOT merged (their purge mechanics genuinely differ: App-Group mirror vs
// record store + browser-scoped purges) — only the observable teardown contract is shared, via a
// per-orchestrator adapter over the same wiring production uses. Each adapter's local-state
// predicates read that host's own truth: the controller for the WKWebView app, the purge
// side-effects for the extension background.

interface FailureModes {
  /** The remote half of a voluntary sign-out rejects (offline / revoked token). */
  readonly remoteSignOutRejects?: boolean;
  /** The backend account delete rejects (server-first: nothing local may move). */
  readonly deleteRejects?: boolean;
}

interface TeardownHarness {
  signOut(): Promise<void>;
  deleteAccount(): Promise<void>;
  /** The voluntary-exit terminal state landed locally: signed out + entitlement downgraded. */
  isSignedOutLocally(): boolean;
  /** Session and local grant both survived (what a failed delete must leave behind). */
  sessionIntact(): boolean;
  /** Who this device records as the last person to sync here, after the teardown ran. Both
   * orchestrators must still answer "u1": erasing it would let the next person to sign in on a
   * shared machine carry the previous person's settings into their own account. */
  lastSyncedIdentity(): Promise<string | null>;
}

const T0 = 1_700_000_000_000;

// ── Apple (WKWebView app) ────────────────────────────────────────────────────────────────────────
// Wired the way the app-webview entrypoint wires it: UiAuth closures over the session's
// *Everywhere methods, judged at the controller. That IS the apple caller-facing surface for (c):
// deleteAccountEverywhere deliberately throws on a backend failure ("UI surfaces it, session
// intact" — apple-session.ts) and controller.confirmDeleteAccount is the layer that absorbs it;
// same for signOutEverywhere and controller.signOut.

function appleHarness(fail: FailureModes = {}): TeardownHarness {
  const cache = new SettingsCache(new InMemoryStorageAdapter(null), { now: () => Date.now() });
  const controller = new UiController({
    cache,
    host: { canPurchase: true },
    auth: {
      signOut: () => session.signOutEverywhere(),
      deleteAccount: () => session.deleteAccountEverywhere(),
    },
  });
  const sync = {
    onSignedIn: vi.fn(async () => {}),
    signOut: fail.remoteSignOutRejects
      ? vi.fn(async () => {
          throw new Error("offline");
        })
      : vi.fn(async () => {
          session.onSyncState({
            userId: null,
            entitled: false,
            syncing: false,
            cloudReachable: true,
            confirmed: true,
          });
        }),
    deleteAccount: fail.deleteRejects
      ? vi.fn(async () => {
          throw new Error("backend");
        })
      : vi.fn(async () => {}),
  };
  // bridge.available false: the native RevenueCat leg is out of scope here — its best-effort
  // semantics are pinned in apple-session.test.ts; this suite pins the shared contract. NOTE the
  // Apple contract forked with purchase-first (plan 2026-07-15-001): "signed out locally" means
  // the ACCOUNT-derived state is torn down — a device with receipt-proven Pro legitimately keeps
  // it (pinned in apple-session.test.ts "receipt Pro survives sign-out"); this harness has no
  // receipt (noSignal), so the pre-fork predicate still holds verbatim.
  const session = createAppleSession({
    controller,
    sync,
    bridge: {
      available: false,
      signInWithApple: vi.fn(async () => ({ identityToken: "tok", nonce: "n" })),
      configurePurchases: vi.fn(async () => {}),
      purchaseStillPro: vi.fn(async () => ({ outcome: "purchased" as const, entitled: true })),
      restore: vi.fn(async () => false),
      receiptStatus: vi.fn(async () => "noSignal" as const),
      attachPurchases: vi.fn(async () => false),
      price: vi.fn(async () => null),
      signOut: vi.fn(async () => {}),
      setEntitlement: vi.fn(async () => {}),
    },
    exchangeAppleCredential: async () => ({ userId: "u1" }),
  });

  // Signed-in, entitled baseline — the state a teardown must (sign-out) or must not (failed
  // delete) tear down.
  controller.userId = "u1";
  controller.entitled = true;

  // The Apple host keeps the last-synced identity in its own storage (app-webview wiring) and hands
  // it to SyncService; the session never reaches it, which is exactly the property under test.
  const identity = appleIdentityStore();

  return {
    signOut: () => controller.signOut(),
    deleteAccount: () => controller.confirmDeleteAccount(),
    isSignedOutLocally: () => controller.userId === null && !controller.entitled,
    sessionIntact: () => controller.userId === "u1" && controller.entitled,
    lastSyncedIdentity: () => identity.get(),
  };
}

/** A stand-in for the Apple host's persisted last-synced identity, seeded as already synced. */
function appleIdentityStore(): { get(): Promise<string | null> } {
  const lastSynced: string | null = "u1";
  return { get: async () => lastSynced };
}

// ── Extension (Chromium background) ──────────────────────────────────────────────────────────────
// The extension-session.test.ts harness pattern, trimmed to the teardown surface: mocked ports, a
// real SyncService, the in-memory record store, and write/side-effect logs the predicates read.
// Its local-signed-out truth is the purge itself (record downgraded to an explicit entitled:false,
// identity forgotten, persisted auth session removed) — NOT the fake's in-memory session flag: a
// rejected remote revoke leaves auth-js's session server-side, and clearAuthStorage removing the
// persisted copy is exactly the offline-proof pin (F1).

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

function extensionHarness(fail: FailureModes = {}): TeardownHarness {
  const now = () => T0;
  let sessionUser: string | null = "u1";

  const auth = {
    signInWithMagicLink: vi.fn(async () => ({})),
    signOut: fail.remoteSignOutRejects
      ? vi.fn(async () => {
          throw new Error("offline"); // server revoke failed — the remote session survives
        })
      : vi.fn(async () => {
          sessionUser = null;
        }),
    currentUserId: vi.fn(async () => sessionUser),
    requestCode: vi.fn(async (): Promise<RequestCodeOutcome> => ({ kind: "sent" })),
    verifyCode: vi.fn(async (): Promise<VerifyCodeOutcome> => ({ kind: "verified", userId: "u1" })),
  };

  const backend = {
    reconcileEntitlement: vi.fn(async () => {}),
    reconcileEntitlementChecked: vi.fn(async (): Promise<ReconcileCallOutcome> => "ok"),
    readEntitlement: vi.fn(async (): Promise<EntitlementRead> => "entitled"),
    readProfile: vi.fn(async () => null),
    writeProfile: vi.fn(async (settings) => ({
      settings,
      version: 1,
      serverUpdatedAt: new Date(T0).toISOString(),
      lastWriteId: null,
    })),
    subscribeToProfile: vi.fn(() => vi.fn()),
    deleteAccount: fail.deleteRejects
      ? vi.fn(async () => {
          throw new Error("backend");
        })
      : vi.fn(async () => {}),
    createWebCheckout: vi.fn(
      async (): Promise<WebCheckoutOutcome> => ({ kind: "checkout-url", url: "https://pay.rev.cat/t/u1" }),
    ),
  };

  // Entitled baseline in the record store, with a write log over it for the predicates.
  const inner = new InMemoryEntitlementAdapter(true, now);
  const recordWrites: EntitlementRecord[] = [];
  const records: EntitlementRecordStore = {
    getRecord: (sessionUserId?: string) => inner.getRecord(sessionUserId),
    setRecord: async (record) => {
      recordWrites.push(record);
      await inner.setRecord(record);
    },
  };

  let lastSynced: string | null = "u1"; // a previously-synced identity, which teardown must keep
  const identity = {
    get: vi.fn(async () => lastSynced),
    set: vi.fn(async (userId: string) => {
      lastSynced = userId;
    }),
  };

  const cache = new SettingsCache(new InMemoryStorageAdapter(null), { now });
  const sync = new SyncService(cache, auth, backend, undefined, identity);
  const clearAuthStorage = vi.fn(async () => {});

  const session = createExtensionSession({
    auth,
    backend,
    records,
    sync,
    identity,
    stores: {
      pendingOtp: makeSlot<PendingOtpRecord>(null),
      checkoutPending: makeSlot<CheckoutPendingRecord>(null),
      nudgeStamp: makeSlot<number>(null),
    },
    closeTab: vi.fn(async () => {}),
    clearAuthStorage,
    now,
  });

  const purged = () => recordWrites.some((r) => r.entitled === false);
  return {
    signOut: async () => {
      await session.signOut();
    },
    deleteAccount: async () => {
      await session.deleteAccount();
    },
    isSignedOutLocally: () => purged() && clearAuthStorage.mock.calls.length > 0,
    sessionIntact: () => sessionUser === "u1" && !purged(),
    lastSyncedIdentity: () => identity.get(),
  };
}

// ── The shared contract ──────────────────────────────────────────────────────────────────────────

const orchestrators = [
  { name: "apple-session (WKWebView wiring)", build: appleHarness },
  { name: "extension-session (background wiring)", build: extensionHarness },
] as const;

describe.each(orchestrators)("teardown parity — $name", ({ build }) => {
  it("(a)+(c) a failed account delete leaves the session intact: no purge, no signed-out state, no throw", async () => {
    const h = build({ deleteRejects: true });
    await expect(h.deleteAccount()).resolves.toBeUndefined(); // (c): surfaced calmly, never thrown
    expect(h.sessionIntact()).toBe(true);
    expect(h.isSignedOutLocally()).toBe(false);
  });

  it("(b)+(c) voluntary sign-out lands the LOCAL purge even when the remote sign-out rejects, without throwing", async () => {
    const h = build({ remoteSignOutRejects: true });
    await expect(h.signOut()).resolves.toBeUndefined(); // (c)
    expect(h.isSignedOutLocally()).toBe(true);
  });

  it("neither exit forgets who last synced on this device (the shared-machine rule outlives sign-out)", async () => {
    const signedOut = build();
    await signedOut.signOut();
    expect(await signedOut.lastSyncedIdentity()).toBe("u1");

    const deleted = build();
    await deleted.deleteAccount();
    expect(await deleted.lastSyncedIdentity()).toBe("u1");
  });

  it("baseline: the happy paths reach the same terminal states on both orchestrators", async () => {
    const signedOut = build();
    await signedOut.signOut();
    expect(signedOut.isSignedOutLocally()).toBe(true);

    const deleted = build();
    await deleted.deleteAccount();
    expect(deleted.isSignedOutLocally()).toBe(true);
    expect(deleted.sessionIntact()).toBe(false);
  });
});
