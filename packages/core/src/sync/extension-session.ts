import type { EntitlementRecordStore } from "../entitlement/cache.js";
import type {
  AuthPort,
  BackendPort,
  CheckedReconcilePort,
  CodeAuthPort,
  RequestCodeOutcome,
  VerifyCodeOutcome,
  WebCheckoutOutcome,
  WebCheckoutPort,
} from "./ports.js";
import type { LastSyncedIdentityStore, SyncService } from "./service.js";

// The extension-session orchestrator (plan U5) — the Chromium half of the entitlement lane
// (CONTEXT.md): the background context owns the Supabase session, the authenticated reconcile→
// cache writes, the checkout-pending lifecycle, the content-script nudge, the sync lifecycle, and
// the shared voluntary teardown. Mirrors createAppleSession's shape: a factory over injected deps
// so every money-flow branch is unit-testable; the WXT background entrypoint (U6) stays thin
// wiring — it builds the deps, registers the message router (with sender validation: privileged
// handlers only for extension-page senders; content scripts reach only the onNudge nudge), and
// forwards messages here.
//
// Money-flow invariants owned by this module (R2/R4/R7/R8/R9):
//   • Definitive-write rule: the entitlement record is written only from an authenticated server
//     reconcile — explicit `false` included, `updatedAt` restamped even when unchanged (R7) —
//     and NEVER on an unknown/offline answer (AE6: the cache rides out its TTL).
//   • auth-required ≠ teardown: an involuntary 401 surfaces a re-sign-in and leaves the cache and
//     any checkout-pending flag untouched; only voluntary sign-out/delete downgrades.
//   • Teardown parity: sign-out and account deletion route through ONE shared purge — explicit
//     `entitled: false` write (subscribers only fire on a value), pendingOtp/checkoutPending/
//     intent/nudge-stamp cleared, the recorded checkout tab closed best-effort, identity forgotten.
//   • Identity switch (AE5): verifyCode as a different user purges the previous account's grant
//     and pending state BEFORE anything of the new user's lands — through the same purge helper.
//   • Wake resumes, never re-reconciles (R2 hard rule): resume() restarts the sync write-through
//     from the CACHED record with no network call; live reconcile stays on the R4 triggers
//     (popup open, qualifying nudge).
//   • Defensive boot: every persisted record parses garbage as absent — a corrupt slot can never
//     throw during startup or wedge a pending state (the chrome-adapter garbage-timestamp rule).
//
// Supabase client config contract (built in U6; recorded here because this module owns the
// session): ONE client, in the background only — `persistSession: true`,
// `detectSessionInUrl: false`, `autoRefreshToken: false` (token refresh is lazy: `getSession()`
// on wake) — over a chrome.storage.local-backed auth storage adapter under a distinct
// `storageKey` (trade-off accepted and documented in the plan's KTD).

/** The build-time Supabase trust config for the extension spine (U6). */
export interface ExtensionSupabaseConfig {
  readonly url: string;
  readonly anonKey: string;
}

/**
 * The build-mode trust gate for the WHOLE auth/purchase spine (plan KTD, fail-safe; the
 * ruleSetEndpointFromEnv pattern): both the background (client construction) and the popup/options
 * wiring (UI injection) gate on this one pure function, so an unconfigured build can never have a
 * live half. Absent/blank env → null → no Supabase client, no auth/checkout affordances, message
 * handlers answer their unavailable-style outcomes — NEVER a dev-endpoint fallback
 * (docs/solutions/security-issues/gate-production-trust-by-build-mode.md).
 */
export function extensionSupabaseConfig(
  url: string | undefined,
  anonKey: string | undefined,
): ExtensionSupabaseConfig | null {
  const trimmedUrl = url?.trim() ?? "";
  const trimmedKey = anonKey?.trim() ?? "";
  return trimmedUrl.length > 0 && trimmedKey.length > 0
    ? { url: trimmedUrl, anonKey: trimmedKey }
    : null;
}

