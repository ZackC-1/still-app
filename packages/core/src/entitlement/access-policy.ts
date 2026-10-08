import type { AccessCacheRecord } from "./access-record.js";
import { parseLocalProtection } from "./local-protection.js";
import { PAID_ACCESS_WINDOW_MS, type AccessState, type BenefitAccessSnapshot, type SettingsV2, FEATURE_IDS, FEATURE_REGISTRY, PAID_TIER_ENABLED, type LocalProtectionRecord, type BenefitId, type PaidAccessClock } from "@still/shared-types";
import { isPaidAccess, isSafeAccessInteger, isVerifiedAccessProof, type VerifiedAccessProof } from "./access-proof.js";

export interface AccessObservation {
  readonly wall: number;
  /** A lower bound from the current runtime only, derived by the host from its own origin.
   * It is never persisted or accepted from a previous runtime/message. */
  readonly runningEstimate?: number;
}

export function validPaidClock(clock: PaidAccessClock, proof: VerifiedAccessProof): boolean {
  return clock.proofIdentity === proof.identity && clock.verifiedAt === proof.claims.verified_at &&
    clock.expiresAt === proof.claims.expires_at && clock.expiresAt - clock.verifiedAt === PAID_ACCESS_WINDOW_MS &&
    [clock.verifiedAt, clock.expiresAt, clock.issuerTimeAtReceipt, clock.wallAtReceipt, clock.highWater, clock.lastWall].every(isSafeAccessInteger) &&
    clock.issuerTimeAtReceipt >= clock.verifiedAt && clock.highWater >= clock.issuerTimeAtReceipt &&
    clock.lastWall >= clock.wallAtReceipt && typeof clock.expired === "boolean" && typeof clock.revoked === "boolean" && typeof clock.paused === "boolean";
}

/** Only a genuinely new authoritative online validation may create this baseline. */
export function installPaidClock(proof: VerifiedAccessProof, issuerNow: number, wall: number): PaidAccessClock {
  if (!isVerifiedAccessProof(proof) || !isPaidAccess(proof.claims) || !isSafeAccessInteger(issuerNow) || !isSafeAccessInteger(wall) ||
      issuerNow < proof.claims.verified_at || !isSafeAccessInteger(proof.claims.expires_at)) throw new Error("Invalid access baseline");
  return { proofIdentity: proof.identity, verifiedAt: proof.claims.verified_at, expiresAt: proof.claims.expires_at,
    issuerTimeAtReceipt: issuerNow, wallAtReceipt: wall, highWater: issuerNow, lastWall: wall,
    expired: issuerNow >= proof.claims.expires_at, revoked: false, paused: false };
}

export function observePaidClock(proof: VerifiedAccessProof, clock: PaidAccessClock | null,
  observation: AccessObservation): { readonly state: "valid" | "verification_required"; readonly clock: PaidAccessClock | null } {
  if (!isVerifiedAccessProof(proof) || !clock || !validPaidClock(clock, proof)) return { state: "verification_required", clock };
  if (clock.expired || clock.revoked || clock.paused) return { state: "verification_required", clock };
  if (!isSafeAccessInteger(observation.wall) || observation.wall < clock.lastWall ||
      (observation.runningEstimate !== undefined && !isSafeAccessInteger(observation.runningEstimate))) return { state: "verification_required", clock: { ...clock, paused: true } };
  const wallEstimate = clock.issuerTimeAtReceipt + observation.wall - clock.wallAtReceipt;
  const effective = Math.max(clock.highWater, wallEstimate, observation.runningEstimate ?? 0);
  if (!isSafeAccessInteger(effective) || effective < proof.claims.verified_at) return { state: "verification_required", clock: { ...clock, paused: true } };
  const next = { ...clock, highWater: effective, lastWall: observation.wall, expired: effective >= clock.expiresAt };
  return { state: next.expired ? "verification_required" : "valid", clock: next };
}

