import { entitlementStampExpired } from "@still/core/entitlement";

// The Safari entitlement pull, extracted from the background entrypoint so it is unit-testable with
// injected deps. The app mirrors its server-reconciled entitlement into the App Group (StillKit
// EntitlementBridge); the background pulls it via a {kind:"getEntitlement"} native message and
// writes it into browser.storage (`still:entitlement`), where the content scripts' EntitlementCache
// reads it. The app's `updatedAt` (last server-confirmed time) is preserved so the extension's
// 30-day offline TTL measures from real server contact, not from the pull.
//
// Reinstall detection (issue #63): iOS Safari owns browser.storage, so `still:entitlement` survives
// an app delete/reinstall while the App Group is wiped. The reply envelope therefore carries the
// app's install-generation id; we compare it against the last id we saw and purge the stale grant
// only on an affirmative CHANGE. An absent/unreadable id is never a purge signal — that would
// break the offline never-downgrade design.

/** The stored entitlement shape inside the reply envelope. */
export interface NativeEntitlementRecord {
  readonly entitled: boolean;
  readonly updatedAt: number;
}

/** The decoded reply envelope: the entitlement record (or null) plus the app's install-generation
 * id (or null). The two are independent — post-reinstall the App Group has a marker but no record. */
export interface NativeEntitlementReply {
  readonly record: NativeEntitlementRecord | null;
  readonly installId: string | null;
}

const NO_REPLY: NativeEntitlementReply = { record: null, installId: null };

/** Coerce a native `{ entitlement: "<json>" }` reply into the envelope. Anything unreadable — no
 * value, native host unavailable, legacy `""` reply from an old app build, malformed JSON — yields
 * both-null, which every caller treats as "no signal" (storage untouched, no purge). A legacy
 * record without `installId` still yields its record (installId null). */
export function parseNativeEntitlement(reply: unknown): NativeEntitlementReply {
  if (!reply || typeof reply !== "object") return NO_REPLY;
  const raw = (reply as { entitlement?: unknown }).entitlement;
  if (typeof raw !== "string" || raw === "") return NO_REPLY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_REPLY;
  }
  if (!parsed || typeof parsed !== "object") return NO_REPLY;
  const { entitled, updatedAt, installId } = parsed as {
    entitled?: unknown;
    updatedAt?: unknown;
    installId?: unknown;
  };
  const record =
    typeof entitled === "boolean" && typeof updatedAt === "number" && Number.isFinite(updatedAt)
      ? { entitled, updatedAt }
      : null;
  const id = typeof installId === "string" && installId !== "" ? installId : null;
  return { record, installId: id };
}

/** The install-generation comparison, modeled as an explicit outcome so "no signal" can never be
 * confused with "changed" (structured-outcome convention):
 *   - "unknown": the reply carried no id (old app build, degraded App Group, unreachable host) —
 *     strict no-op, the offline design's territory.
 *   - "adopt":   we have never recorded an id (pre-fix installs upgrading to this version) — store
 *     it WITHOUT purging, so the upgrade itself can never relock an entitled user.
 *   - "same":    ordinary steady state.
 *   - "changed": affirmative reinstall evidence — purge the stale grant. */
export type InstallGenerationOutcome = "same" | "changed" | "adopt" | "unknown";

export function resolveInstallGeneration(
  storedId: string | null,
  replyId: string | null,
): InstallGenerationOutcome {
  if (!replyId) return "unknown";
  if (!storedId) return "adopt";
  return storedId === replyId ? "same" : "changed";
}

/** Where the pulled record lands (ChromeEntitlementAdapter in production, a fake in tests). */
export interface EntitlementSink {
  set(entitled: boolean, updatedAt?: number): Promise<void>;
}

/** Where the last-seen install-generation id lives. Deliberately a separate key from the
 * entitlement record: the purge writes the entitlement key and must never clear its own marker. */
export interface InstallGenerationStore {
  get(): Promise<string | null>;
  set(id: string): Promise<void>;
}

export const INSTALL_GENERATION_KEY = "still:installGeneration";

/** The production marker store in browser.storage.local. */
export class BrowserInstallGenerationStore implements InstallGenerationStore {
  async get(): Promise<string | null> {
    const stored = await browser.storage.local.get(INSTALL_GENERATION_KEY);
    const value: unknown = stored[INSTALL_GENERATION_KEY];
    return typeof value === "string" && value !== "" ? value : null;
  }

  async set(id: string): Promise<void> {
    await browser.storage.local.set({ [INSTALL_GENERATION_KEY]: id });
  }
}

