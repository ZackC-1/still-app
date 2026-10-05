// The rating card's customer path (U13-P3): local eligibility, one fresh owner allowance, then
// reserve and commit, in that order, before anything is shown.
//
// Rules this module keeps (pinned by __tests__/rating-allowance.test.ts):
//   * Local eligibility first, through the ledger's arbiter. Nothing is fetched for an opening the
//     ledger would not offer a rating card to.
//   * Then exactly one fresh allowance check, bounded at five seconds. Anything but a fresh,
//     current On (Off, missing, timed out, late, stale, a wrong surface or build) is no card. A
//     cached allowance is never an input here: the only allowance this module accepts is the one
//     `freshCheck` answers for this opening.
//   * The allowance counts only for the opening that captured it: reserve re-arbitrates inside
//     the ledger's serialized transaction, so a newer opening, another host's card or a changed
//     ledger wins and nothing is shown.
//   * Commit consumes the once-per-install attempt BEFORE the card can render (U13-P1 review hard
//     rule 1). A rejected or failed commit means no card (hard rule 3).
//   * Only Chrome and Firefox show a browser card. Safari maps to its Apple host (the app requests
//     Apple's own sheet); a page that claims any other surface, or a surface other than the
//     background's own, gets nothing.
//   * No analytics, no notifications, no identifiers: this module sends and records nothing.

import { localDayOrdinal } from "./day-ordinal.js";
import {
  validInvitationId, type InvitationOwnerParameters, type InvitationReservation,
} from "./ledger.js";
import type { InvitationSuppression } from "./arbiter.js";
import { InvitationLedgerStore, type InvitationLedgerPort, type InvitationStoreStatus } from "./storage.js";

/**
 * Coordinator ruling (2026-10-05, U13 owner question 5): the 168 hour spacing applies between any
 * two invitations, sync or rating, in both directions. Every other parameter keeps the proposal.
 */
export const RATING_INVITATION_PARAMETERS: InvitationOwnerParameters = /* @__PURE__ */ Object.freeze({
  spaceRatingFromInvitations: true,
  // The proposal's counted controls, written out (not spread) so bundlers can drop this constant.
  countedControls: /* @__PURE__ */ Object.freeze(["site", "feature"] as const),
});

/** A fresh allowance check that has not answered within this many milliseconds is Off. */
export const RATING_ALLOWANCE_TIMEOUT_MS = 5000;

/** The only surfaces with a browser rating card. Safari is deliberately absent. */
export type RatingCardSurface = "chrome" | "firefox";
/** The U6 policy surface (shared-types/product-policy.ts) whose allowance a card surface needs. */
export type RatingPolicySurface = "chrome_desktop" | "firefox_desktop";
const CARD_SURFACES: Readonly<Record<RatingCardSurface, { policy: RatingPolicySurface }>> = /* @__PURE__ */ Object.freeze({
  chrome: /* @__PURE__ */ Object.freeze({ policy: "chrome_desktop" }),
  firefox: /* @__PURE__ */ Object.freeze({ policy: "firefox_desktop" }),
});

/** The card surface a value names, or null (Safari, Apple hosts and anything else). */
export function ratingCardSurface(value: unknown): RatingCardSurface | null {
  return value === "chrome" || value === "firefox" ? value : null;
}
/** The policy surface whose allowance a card surface needs. */
export function ratingPolicySurface(surface: RatingCardSurface): RatingPolicySurface {
  return CARD_SURFACES[surface].policy;
}

/** The ledger store every rating host uses, with the coordinator's spacing parameters. */
export function ratingInvitationStore(port: InvitationLedgerPort): InvitationLedgerStore {
  return new InvitationLedgerStore(port, RATING_INVITATION_PARAMETERS);
}

export interface RatingOpening {
  /** Opaque per-installation id used only if the ledger does not exist yet. Never sent anywhere. */
  readonly installation: string;
  /** The known local first-run time (UTC ms), or null while unknown (which pauses rating). */
  readonly anchorMs: number | null;
  readonly opening: string;
  /** Only an actual ordinary Still UI opening counts (not a private window or an unknown context). */
  readonly ordinary: boolean;
  readonly nowMs: number;
  /** IANA zone for the local calendar day; omit for the device's current zone. */
  readonly timeZone?: string;
}

/** Create the ledger once, fill a newly known anchor, and record this opening's day of use. */
export async function recordRatingOpening(store: InvitationLedgerStore, input: RatingOpening): Promise<InvitationStoreStatus> {
  const created = await store.ensure(input.installation, input.anchorMs);
  if (created !== "ready") return created;
  if (input.anchorMs !== null) {
    const adopted = await store.adoptAnchor(input.anchorMs);
    if (adopted !== "ready") return adopted;
  }
  return store.recordOpening({
    opening: input.opening, ordinary: input.ordinary, nowMs: input.nowMs,
    localDay: localDayOrdinal(input.nowMs, input.timeZone),
  });
}