export interface ScopedAccessEvidence {
  readonly proof: VerifiedAccessProof;
  readonly paidState: "valid" | "verification_required";
  readonly revoked: boolean;
}
export interface AccessResolutionContext {
  readonly paidMode: boolean;
  readonly supported: boolean;
  readonly free: boolean;
  readonly accountId: string | null;
  /** Native verified transaction/protection mapping, not copied proof holders or a device ID. */
  readonly localRights: ReadonlySet<string>;
  readonly localProtection?: LocalProtectionRecord | null;
  readonly evidenceStatus: "checking" | "unknown" | "absent";
  /** Captured alongside evidenceStatus; asynchronous projection cannot renew absence. */
  readonly evidenceDeadline?: number | null;
}

export function accessProofMatchesHolder(proof: VerifiedAccessProof, context: Pick<AccessResolutionContext, "accountId" | "localRights">): boolean {
  if (!isVerifiedAccessProof(proof)) return false;
  const c = proof.claims;
  return c.kind === "paid_account" || c.kind === "protected_account"
    ? context.accountId !== null && c.holder === context.accountId
    : c.holder === c.right && context.localRights.has(c.right);
}

/** Pure access only. This function never changes saved intent, native preferences or analytics. */
export function resolveBenefitAccess(benefit: BenefitId, evidence: readonly ScopedAccessEvidence[], context: AccessResolutionContext): AccessState {
  if (!context.supported) return "unsupported";
  if (!context.paidMode || context.free) return "free";
  let unresolved = false;
  let protectedRight = false;
  for (const item of evidence) {
    if (!accessProofMatchesHolder(item.proof, context) || item.revoked || !item.proof.claims.benefits.includes(benefit)) continue;
    if (isPaidAccess(item.proof.claims)) {
      if (item.paidState === "valid") return "purchased";
      unresolved = true;
    } else protectedRight = true;
  }
  let local: LocalProtectionRecord | null = null;
  try { local = parseLocalProtection(context.localProtection); } catch { unresolved = true; }
  if (protectedRight || local?.grant?.benefits.includes(benefit)) return "protected";
  if (local && !local.grant) unresolved = true;
  if (unresolved || context.evidenceStatus === "unknown") return "verification_required";
  return context.evidenceStatus === "checking" ? "checking" : "locked";
}

/** Host-only context. Runtime request bodies cannot choose any of these fields. Undefined
 * session means verification unavailable; null means authoritative local teardown/sign-out. */
export interface TrustedAccessContext {
  readonly paidMode: boolean;
  readonly supported: ReadonlySet<BenefitId>;
  readonly session?: { readonly userId: string; readonly sessionId: string } | null;
  readonly localRights: ReadonlySet<string>;
  readonly evidenceStatus: "checking" | "unknown" | "absent";
  /** Captured alongside evidenceStatus; asynchronous projection cannot renew absence. */
  readonly evidenceDeadline?: number | null;
}

export const ACCESS_BENEFITS: readonly BenefitId[] = Object.freeze([...FEATURE_IDS, "tiktok.all"]);

/** The extension hosts whose packaged content engine can implement a Still Pro feature. */
export type AccessHost = "chromium" | "firefox" | "safari";
export const ACCESS_HOSTS: readonly AccessHost[] = Object.freeze(["chromium", "firefox", "safari"]);
type ProFeatureId = Extract<(typeof FEATURE_REGISTRY)[number], { readonly tier: "pro" }>["id"];

/**
 * Still Pro features whose packaged engine implementation exists, per host. Each site packet adds
 * its own entries together with the code that implements them; no feature is listed here before
 * its implementation ships. Listing a feature never activates it: see accessCapabilities.
 */