/** Swallow-and-continue, mirroring clearUserScopedState's `attempt`: one storage failure must not
 * strand the rest of the pull. Returns whether the write actually landed, so callers that must
 * only proceed on success (the purge → marker ordering) can tell. */
async function attempt(op: () => Promise<unknown>): Promise<boolean> {
  try {
    await op();
    return true;
  } catch {
    return false; /* best-effort */
  }
}

/** Act on the install-generation outcome. Only "changed" purges: an explicit `entitled:false`
 * write (never a key removal — storage subscribers only fire on a value change), then the new id
 * is recorded. The id is recorded ONLY after the purge write lands: recording it first would mark
 * the generation as handled while the stale grant survives, forfeiting the purge forever. "adopt"
 * records the id without touching entitlement. Returns whether a purge happened (for tests and
 * logging). */
export async function applyInstallGeneration(
  outcome: InstallGenerationOutcome,
  replyId: string | null,
  deps: { sink: EntitlementSink; generations: InstallGenerationStore; now?: () => number },
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  if (outcome === "changed" && replyId) {
    const purged = await attempt(() => deps.sink.set(false, now()));
    // Purge failed: write nothing else — the marker still holds the old id, so the next pull
    // re-resolves "changed" and retries the purge.
    if (!purged) return false;
    // The marker write stays attempt-wrapped: if it fails AFTER a successful purge, the next pull
    // re-resolves "changed" and re-purges — idempotent, self-healing.
    await attempt(() => deps.generations.set(replyId));
    return true;
  }
  if (outcome === "adopt" && replyId) {
    await attempt(() => deps.generations.set(replyId));
  }
  return false;
}

/** Apply a pulled record to local entitlement storage. A null record is a no-op — never downgrade
 * on "couldn't read" (the storage TTL already bounds staleness); a real revocation arrives as an
 * explicit `entitled:false` record. An `entitled:true` record already OLDER than the 30-day TTL is
 * also a no-op: the read path would reject it, but the storage-change subscription fires on any
 * write, so storing it would unlock Pro in live pages until the next hydrate. Returns whether a
 * write happened. */
export async function applyNativeEntitlement(
  record: NativeEntitlementRecord | null,
  sink: EntitlementSink,
  now: () => number = Date.now,
): Promise<boolean> {
  if (!record) return false;
  if (record.entitled && entitlementStampExpired(record.updatedAt, now())) return false;
  await sink.set(record.entitled, record.updatedAt);
  return true;
}

export interface EntitlementPullDeps {
  /** Sends {kind:"getEntitlement"} to the native host and resolves with the raw reply. */
  readonly send: () => Promise<unknown>;
  readonly sink: EntitlementSink;
  readonly generations: InstallGenerationStore;
  readonly now?: () => number;
}

/** Build the single-flight entitlement pull. Concurrent callers (cold start + reconcile nudges
 * from several tab loads) share the in-flight pull's promise instead of fanning out — mirroring
 * `refreshRuleSetCache` (core/rules/loader.ts), NOT `nudgeInFlight`'s drop semantics — so a stale
 * late-resolving reply can never interleave with a newer purge/apply pass (R6).
 *
 * Order within one pull is load-bearing: resolve the generation outcome and purge/adopt FIRST,
 * then apply the reply's entitlement record. In the combined case (changed id + fresh
 * entitled:true — an entitled user whose keychain session survived reinstall and whose app already
 * reconciled) this lands purge(false) then apply(true): final state entitled, no window where a
 * stale grant survives. */
export function createEntitlementPull(deps: EntitlementPullDeps): () => Promise<void> {
  let inFlight: Promise<void> | null = null;

  async function pullOnce(): Promise<void> {
    let reply: unknown;
    try {
      reply = await deps.send();
    } catch {
      return; // native host unavailable (extension running outside the app container)
    }
    const { record, installId } = parseNativeEntitlement(reply);
    let storedId: string | null = null;
    let storedIdKnown = true;
    try {
      storedId = await deps.generations.get();
    } catch {
      // Unreadable marker store: strict no-op on the generation lane. Treating the failed read as
      // "no stored id" would resolve to "adopt" and overwrite the REAL stored id with the reply's.
      storedIdKnown = false;
    }
    const outcome = storedIdKnown ? resolveInstallGeneration(storedId, installId) : "unknown";
    await applyInstallGeneration(outcome, installId, deps);
    // Attempt-wrapped like the purge/adopt writes: both production call sites are `void pull()`
    // with no catch, so a rejecting sink must not surface as an unhandled rejection.
    await attempt(() => applyNativeEntitlement(record, deps.sink, deps.now));
  }

  return () => {
    inFlight ??= pullOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