/** A cached entitlement older than this makes a content-script nudge reconcile (R4). Distinct
 * from the 30-day fail-safe TTL (ENTITLEMENT_CACHE_TTL_MS): this bound keeps refund revocation
 * within ~24h for an online user who never opens the popup. */
export const NUDGE_STALENESS_MS = 24 * 60 * 60 * 1000; // 24h

/** Minimum spacing between nudge-triggered reconciles — every reconcile is a live RevenueCat
 * query server-side, and service pages fire nudges on every visit. */
export const NUDGE_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6h

/** The persisted pending-OTP record (R1/AE2): reopening the popup mid code-flow rehydrates code
 * entry from it. The purchase-intent continuation flag (AE1) rides the same record so a
 * locked-row-tap → sign-in flow survives popup death. */
export interface PendingOtpRecord {
  readonly email: string;
  readonly requestedAt?: number;
  readonly purchaseIntent?: boolean;
}

/** The persisted checkout-pending record (U4/R3), written by the popup controller BEFORE it opens
 * the checkout tab. `startedAt` is optional only on the read side: a garbage timestamp is dropped
 * in parsing and the controller then presents the record as expired-pending (U4's rule). */
export interface CheckoutPendingRecord {
  readonly startedAt?: number;
  readonly tabId?: number;
}

/** One persisted slot (chrome.storage-backed in U6, in-memory in tests). `get` returns the RAW
 * stored value: the session parses defensively, so implementations stay dumb JSON get/set and a
 * corrupt write can never throw during boot. */
export interface PersistedSlot<T> {
  get(): Promise<unknown>;
  set(value: T | null): Promise<void>;
}

export interface ExtensionSessionStores {
  readonly pendingOtp: PersistedSlot<PendingOtpRecord>;
  readonly checkoutPending: PersistedSlot<CheckoutPendingRecord>;
  /** ms epoch of the last nudge-triggered reconcile — the NUDGE_THROTTLE_MS stamp. */
  readonly nudgeStamp: PersistedSlot<number>;
}

/** The identity seam, widened with `clear` for teardown: a forgotten identity makes every later
 * sign-in read as cross-identity, so the cloud always wins over possibly-foreign local settings
 * (AE5). Extends U1's store so the same object feeds SyncService's seed guard. */
export interface ExtensionIdentityStore extends LastSyncedIdentityStore {
  clear(): Promise<void>;
}

/** The SyncService slice this orchestrator drives (the apple-session seam pattern): the real
 * service in U6 wiring and in the test harness — "sync started" is then a real writeProfile. */
export type ExtensionSessionSync = Pick<
  SyncService,
  "onSignedIn" | "signOut" | "deleteAccount" | "resume" | "getState"
>;

export interface ExtensionSessionDeps {
  readonly auth: AuthPort & CodeAuthPort;
  readonly backend: BackendPort & WebCheckoutPort & CheckedReconcilePort;
  /** U1's record-level store (identity binding + staleness), not the boolean adapter. */
  readonly records: EntitlementRecordStore;
  readonly sync: ExtensionSessionSync;
  readonly identity: ExtensionIdentityStore;
  readonly stores: ExtensionSessionStores;
  /** Best-effort chrome.tabs.remove: teardown closes a recorded checkout tab — an open
   * pay.rev.cat tab still carries the previous identity. */
  readonly closeTab: (tabId: number) => Promise<void>;
  /** Injected clock (ms epoch); Date.now in real wiring. */
  readonly now?: () => number;
}

/** Extends the U4 reconcile vocabulary (CheckoutReconcileOutcome) with the no-session case the
 * background must answer gracefully. */
export type SessionReconcileOutcome =
  | "entitled"
  | "not-entitled"
  | "unknown"
  | "auth-required"
  | "signed-out";

export type NudgeOutcome = "no-op" | "throttled" | "reconciled";

export type ResumeOutcome = "signed-out" | "resumed-entitled" | "resumed-free";

export type SignOutSessionOutcome = "signed-out";

/** delete-failed keeps the session AND local state intact (server-first, apple-session parity). */
export type DeleteAccountSessionOutcome = "deleted" | "delete-failed";