// Instagram's four (rules/instagram-extras.ts) are compiled hide rules and content-script routes,
// which every host's shared format-2 content engine runs the same way.
const INSTAGRAM_PRO: readonly ProFeatureId[] = Object.freeze(["instagram.explore", "instagram.stories", "instagram.suggested", "instagram.threads"]);
const YOUTUBE_PRO: readonly ProFeatureId[] = Object.freeze(["youtube.related", "youtube.endscreen", "youtube.comments", "youtube.livechat"]);
// The related-items section and dedicated comments entry/panel have observed mobile structures
// and preservation regressions through Safari's shared content entry. This does not establish
// mobile end-screen, live-chat or autoplay behavior.
const YOUTUBE_SAFARI_PRO: readonly ProFeatureId[] = Object.freeze(["youtube.related", "youtube.comments"]);
// YouTube's packaged content-handler control (no rule data): Chromium and Firefox only.
const YOUTUBE_HANDLER_PRO: readonly ProFeatureId[] = Object.freeze(["youtube.autoplay"]);
// Facebook's Stories and Videos and Watch (rules/facebook-extras.ts) run in every host's shared
// format-2 content engine; Desktop sidebar ads only on the desktop extension hosts (see below).
const FACEBOOK_PRO: readonly ProFeatureId[] = Object.freeze(["facebook.stories", "facebook.videos"]);
const FACEBOOK_DESKTOP_PRO: readonly ProFeatureId[] = Object.freeze(["facebook.sponsored"]);
export const IMPLEMENTED_PRO_FEATURES: Readonly<Record<AccessHost, readonly ProFeatureId[]>> = Object.freeze({
  // YouTube's four hide controls (rules/youtube-extras.ts) and Autoplay prevention
  // (content/youtube-autoplay.ts) only on the hosts that pass their host to the content entry and
  // the access context (ext-chromium builds Chrome and Firefox).
  chromium: Object.freeze([...INSTAGRAM_PRO, ...YOUTUBE_PRO, ...YOUTUBE_HANDLER_PRO, ...FACEBOOK_PRO, ...FACEBOOK_DESKTOP_PRO]),
  // "firefox" is one build for desktop Firefox AND Firefox for Android, which gets the sites' mobile
  // layouts (for YouTube, m.youtube.com). The mobile selectors are unverified candidates, so the
  // structural evidence (E0) must cover Firefox for Android before paid activation. Autoplay
  // prevention claims no m.youtube.com behaviour yet (H-075), and Desktop sidebar ads only ever
  // matches the desktop right column: both are DESKTOP_ONLY_PRO, which a caller that passes the
  // runtime platform ("android" or "unknown") never receives.
  firefox: Object.freeze([...INSTAGRAM_PRO, ...YOUTUBE_PRO, ...YOUTUBE_HANDLER_PRO, ...FACEBOOK_PRO, ...FACEBOOK_DESKTOP_PRO]),
  // Safari (macOS and iPhone/iPad share one host) offers only the observed mobile YouTube
  // controls. End-screen, live chat, autoplay and Facebook sponsored-feed/sidebar support still
  // need their own mobile implementation and evidence before joining this set.
  safari: Object.freeze([...INSTAGRAM_PRO, ...YOUTUBE_SAFARI_PRO, ...FACEBOOK_PRO]),
});

/**
 * The device class a host build is running on, when its caller knows it. One "firefox" build runs
 * on desktop Firefox AND Firefox for Android, so the host alone cannot say whether a desktop-only
 * control has anything to act on. No caller passes it yet: once Firefox for Android's platform
 * answer (the browser's own runtime platform report) is wired into the Firefox build, that answer
 * ("android" | "desktop" | "unknown") is passed here unchanged.
 */
export type AccessPlatform = "android" | "desktop" | "unknown";

/**
 * Still Pro features that act only on a site's DESKTOP layout. On any other platform they would be
 * a control that does nothing, so they are never a capability there:
 * - youtube.autoplay: the content handler claims no m.youtube.com behaviour (H-075);
 * - facebook.sponsored: it only ever matches the desktop right column, which phones do not have.
 */
const DESKTOP_ONLY_PRO: readonly ProFeatureId[] = Object.freeze(["youtube.autoplay", "facebook.sponsored"]);

export interface AccessCapabilityInput {
  readonly paidMode: boolean;
  /** Absent when the caller does not know its host: only features implemented on EVERY host count. */
  readonly host?: AccessHost;
  /**
   * Absent keeps the long-standing behaviour (the host's whole list). "android" drops the
   * desktop-only controls. "unknown" drops them too: a platform the browser could not name may be
   * a phone, and a paid control that silently does nothing is worse than one held back.
   */
  readonly platform?: AccessPlatform;
}

