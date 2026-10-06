// The per-installation invitation and rating ledger (U13-P1).
//
// One small local record per installation decides when Still may show an optional card: the sync
// invitation, the link invitation (Still Pro bought on Apple, not yet linked to an account) or the
// rating card. It is never synced, never sent anywhere and never produces analytics. Hosts persist
// it through the storage port in ./storage.ts; everything here is pure and mirrored exactly by
// StillKit's InvitationLedger.swift, with shared vectors proving the two agree.
//
// Rules that hold for every transition:
// - Counters saturate (milestones 0..3, distinct days 0..3, invitations shown 0..2).
// - The accepted local day ordinal never decreases, and the clock high-water mark never decreases.
// - A clock rollback or an anchor in the future pauses eligibility; nothing is ever reset.
// - The opening that earns a trigger (third milestone, third day, a new Apple purchase) only makes
//   the card due for a LATER ordinary opening; it never shows a card itself.

export type InvitationKind = "link" | "sync" | "rating";
/** idle: not earned. earned: earned during the current opening. due: may show on this or a later
 * ordinary opening. consumed: shown once; never again on this installation. */
export type InvitationTriggerState = "idle" | "earned" | "due" | "consumed";

export interface InvitationReservation {
  readonly kind: InvitationKind;
  readonly opening: string;
  readonly generation: number;
}

export interface InvitationLedger {
  readonly schema: 1;
  /** Opaque per-installation id (Apple: the install generation). Never sent anywhere. */
  readonly installation: string;
  /** Known local first-run time (UTC ms), or null while unknown. Unknown pauses rating. */
  readonly anchorMs: number | null;
  /** Latest wall-clock time observed (UTC ms). Never decreases; earlier clocks pause cards. */
  readonly highWaterMs: number;
  /** Last accepted local calendar day ordinal. Never decreases. */
  readonly dayOrdinal: number | null;
  readonly distinctDays: number;
  readonly milestones: number;
  /** Sync and link invitations shown on this installation (saturating). */
  readonly shown: number;
  readonly lastInvitationAt: number | null;
  readonly lastRatingAt: number | null;
  /** The most recent ordinary opening recorded. Cards are only offered to this opening. */
  readonly lastOpening: string | null;
  /** The opening that already showed a card; at most one card per opening. */
  readonly lastCardOpening: string | null;
  /** Fence bumped by every reserve, commit and release so a stale host can never consume. */
  readonly generation: number;
  readonly sync: InvitationTriggerState;
  readonly link: InvitationTriggerState;
  readonly rating: InvitationTriggerState;
  readonly reservation: InvitationReservation | null;
}

/** Fixed packaged rules. The contract forbids remote threshold or cap overrides. */
export const INVITATION_RULES = /* @__PURE__ */ Object.freeze({
  /** Rating needs at least seven days of UTC elapsed age: exactly 604,800,000 ms. */
  ratingMinimumAgeMs: 604_800_000,
  ratingDistinctDays: 3,
  milestoneTarget: 3,
  /** Sync and link invitations are at least 168 hours apart: 604,800,000 ms. */
  invitationSpacingMs: 604_800_000,
  maxInvitations: 2,
});

export type InvitationControl = "site" | "feature" | "global";

/**
 * Choices still open with the owner (U13 plan §6), held as explicit inputs with the plan's
 * proposed defaults so the answer changes a value, not the ledger.
 */
export interface InvitationOwnerParameters {
  /** Owner question 5. Proposed default false: 168 h spacing applies only between sync and link. */
  readonly spaceRatingFromInvitations: boolean;
  /** Owner question 4. Proposed default: site and feature toggles; global pause is not counted. */
  readonly countedControls: readonly InvitationControl[];
}
export const PROPOSED_INVITATION_PARAMETERS: InvitationOwnerParameters = /* @__PURE__ */ Object.freeze({
  spaceRatingFromInvitations: false,
  countedControls: /* @__PURE__ */ Object.freeze(["site", "feature"] as const),
});