/** The popup's mount snapshot (R2): userId and the persisted pending records have no
 * storage-watch mirror, so the popup asks once on mount and then mirrors settings/entitlement
 * through the existing storage watchers. */
export interface ExtensionSessionState {
  readonly userId: string | null;
  readonly entitled: boolean;
  readonly checkoutPending: CheckoutPendingRecord | null;
  readonly pendingOtp: PendingOtpRecord | null;
}

export interface ExtensionSession {
  getState(): Promise<ExtensionSessionState>;
  requestCode(email: string): Promise<RequestCodeOutcome>;
  verifyCode(email: string, token: string): Promise<VerifyCodeOutcome>;
  /** Popup-open / poll-window reconcile (R4): definitive-write rule, 401 → auth-required. */
  reconcile(): Promise<SessionReconcileOutcome>;
  /** Reconcile-only alias backing the paywall's Restore button on web hosts (R5): a web
   * "restore" IS a fresh authenticated reconcile — Web Billing has no store-side restore. */
  restore(): Promise<SessionReconcileOutcome>;
  createCheckout(): Promise<WebCheckoutOutcome>;
  signOut(): Promise<SignOutSessionOutcome>;
  deleteAccount(): Promise<DeleteAccountSessionOutcome>;
  /** The content-script reconcile nudge (R4/AE3) — the only handler content-script senders may
   * reach (U6 enforces that on the message router). */
  onNudge(): Promise<NudgeOutcome>;
  /** Run on EVERY background start (R2 hard rule): restart sync from the cached record, no
   * network. */
  resume(): Promise<ResumeOutcome>;
  /** AuthPersistence backing (U6): the controller's deliberate-dismiss clears with null; its
   * post-request write mirrors what requestCode already persisted (idempotent). */
  setPendingOtp(pending: { readonly email: string; readonly requestedAt: number } | null): Promise<void>;
  /** AuthPersistence backing (U6): the AE1 continuation flag, persisted onto the pending-OTP
   * record (or staged in-instance until one exists). */
  setPurchaseIntent(active: boolean): Promise<void>;
  /** UiCheckout.setPending backing (U6): the controller persists the flag BEFORE opening the
   * checkout tab (the popup dies with the focus change) — only the caller can order that, which
   * is why createCheckout here never writes it (the U4/U5 responsibility split). */
  setCheckoutPending(pending: CheckoutPendingRecord | null): Promise<void>;
}

