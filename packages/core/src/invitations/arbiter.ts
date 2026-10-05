// The invitation arbiter: which one optional card, if any, this opening may show.
//
// Precedence is link, then sync, then rating. At most one card per opening. Nothing shows during
// setup, consent, an error, a purchase, Restore, delete or a manual link flow. The arbiter is pure;
// reserve, commit and release are the only transitions that consume, and each is fenced by the
// ledger generation so parallel hosts consume once.
//
// Host protocol: arbitrate, then reserve (which re-arbitrates inside the same serialized storage
// transaction), then commit IMMEDIATELY BEFORE the card becomes visible (on Apple, before calling
// StoreKit). Release only on a failure that definitely happened before visibility. A crash after
// reserve leaves an uncommitted reservation; the next ordinary opening releases it, because no
// card can have been visible without a commit. A commit that succeeds consumes the one attempt
// even if the card or the system sheet then never appears.
//
// For rating, a "rating" result here is LOCAL eligibility only. The fresh owner allowance check
// (U13-P3) runs after it and before reserve; this module never fetches anything.

import {
  INVITATION_RULES, PROPOSED_INVITATION_PARAMETERS, validInvitationId,
  type InvitationKind, type InvitationLedger, type InvitationOwnerParameters, type InvitationReservation,
} from "./ledger.js";

export type InvitationSuppression = "setup" | "consent" | "error" | "purchase" | "restore" | "delete" | "link";

export interface InvitationContext {
  readonly opening: string;
  readonly nowMs: number;
  /** Host fact: the sync invitation applies (signed out, sync offered on this surface). */
  readonly syncApplicable: boolean;
  /** Host fact: an Apple Still Pro purchase is still unlinked and linking is offered here. */
  readonly linkApplicable: boolean;
  readonly suppressed: InvitationSuppression | null;
}

export type InvitationReason =
  | "card" | "invalid" | "suppressed" | "not-ordinary" | "clock-paused" | "in-flight" | "session-used" | "none";
export interface InvitationArbitration {
  readonly kind: InvitationKind | null;
  readonly reason: InvitationReason;
}

const elapsed = (now: number, since: number | null, span: number) => since === null || now - since >= span;
const validNow = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function invitationAllowed(ledger: InvitationLedger, now: number, parameters: InvitationOwnerParameters): boolean {
  return ledger.shown < INVITATION_RULES.maxInvitations &&
    elapsed(now, ledger.lastInvitationAt, INVITATION_RULES.invitationSpacingMs) &&
    (!parameters.spaceRatingFromInvitations || elapsed(now, ledger.lastRatingAt, INVITATION_RULES.invitationSpacingMs));
}

/** Local rating eligibility: due (a later opening than the one that earned day three), a known
 * anchor that is not in the future, and at least 604,800,000 ms of elapsed age. */
function ratingAllowed(ledger: InvitationLedger, now: number, parameters: InvitationOwnerParameters): boolean {
  const anchor = ledger.anchorMs;
  return ledger.rating === "due" && ledger.distinctDays >= INVITATION_RULES.ratingDistinctDays &&
    anchor !== null && anchor <= now && now - anchor >= INVITATION_RULES.ratingMinimumAgeMs &&
    (!parameters.spaceRatingFromInvitations || elapsed(now, ledger.lastInvitationAt, INVITATION_RULES.invitationSpacingMs));
}

export function arbitrateInvitation(
  ledger: InvitationLedger, context: InvitationContext, parameters: InvitationOwnerParameters = PROPOSED_INVITATION_PARAMETERS,
): InvitationArbitration {
  const none = (reason: InvitationReason): InvitationArbitration => ({ kind: null, reason });
  if (!validInvitationId(context.opening) || !validNow(context.nowMs)) return none("invalid");
  if (context.suppressed !== null) return none("suppressed");
  if (context.opening !== ledger.lastOpening) return none("not-ordinary");
  if (context.nowMs < ledger.highWaterMs) return none("clock-paused");
  if (ledger.reservation) return none("in-flight");
  if (ledger.lastCardOpening === context.opening) return none("session-used");
  const now = context.nowMs;
  if (ledger.link === "due" && context.linkApplicable && invitationAllowed(ledger, now, parameters)) return { kind: "link", reason: "card" };
  if (ledger.sync === "due" && context.syncApplicable && invitationAllowed(ledger, now, parameters)) return { kind: "sync", reason: "card" };
  if (ratingAllowed(ledger, now, parameters)) return { kind: "rating", reason: "card" };
  return none("none");
}

export type InvitationReserveResult =
  | { readonly ok: true; readonly ledger: InvitationLedger; readonly reservation: InvitationReservation }
  | { readonly ok: false; readonly reason: InvitationReason | "other-kind" };

/** Reserve the card before rendering it. Re-arbitrates, so a competing host or a changed state wins. */
export function reserveInvitation(
  ledger: InvitationLedger, kind: InvitationKind, context: InvitationContext,
  parameters: InvitationOwnerParameters = PROPOSED_INVITATION_PARAMETERS,
): InvitationReserveResult {
  const decision = arbitrateInvitation(ledger, context, parameters);
  if (decision.kind === null) return { ok: false, reason: decision.reason };
  if (decision.kind !== kind) return { ok: false, reason: "other-kind" };
  const generation = ledger.generation + 1;
  const reservation: InvitationReservation = { kind, opening: context.opening, generation };
  return { ok: true, reservation, ledger: { ...ledger, generation, reservation, highWaterMs: Math.max(ledger.highWaterMs, context.nowMs) } };
}

const matches = (ledger: InvitationLedger, r: InvitationReservation) =>
  ledger.reservation !== null && ledger.reservation.kind === r.kind && ledger.reservation.opening === r.opening &&
  ledger.reservation.generation === r.generation && ledger.generation === r.generation;

/** Consume the reserved card. Call immediately before it becomes visible; null means do not show. */
export function commitInvitation(
  ledger: InvitationLedger, reservation: InvitationReservation, nowMs: number,
): InvitationLedger | null {
  if (!matches(ledger, reservation) || !validNow(nowMs)) return null;
  // Never shorten spacing after a clock rollback: stamp at least the high-water mark.
  const at = Math.max(nowMs, ledger.highWaterMs);
  const base = { ...ledger, reservation: null, generation: ledger.generation + 1, lastCardOpening: reservation.opening, highWaterMs: at };
  if (reservation.kind === "rating") return { ...base, rating: "consumed", lastRatingAt: at };
  return {
    ...base, [reservation.kind]: "consumed", lastInvitationAt: at,
    shown: Math.min(INVITATION_RULES.maxInvitations, ledger.shown + 1),
  };
}

/** Return a reserved card to due after a failure definitely before visibility. */
export function releaseInvitation(
  ledger: InvitationLedger, reservation: InvitationReservation,
): InvitationLedger | null {
  if (!matches(ledger, reservation)) return null;
  return { ...ledger, reservation: null, generation: ledger.generation + 1 };
}