/**
 * The dormancy gate (owner decision 6). A Still Pro feature is a host capability only while the
 * paid tier is on AND the host implements it. While paid is off the set is exactly the free
 * features plus the TikTok alias, so every Pro feature resolves to `unsupported` and its engine
 * effect is zero whatever its saved choice. Without this gate, adding a finished extra here with
 * paid off would resolve it to `free` (initialAccessSnapshot) and apply a saved On for everyone.
 */
export function accessCapabilities(input: AccessCapabilityInput): ReadonlySet<BenefitId> {
  return capabilitiesFrom(input, IMPLEMENTED_PRO_FEATURES);
}

/**
 * Test-only seam: the same gate over a synthetic implementation table, so unit tests can exercise
 * the paid-on branch. No shipped module imports it (a static test checks), so bundlers drop it and
 * the shipped artifact has no way to supply a table.
 */
export function accessCapabilitiesForTest(input: AccessCapabilityInput,
  implemented: Readonly<Record<AccessHost, readonly BenefitId[]>>): ReadonlySet<BenefitId> {
  return capabilitiesFrom(input, implemented);
}

function capabilitiesFrom(input: AccessCapabilityInput, table: Readonly<Record<AccessHost, readonly BenefitId[]>>): ReadonlySet<BenefitId> {
  const free: BenefitId[] = [...FEATURE_REGISTRY.filter(feature => feature.tier === "free").map(feature => feature.id), "tiktok.all"];
  if (!input.paidMode) return new Set(free);
  const desktopOnly = input.platform !== undefined && input.platform !== "desktop";
  const pro = FEATURE_REGISTRY.filter(feature => feature.tier === "pro").map(feature => feature.id)
    .filter(id => input.host ? table[input.host].includes(id) : ACCESS_HOSTS.every(host => table[host].includes(id)))
    .filter(id => !(desktopOnly && (DESKTOP_ONLY_PRO as readonly BenefitId[]).includes(id)));
  return new Set([...free, ...pro]);
}

/**
 * The packaged access context. Every caller that knows its host passes it (each background, each
 * content entry, each popup/options page). Without a host only the features EVERY host implements
 * count, which is the safe direction: a host-less caller can never claim a control its build does
 * not have, only under-claim one until the host-aware background snapshot arrives.
 */
export function packagedAccessContext(host?: AccessHost, platform?: AccessPlatform): TrustedAccessContext {
  return { paidMode: PAID_TIER_ENABLED, supported: accessCapabilities({ paidMode: PAID_TIER_ENABLED, host, platform }),
    localRights: new Set(), evidenceStatus: "unknown" };
}

export function initialAccessSnapshot(context: Pick<TrustedAccessContext, "paidMode" | "supported"> = packagedAccessContext()): BenefitAccessSnapshot {
  const states = Object.fromEntries(ACCESS_BENEFITS.map(benefit => [benefit,
    !context.supported.has(benefit) ? "unsupported" : !context.paidMode || benefit === "tiktok.all" || FEATURE_REGISTRY.some(f => f.id === benefit && f.tier === "free") ? "free" : "verification_required",
  ])) as Record<BenefitId, AccessState>;
  return Object.freeze({ schema: 1, generation: 0, states: Object.freeze(states), refreshAfterMs: context.paidMode ? 60_000 : null, independentProtection: Object.freeze([]) });
}

export function parseBenefitAccessSnapshot(value: unknown): BenefitAccessSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unreadable benefit snapshot");
  const snapshot = value as Record<string, unknown>;
  if (Object.keys(snapshot).length !== 5 || snapshot.schema !== 1 || !isSafeAccessInteger(snapshot.generation) ||
      !(snapshot.refreshAfterMs === null || (isSafeAccessInteger(snapshot.refreshAfterMs) && snapshot.refreshAfterMs >= 1 && snapshot.refreshAfterMs <= 60_000)) ||
      !snapshot.states || typeof snapshot.states !== "object" || Array.isArray(snapshot.states)) throw new Error("Unreadable benefit snapshot");
  const states = snapshot.states as Record<string, unknown>;
  const allowed = ["free", "purchased", "protected", "checking", "verification_required", "locked", "unsupported"];
  if (Object.keys(states).length !== ACCESS_BENEFITS.length || !ACCESS_BENEFITS.every(benefit => allowed.includes(states[benefit] as string))) throw new Error("Unreadable benefit snapshot");
  if (!Array.isArray(snapshot.independentProtection) || snapshot.independentProtection.length > ACCESS_BENEFITS.length ||
      new Set(snapshot.independentProtection).size !== snapshot.independentProtection.length ||
      !snapshot.independentProtection.every(benefit => ACCESS_BENEFITS.includes(benefit) && ["purchased", "protected"].includes(states[benefit] as string))) throw new Error("Unreadable independent protection");
  return Object.freeze({ schema: 1, generation: snapshot.generation,
    states: Object.freeze({ ...states }) as Readonly<Record<BenefitId, AccessState>>, refreshAfterMs: snapshot.refreshAfterMs as number | null, independentProtection: Object.freeze([...snapshot.independentProtection]) });
}