export function createExtensionSession(deps: ExtensionSessionDeps): ExtensionSession {
  const { auth, backend, records, sync, identity, stores, closeTab } = deps;
  const now = deps.now ?? (() => Date.now());

  /** Purchase intent set before any pending-OTP record exists (locked-row tap precedes the code
   * request) — staged in-instance and folded into the next persisted record. A worker restart in
   * that gap loses only the auto-open nicety (the user re-taps the row), never state that
   * matters. */
  let stagedIntent = false;

  /** In-instance single-flight for onNudge: a session-restore burst fires several nudges at once,
   * and two truly concurrent calls would both read the throttle stamp before either write lands.
   * The persisted stamp (written BEFORE the network await) covers cross-instance wakes. */
  let nudgeInFlight = false;

  const attempt = async (op: () => Promise<void>): Promise<void> => {
    try {
      await op();
    } catch {
      /* best-effort: storage/tab failures must never abort a teardown or a boot */
    }
  };

  const readSlot = async (slot: { get(): Promise<unknown> }): Promise<unknown> => {
    try {
      return await slot.get();
    } catch {
      return null; // an unreadable slot is an absent record, never a boot throw
    }
  };

  const readPendingOtp = async (): Promise<PendingOtpRecord | null> =>
    parsePendingOtp(await readSlot(stores.pendingOtp));
  const readCheckoutPending = async (): Promise<CheckoutPendingRecord | null> =>
    parseCheckoutPending(await readSlot(stores.checkoutPending));
  const readNudgeStamp = async (): Promise<number | null> =>
    parseStamp(await readSlot(stores.nudgeStamp));

  const persistPendingOtp = async (email: string, requestedAt: number): Promise<void> => {
    // The intent flag rides the record: staged in-instance, or already persisted for this email
    // (a resend must not drop the continuation).
    const existing = await readPendingOtp();
    const intent = stagedIntent || (existing?.email === email && existing.purchaseIntent === true);
    await attempt(() =>
      stores.pendingOtp.set(intent ? { email, requestedAt, purchaseIntent: true } : { email, requestedAt }),
    );
  };

  /**
   * Everything bound to the previous account on this browser (R8) — shared by the voluntary
   * teardown (signOut/deleteAccount: the parity pin) and the verifyCode identity switch (AE5).
   * The entitlement write is an explicit `entitled: false`, never a key removal (subscribers only
   * fire on a value, so content scripts re-lock immediately); every step is individually guarded
   * so one storage failure cannot strand the rest of the purge.
   */
  const clearUserScopedState = async (): Promise<void> => {
    await attempt(() => records.setRecord({ entitled: false, updatedAt: now() }));
    const pending = await readCheckoutPending();
    if (pending?.tabId !== undefined) {
      const tabId = pending.tabId;
      await attempt(() => closeTab(tabId)); // the open checkout tab carries the old identity
    }
    await attempt(() => stores.checkoutPending.set(null));
    stagedIntent = false;
    await attempt(() => stores.pendingOtp.set(null));
    await attempt(() => stores.nudgeStamp.set(null)); // the old user's throttle must not mute the next
    await attempt(() => identity.clear());
  };

  /**
   * The one authenticated reconcile spine (R4/R7): status-aware invoke, tri-state read, then the
   * definitive-write rule — the record `{entitled, userId, updatedAt: now}` is written on ANY
   * definitive answer (explicit false included; `updatedAt` restamped so an always-online user's
   * TTL never silently expires) and NEVER on unknown (AE6). 401 → auth-required with cache and
   * pending untouched — re-sign-in is the remedy, teardown never is. A definitive answer also
   * settles the sync write-through from it (SyncService.resume: no second network call); the full
   * mirror-down/seed flow stays a sign-in concern (onSignedIn, R9).
   */
  const runReconcile = async (): Promise<SessionReconcileOutcome> => {
    try {
      const userId = await auth.currentUserId();
      if (userId === null) return "signed-out";
      const call = await backend.reconcileEntitlementChecked();
      if (call === "auth-required") return "auth-required";
      if (call === "unavailable") return "unknown";
      const read = await backend.readEntitlement();
      if (read === "unknown") return "unknown";
      const entitled = read === "entitled";
      await records.setRecord({ entitled, userId, updatedAt: now() });
      // A confirmed purchase ends the checkout-pending lifecycle background-side too — the popup
      // may never reopen (AE3); the plan's sequence is "write cache, clear pending". The tab is
      // NOT closed here: it is showing the purchase-complete page.
      if (entitled) await attempt(() => stores.checkoutPending.set(null));
      sync.resume(userId, entitled);
      return entitled ? "entitled" : "not-entitled";
    } catch {
      return "unknown"; // a torn reconcile reads as couldn't-check — never a throw across the boundary
    }
  };

  return {
    async getState(): Promise<ExtensionSessionState> {
      try {
        const userId = await auth.currentUserId();
        // Session-bound when signed in (R8: a mismatch is "no cache"); the unfiltered read when
        // signed out matches what the content scripts' boolean adapter shows — an involuntary
        // session death leaves the cache riding out its TTL (AE6).
        const record = await records.getRecord(userId ?? undefined);
        return {
          userId,
          entitled: record?.entitled === true,
          checkoutPending: await readCheckoutPending(),
          pendingOtp: await readPendingOtp(),
        };
      } catch {
        return { userId: null, entitled: false, checkoutPending: null, pendingOtp: null };
      }
    },

    async requestCode(email: string): Promise<RequestCodeOutcome> {
      const outcome = await auth.requestCode(email);
      // Persist background-side (R2): the popup dies the moment the user switches to their mail
      // app; reopening rehydrates code entry from this record (AE2).
      if (outcome.kind === "sent") await persistPendingOtp(email, now());
      return outcome;
    },

    async verifyCode(email: string, token: string): Promise<VerifyCodeOutcome> {
      const outcome = await auth.verifyCode(email, token);
      // A wrong/failed code leaves the persisted OTP record in place — retry and popup-death
      // rehydration both need it (AE2).
      if (outcome.kind !== "verified") return outcome;
      const userId = outcome.userId;
      try {
        // Identity-switch check FIRST (AE5): purge the previous account's grant and pending state
        // before anything of the new user's lands. "Previous" is the last-synced identity when one
        // exists, else the identity bound into the stored record — an absent identity alone never
        // triggers the purge, so a free (never-synced) user re-signing in after an involuntary 401
        // keeps their own pending purchase (U4's one-continuous-flow rule).
        const lastSynced = await identity.get();
        const record = await records.getRecord();
        const previous = lastSynced ?? record?.userId ?? null;
        if (previous !== null && previous !== userId) await clearUserScopedState();
        // The code is consumed: the persisted OTP record (and the intent riding it — the popup
        // continues the purchase from its own in-memory flag now) is done.
        stagedIntent = false;
        await attempt(() => stores.pendingOtp.set(null));
        // The full sign-in flow: reconcile-before-read, cloud-wins mirror, sync only when
        // entitled (R9 semantics unchanged).
        await sync.onSignedIn(userId);
        // Write the record from that sign-in's own reconcile — one RevenueCat query, not two.
        // cloudReachable means the answer was definitive (explicit false included); unreachable
        // means unknown — no write, the cache rides its TTL (AE6).
        const state = sync.getState();
        if (state.cloudReachable) {
          await records.setRecord({ entitled: state.entitled, userId, updatedAt: now() });
        }
      } catch {
        // The session exists even when a sign-in side effect failed; the record write was skipped
        // and the next reconcile (popup open / nudge) self-heals. Never throw at the popup.
      }
      return outcome;
    },

    reconcile: runReconcile,

    restore: runReconcile,

    async createCheckout(): Promise<WebCheckoutOutcome> {
      const outcome = await backend.createWebCheckout();
      // 409 is the cross-device restore SUCCESS path (R5/AE4): confirm via reconcile so the cache
      // write lands BEFORE this outcome returns — the popup's payoff renders only after the
      // entitlement write (R6 ordering). The checkout-pending flag is deliberately NOT written on
      // the checkout-url branch: the controller persists it before opening the tab (see
      // setCheckoutPending), because the popup dies on the tab's focus change and only the caller
      // can order write-then-open.
      if (outcome.kind === "already-entitled") await runReconcile();
      return outcome;
    },

    // ── Voluntary teardown (R8) — both exits share clearUserScopedState (the parity pin). An
    // involuntary 401 NEVER routes here: auth-required leaves cache + pending to their fate.

    async signOut(): Promise<SignOutSessionOutcome> {
      // The Supabase sign-out is best-effort for a voluntary exit (apple-session parity: a
      // rejected remote call must not strand the local purge — the UI lands signed out + locked).
      try {
        await sync.signOut();
      } catch {
        /* proceed with the local purge regardless */
      }
      await clearUserScopedState();
      return "signed-out";
    },

    async deleteAccount(): Promise<DeleteAccountSessionOutcome> {
      // Server-first (apple-session parity): a failed backend delete keeps the session AND the
      // local state intact — never appear signed-out while the account still exists.
      try {
        await sync.deleteAccount();
      } catch {
        return "delete-failed";
      }
      await clearUserScopedState();
      return "deleted";
    },

    async onNudge(): Promise<NudgeOutcome> {
      if (nudgeInFlight) return "throttled"; // in-instance single-flight: burst → ONE reconcile
      nudgeInFlight = true;
      try {
        const userId = await auth.currentUserId();
        if (userId === null) return "no-op"; // low-privilege caller, no session — nothing to do
        // Acts only when checkout is pending OR the cache is stale/absent (R4) — an entitled
        // user's fresh cache means service pages nudge for free.
        const pending = await readCheckoutPending();
        let triggered = pending !== null;
        if (!triggered) {
          const record = await records.getRecord(userId);
          triggered = record === null || now() - record.updatedAt >= NUDGE_STALENESS_MS;
        }
        if (!triggered) return "no-op";
        const stamp = await readNudgeStamp();
        if (stamp !== null && now() - stamp < NUDGE_THROTTLE_MS) return "throttled";
        // Stamp BEFORE awaiting the network call: another worker instance waking mid-flight reads
        // it and skips — the cross-instance half of the single-flight rule.
        await stores.nudgeStamp.set(now());
        await runReconcile();
        return "reconciled";
      } catch {
        return "no-op"; // a torn nudge is a skipped nudge — never a throw at a content script
      } finally {
        nudgeInFlight = false;
      }
    },

    async resume(): Promise<ResumeOutcome> {
      // Runs on EVERY background start (R2 hard rule): with a persisted session, restart the sync
      // write-through from the CACHED record — no network reconcile. A worker that wakes on a
      // settings edit must not drop paid sync (the write-through subscription died with the old
      // worker) and must not burn a live RC query per wake; live reconcile stays on the R4
      // triggers (popup open, qualifying nudge).
      try {
        const userId = await auth.currentUserId();
        if (userId === null) return "signed-out";
        const record = await records.getRecord(userId); // identity-bound: a mismatch is "no cache" (R8)
        const entitled = record?.entitled === true;
        sync.resume(userId, entitled);
        return entitled ? "resumed-entitled" : "resumed-free";
      } catch {
        return "signed-out"; // a torn boot must never throw; the next reconcile self-heals
      }
    },

    async setPendingOtp(pending): Promise<void> {
      if (pending === null) {
        await attempt(() => stores.pendingOtp.set(null));
        return;
      }
      await persistPendingOtp(pending.email, pending.requestedAt);
    },

    async setPurchaseIntent(active): Promise<void> {
      stagedIntent = active;
      const existing = await readPendingOtp();
      if (existing === null) return; // stays staged until a record exists to ride
      const base = stripIntent(existing);
      await attempt(() => stores.pendingOtp.set(active ? { ...base, purchaseIntent: true } : base));
    },

    async setCheckoutPending(pending): Promise<void> {
      await attempt(() => stores.checkoutPending.set(pending));
    },
  };
}