const KEYS = [
  "schema", "installation", "anchorMs", "highWaterMs", "dayOrdinal", "distinctDays", "milestones", "shown",
  "lastInvitationAt", "lastRatingAt", "lastOpening", "lastCardOpening", "generation", "sync", "link", "rating", "reservation",
] as const;
const KINDS: readonly InvitationKind[] = ["link", "sync", "rating"];
const STATES: readonly InvitationTriggerState[] = ["idle", "earned", "due", "consumed"];

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const count = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const optionalCount = (v: unknown) => v === null || count(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const validInvitationId = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 128 && v.trim() === v;
const optionalId = (v: unknown) => v === null || validInvitationId(v);
const isKind = (v: unknown): v is InvitationKind => KINDS.includes(v as InvitationKind);
const isState = (v: unknown): v is InvitationTriggerState => STATES.includes(v as InvitationTriggerState);

/** Strict parse of a stored ledger. Anything else is unreadable: pause, never reset. */
export function parseInvitationLedger(value: unknown): InvitationLedger | null {
  if (!record(value) || !exact(value, KEYS) || value.schema !== 1 || !validInvitationId(value.installation)) return null;
  if (!optionalCount(value.anchorMs) || !count(value.highWaterMs) || !optionalCount(value.dayOrdinal) ||
      !count(value.distinctDays, INVITATION_RULES.ratingDistinctDays) || !count(value.milestones, INVITATION_RULES.milestoneTarget) ||
      !count(value.shown, INVITATION_RULES.maxInvitations) || !optionalCount(value.lastInvitationAt) || !optionalCount(value.lastRatingAt) ||
      !optionalId(value.lastOpening) || !optionalId(value.lastCardOpening) || !count(value.generation) ||
      !isState(value.sync) || !isState(value.link) || !isState(value.rating)) return null;
  const r = value.reservation;
  if (r !== null) {
    if (!record(r) || !exact(r, ["kind", "opening", "generation"]) || !isKind(r.kind) || !validInvitationId(r.opening) ||
        !count(r.generation) || r.generation > (value.generation as number)) return null;
  }
  return {
    schema: 1, installation: value.installation, anchorMs: value.anchorMs as number | null, highWaterMs: value.highWaterMs,
    dayOrdinal: value.dayOrdinal as number | null, distinctDays: value.distinctDays, milestones: value.milestones, shown: value.shown,
    lastInvitationAt: value.lastInvitationAt as number | null, lastRatingAt: value.lastRatingAt as number | null,
    lastOpening: value.lastOpening as string | null, lastCardOpening: value.lastCardOpening as string | null,
    generation: value.generation, sync: value.sync, link: value.link, rating: value.rating,
    reservation: r === null ? null : { kind: r.kind as InvitationKind, opening: r.opening as string, generation: r.generation as number },
  };
}

/** A fresh ledger. `anchorMs` is the known local first-run time, or null when it is unknown. */
export function createInvitationLedger(installation: string, anchorMs: number | null): InvitationLedger | null {
  if (!validInvitationId(installation) || !optionalCount(anchorMs)) return null;
  return {
    schema: 1, installation, anchorMs, highWaterMs: 0, dayOrdinal: null, distinctDays: 0, milestones: 0, shown: 0,
    lastInvitationAt: null, lastRatingAt: null, lastOpening: null, lastCardOpening: null, generation: 0,
    sync: "idle", link: "idle", rating: "idle", reservation: null,
  };
}

/** Fill an unknown anchor once. A known anchor is never replaced, so nothing resets eligibility. */
export function adoptInvitationAnchor(ledger: InvitationLedger, anchorMs: number): InvitationLedger {
  if (ledger.anchorMs !== null || !count(anchorMs)) return ledger;
  return { ...ledger, anchorMs };
}

export interface InvitationOpening {
  /** Unique id for this UI opening (popup open, app foreground). Opaque, local only. */
  readonly opening: string;
  /** Only an actual ordinary Still UI opening counts. Setup, store return, owner enable, a
   * background foreground, private or unknown contexts pass false and contribute nothing. */
  readonly ordinary: boolean;
  readonly nowMs: number;
  /** Local calendar day ordinal (see day-ordinal.ts), or null when unreadable. */
  readonly localDay: number | null;
}

const promote = (s: InvitationTriggerState): InvitationTriggerState => (s === "earned" ? "due" : s);

/** Record an ordinary opening: promote earned triggers, reclaim an abandoned reservation, count a day. */
export function recordInvitationOpening(ledger: InvitationLedger, input: InvitationOpening): InvitationLedger {
  if (!input.ordinary || !validInvitationId(input.opening) || !count(input.nowMs) || input.opening === ledger.lastOpening) return ledger;
  let next: InvitationLedger = {
    ...ledger, lastOpening: input.opening, highWaterMs: Math.max(ledger.highWaterMs, input.nowMs),
    sync: promote(ledger.sync), link: promote(ledger.link), rating: promote(ledger.rating),
  };
  // A reservation left by another opening was never committed, so its card was never visible
  // (hosts commit before showing). Releasing it is safe: the generation bump fences that host.
  if (next.reservation && next.reservation.opening !== input.opening) next = { ...next, reservation: null, generation: next.generation + 1 };
  const day = input.localDay;
  if (count(day) && (next.dayOrdinal === null || day > next.dayOrdinal)) {
    const distinctDays = Math.min(INVITATION_RULES.ratingDistinctDays, next.distinctDays + 1);
    const earned = distinctDays === INVITATION_RULES.ratingDistinctDays && next.rating === "idle";
    next = { ...next, dayOrdinal: day, distinctDays, rating: earned ? "earned" : next.rating };
  }
  return next;
}

/** Where a settings change came from. Only "direct" can count; everything else never does. */
export type InvitationControlSource =
  | "direct" | "sync-applied" | "restore" | "complimentary" | "browser-purchase" | "second-device" | "cascade" | "read" | "unknown";

export interface InvitationDirectControl {
  readonly control: InvitationControl;
  readonly source: InvitationControlSource;
  /** Only a committed write counts; failed or refused writes never do. */
  readonly outcome: "succeeded" | "failed" | "refused";
  readonly signedIn: boolean;
  /** Owner question 4 ("readiness"). The host decides; proposed: first-run setup finished. */
  readonly ready: boolean;
}

/** Count one successful direct control made while signed out after readiness (saturating). */
export function recordInvitationDirectControl(
  ledger: InvitationLedger, input: InvitationDirectControl, parameters: InvitationOwnerParameters = PROPOSED_INVITATION_PARAMETERS,
): InvitationLedger {
  if (input.source !== "direct" || input.outcome !== "succeeded" || input.signedIn || !input.ready ||
      !parameters.countedControls.includes(input.control)) return ledger;
  const milestones = Math.min(INVITATION_RULES.milestoneTarget, ledger.milestones + 1);
  const earned = milestones === INVITATION_RULES.milestoneTarget && ledger.sync === "idle";
  return { ...ledger, milestones, sync: earned ? "earned" : ledger.sync };
}

export type InvitationPurchaseSource =
  | "new-apple-purchase" | "restore" | "complimentary" | "browser-purchase" | "second-device" | "sync-applied" | "unknown";
export interface InvitationPurchaseEvent {
  readonly source: InvitationPurchaseSource;
  readonly verified: boolean;
  readonly unlinked: boolean;
}

/** Only an actual new, verified, unlinked Apple purchase earns the link invitation. */
export function recordInvitationPurchase(ledger: InvitationLedger, input: InvitationPurchaseEvent): InvitationLedger {
  if (input.source !== "new-apple-purchase" || !input.verified || !input.unlinked || ledger.link !== "idle") return ledger;
  return { ...ledger, link: "earned" };
}