/** The only shape of allowance this module accepts: a verdict from one fresh online check. */
export interface RatingAllowance {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface RatingAdmissionDeps {
  readonly store: InvitationLedgerStore;
  /** One fresh online allowance check for this opening (U6 `freshCheck("rating")`). */
  readonly freshCheck: () => Promise<RatingAllowance>;
  /** Wall-clock UTC milliseconds. */
  readonly now: () => number;
  /** The surface this host itself is (the background's packaged surface), or null for none. */
  readonly hostSurface: RatingCardSurface | null;
  readonly timeoutMs?: number;
}

export interface RatingAdmissionRequest {
  readonly opening: string;
  /** The surface the requesting page says it is. It must equal the host's own surface. */
  readonly surface: unknown;
  readonly syncApplicable: boolean;
  readonly linkApplicable: boolean;
  readonly suppressed: InvitationSuppression | null;
}

export type RatingRefusal = "surface" | "invalid" | "local" | "policy" | "reserve" | "commit";
export type RatingAdmission =
  | { readonly admitted: true; readonly surface: RatingCardSurface; readonly opening: string; readonly receipt: string }
  | { readonly admitted: false; readonly reason: RatingRefusal };

const refuse = (reason: RatingRefusal): RatingAdmission => ({ admitted: false, reason });

/** Resolve the fresh check, or Off when it fails, throws or has not answered in time. A reply that
 * arrives after the bound is never read. */
function boundedAllowance(check: () => Promise<RatingAllowance>, timeoutMs: number): Promise<RatingAllowance> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (value: RatingAllowance) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle({ allowed: false, reason: "timeout" }), timeoutMs);
    Promise.resolve().then(check).then(
      value => settle(value),
      () => settle({ allowed: false, reason: "failed" }),
    );
  });
}

/** A reserved, not yet committed, rating card for the captured opening. */
export type RatingReservation =
  | { readonly reserved: true; readonly surface: RatingCardSurface; readonly reservation: InvitationReservation }
  | { readonly reserved: false; readonly reason: RatingRefusal };

/**
 * Local eligibility, one fresh allowance, then reserve: everything before the commit. A host that
 * commits from another context (the browser popup, through the background) calls this, then
 * commits immediately before the card renders. Never throws.
 */
export async function reserveRatingCard(deps: RatingAdmissionDeps, request: RatingAdmissionRequest): Promise<RatingReservation> {
  const surface = ratingCardSurface(request.surface);
  if (surface === null || deps.hostSurface === null || surface !== deps.hostSurface) return { reserved: false, reason: "surface" };
  if (!validInvitationId(request.opening)) return { reserved: false, reason: "invalid" };
  const context = (nowMs: number) => ({
    opening: request.opening, nowMs, syncApplicable: request.syncApplicable,
    linkApplicable: request.linkApplicable, suppressed: request.suppressed,
  });
  try {
    // 1. Local eligibility. Nothing is fetched unless the ledger would offer a rating card now.
    const local = await deps.store.arbitrate(context(deps.now()));
    if (local.kind !== "rating") return { reserved: false, reason: "local" };
    // 2. One fresh owner allowance, for this opening only.
    const allowance = await boundedAllowance(deps.freshCheck, deps.timeoutMs ?? RATING_ALLOWANCE_TIMEOUT_MS);
    if (allowance.allowed !== true || allowance.reason !== "on") return { reserved: false, reason: "policy" };
    // 3. Reserve: re-arbitrates in the serialized transaction against the CAPTURED opening.
    const reservation = await deps.store.reserve("rating", context(deps.now()));
    if (!reservation) return { reserved: false, reason: "reserve" };
    return { reserved: true, surface, reservation };
  } catch {
    return { reserved: false, reason: "local" };
  }
}

/**
 * Decide whether this opening shows the rating card, consuming the one attempt if it does. An
 * `admitted` result means the commit is already durable: render the card now, and never call this
 * again for the same opening. Never throws.
 */
export async function admitRatingCard(deps: RatingAdmissionDeps, request: RatingAdmissionRequest): Promise<RatingAdmission> {
  const reserved = await reserveRatingCard(deps, request);
  if (!reserved.reserved) return refuse(reserved.reason);
  const { reservation } = reserved;
  // 4. Commit before the card can render. Rejected or failed: no card. A failed commit is not
  //    released here: if it did persist, the attempt is spent; if it did not, the next ordinary
  //    opening reclaims the uncommitted reservation (the ledger's crash rule).
  const committed = await deps.store.commit(reservation, deps.now()).catch(() => false);
  if (!committed) return refuse("commit");
  return { admitted: true, surface: reserved.surface, opening: request.opening, receipt: `rating-${reservation.generation}` };
}