/** Resolve exactly once per committed host observation. Never interpret a raw envelope as
 * trusted evidence, a legacy Boolean as native right mapping, or a failed lookup as absence. */
export function resolveAccessSnapshot(record: AccessCacheRecord, evidence: readonly ScopedAccessEvidence[], context: TrustedAccessContext): BenefitAccessSnapshot {
  const matchingSession = context.session && context.session.userId === record.accountId && context.session.sessionId === record.sessionId;
  const evidenceStatus = evidence.length !== record.rights.length ? "unknown" : context.evidenceStatus;
  const states = Object.fromEntries(ACCESS_BENEFITS.map(benefit => [benefit, resolveBenefitAccess(benefit, evidence, {
    paidMode: context.paidMode, supported: context.supported.has(benefit),
    free: benefit === "tiktok.all" || FEATURE_REGISTRY.some(feature => feature.id === benefit && feature.tier === "free"),
    accountId: matchingSession ? context.session!.userId : null, localRights: context.localRights,
    localProtection: record.localProtection, evidenceStatus,
  })])) as Record<BenefitId, AccessState>;
  let refreshAfterMs: number | null = context.paidMode ? 60_000 : null;
  for (const right of record.rights) {
    const clock = right.clock;
    if (context.paidMode && clock && !clock.expired && !clock.paused && !clock.revoked && isSafeAccessInteger(clock.highWater) && isSafeAccessInteger(clock.expiresAt)) {
      refreshAfterMs = Math.min(refreshAfterMs ?? 60_000, Math.max(1, clock.expiresAt - clock.highWater));
    }
  }
  const independentProtection = ACCESS_BENEFITS.filter(benefit => ["purchased", "protected"].includes(states[benefit]) &&
    resolveBenefitAccess(benefit, evidence.filter(item => item.proof.claims.kind === "protected_local"), {
      paidMode: true, supported: context.supported.has(benefit), free: false, accountId: null,
      localRights: context.localRights, localProtection: record.localProtection, evidenceStatus: "unknown",
    }) === "protected");
  return Object.freeze({ schema: 1, generation: record.generation, states: Object.freeze(states), refreshAfterMs,
    independentProtection: Object.freeze(independentProtection) });
}

/** Saved intentions only; access/capability changes cannot write settings or enable a saved Off. */
export function isBenefitEffective(settings: SettingsV2, benefit: BenefitId, state: AccessState, capable = true): boolean {
  const service = benefit === "tiktok.all" ? "tiktok" : FEATURE_REGISTRY.find(feature => feature.id === benefit)?.service;
  return capable && ["free", "purchased", "protected"].includes(state) && settings.globalOn && !!service &&
    settings.services[service] === true && (benefit === "tiktok.all" || settings.sites[benefit] === true);
}

/** Read deadlines are runtime resources, never a second paid clock or caller-provided time. */
export const ACCESS_OBSERVATION_DEADLINE_MS = 5_000;
export function boundedAccessRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (value: T | undefined, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const abort = (): void => finish(undefined, new Error("Access observation cancelled"));
    const timer = setTimeout(() => finish(undefined, new Error("Access observation timed out")), ACCESS_OBSERVATION_DEADLINE_MS);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(read).then(value => finish(value), error => finish(undefined, error));
  });
}