// ── Defensive parsing ──────────────────────────────────────────────────────────────────────────
// Garbage tolerance for every persisted record (the chrome-adapter garbage-timestamp rule): a
// corrupt slot reads as absent — boot never throws, and a pending state can never wedge into
// NaN-comparison limbo.

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parsePendingOtp(value: unknown): PendingOtpRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.email !== "string" || v.email.length === 0) return null;
  return {
    email: v.email,
    // A garbage requestedAt is dropped, not fatal: the email still rehydrates code entry; only
    // the resend-cooldown restoration is lost.
    ...(isFiniteNumber(v.requestedAt) ? { requestedAt: v.requestedAt } : {}),
    ...(v.purchaseIntent === true ? { purchaseIntent: true } : {}),
  };
}

/** A recognizable record with a garbage startedAt keeps flowing with the field dropped: the
 * controller presents it as expired-pending with the start-over escape (U4's rule) — silently
 * reading it as absent would strand the flag forever. Non-objects read as absent. */
function parseCheckoutPending(value: unknown): CheckoutPendingRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return {
    ...(isFiniteNumber(v.startedAt) ? { startedAt: v.startedAt } : {}),
    ...(isFiniteNumber(v.tabId) ? { tabId: v.tabId } : {}),
  };
}

function parseStamp(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function stripIntent(record: PendingOtpRecord): PendingOtpRecord {
  return record.requestedAt === undefined
    ? { email: record.email }
    : { email: record.email, requestedAt: record.requestedAt };
}
