import type { SignedRuleSet, SignedRuleSetV2 } from "@still/shared-types";
import { fetchCurrentRuleSet, resolveRuleSet } from "./fetch.js";
import type {
  AnySignedRuleSet,
  FetchConfig,
  ResolvedRuleSet,
  RuleFormat,
  RuleSetFor,
  RuleSetEndpoint,
} from "./fetch.js";
import { validateRuleSet, validateRuleSetV2 } from "./schema.js";
import {
  verifyRuleSet,
  verifyRuleSetV2,
  type TrustedKey,
  type VerifyOptions,
} from "./signature.js";
import { compareVersions } from "./version.js";
import {
  DEV_RULE_SET_KEYS,
  PRODUCTION_RULE_SET_KEYS,
  RULE_SET_MIN_VERSION,
} from "./trusted-keys.js";

// The extension rule-set loader — the ONE wiring every extension build shares (Safari, Chromium,
// Firefox). The content script applies the newest of {cached, bundled}; the background fetches +
// verifies + caches the current signed set for the next load. Reuses the U12 fetch/verify/cache
// machinery verbatim — no new crypto here. Living in core (not per-extension) is what makes the
// over-the-air rule-set capability reach every store. Legacy fetched sets use the existing hide
// sweep. The internal format2 lane uses the compiled scoped stylesheet; it never inherits the
// legacy bundle's manifest-CSS ownership (ADR-0002).
//
// Empty-production-key fail-safe: a PRODUCTION build trusts ONLY PRODUCTION_RULE_SET_KEYS. If that
// list is empty, nothing verifies, fetching is skipped, and the bundled seed is used. The dev key
// is NEVER trusted in a production build.

const CACHE_KEY = "still:ruleset";
const cacheKey = (format?: RuleFormat): string =>
  format === 2 ? `${CACHE_KEY}:format2` : CACHE_KEY;

/** Trusted signing keys for THIS build: prod build → PRODUCTION_RULE_SET_KEYS only; dev build → the
 * dev key (so the fetch/verify path is exercised end-to-end against the dev-signed seed). */
export function ruleSetTrustedKeys(prod: boolean): readonly TrustedKey[] {
  return prod ? PRODUCTION_RULE_SET_KEYS : DEV_RULE_SET_KEYS;
}

/** Build the fetch config, or null when fetching should be skipped: no endpoint configured (CI/dev
 * with no .env), or no trusted keys for this build (the production-key fail-safe). */
export function ruleSetFetchConfig<F extends RuleFormat = 1>(input: {
  prod: boolean;
  endpoint: RuleSetEndpoint | null;
  format?: F;
}): FetchConfig<F> | null {
  if (!input.endpoint) return null;
  const allowedKeys = ruleSetTrustedKeys(input.prod);
  if (allowedKeys.length === 0) return null;
  return {
    endpoint: input.endpoint,
    allowedKeys,
    minVersion: RULE_SET_MIN_VERSION,
    ...(input.format ? { format: input.format } : {}),
  };
}

// Minimal storage-area shapes so these are testable with a fake (no webextension polyfill needed).
export interface ReadableArea {
  get(key: string): Promise<Record<string, unknown>>;
}
export interface WritableArea {
  set(items: Record<string, unknown>): Promise<void>;
}

/** Build the one reusable background refresh closure from plain build-time values. Keeping the env
 * read in each entrypoint leaves core platform-neutral while ensuring cold-start and reconcile
 * nudges share precisely the same fail-closed fetch configuration. */
export function createRuleSetRefresher<F extends RuleFormat = 1>(input: {
  readonly prod: boolean;
  readonly url: string | undefined;
  readonly anonKey: string | undefined;
  readonly area: ReadableArea & WritableArea;
  /** Test seam; production uses the platform fetch implementation. */
  readonly fetchImpl?: typeof fetch;
  readonly format?: F;
}): () => Promise<RuleSetFor<F> | null> {
  const endpoint =
    input.url && input.anonKey
      ? { url: input.url, anonKey: input.anonKey }
      : null;
  const baseCfg = ruleSetFetchConfig({
    prod: input.prod,
    endpoint,
    format: input.format,
  });
  const cfg =
    baseCfg &&
    (input.fetchImpl ? { ...baseCfg, fetchImpl: input.fetchImpl } : baseCfg);
  return () => refreshRuleSetCache(cfg, input.area);
}

/** The trust anchor a cached rule set must satisfy before it may beat the bundled seed — the same
 * shape signature verification takes (alias, not a parallel type, so the two can't drift). */
export type RuleSetTrust<F extends RuleFormat = 1> = VerifyOptions & {
  readonly format?: F;
};

/** This build's trust anchor: prod keys in prod, the dev key in dev (mirrors ruleSetTrustedKeys). */
export function ruleSetTrust<F extends RuleFormat = 1>(
  prod: boolean,
  format?: F,
): RuleSetTrust<F> {
  return {
    allowedKeys: ruleSetTrustedKeys(prod),
    minVersion: RULE_SET_MIN_VERSION,
    ...(format ? { format } : {}),
  };
}

/**
 * Read + RE-VERIFY the cached rule set against THIS build's trust anchor. The write path only
 * stores verified sets, but extension storage outlives builds: a dev-signed cache surviving a
 * dev→prod upgrade, a key removed by rotation, or a malformed blob must not beat the bundled seed
 * by version. Schema-validate and signature-verify on every read; any failure → null (bundled
 * seed applies).
 */
export async function readCachedRuleSet<F extends RuleFormat = 1>(
  area: ReadableArea,
  trust: RuleSetTrust<F>,
): Promise<RuleSetFor<F> | null> {
  try {
    const key = cacheKey(trust.format);
    const got = await area.get(key);
    const val = got[key];
    if (!val || typeof val !== "object") return null;
    const validation =
      trust.format === 2 ? validateRuleSetV2(val) : validateRuleSet(val);
    if (!validation.ok) return null;
    const snapshot = validation.value;
    const verdict =
      trust.format === 2
        ? await verifyRuleSetV2(snapshot, trust)
        : await verifyRuleSet(snapshot as SignedRuleSet, trust);
    return verdict.ok ? (snapshot as RuleSetFor<F>) : null;
  } catch {
    return null; // storage unavailable → bundled seed still applies
  }
}

export async function writeCachedRuleSet(
  area: WritableArea,
  set: AnySignedRuleSet,
): Promise<void> {
  try {
    if ("format" in set) {
      const validation = validateRuleSetV2(set);
      if (!validation.ok) return;
      await area.set({ [cacheKey(2)]: validation.value });
    } else await area.set({ [CACHE_KEY]: set });
  } catch {
    /* non-fatal: the bundled seed still applies, and the next load retries the fetch */
  }
}

/** One in-flight refresh per format (R6 single-flight). Each extension background has one
 * equivalent config per format; the internal opt-in lane cannot inherit a legacy flight/result. */
const refreshInFlight = new Map<RuleFormat, Promise<AnySignedRuleSet | null>>();

/**
 * Background refresh: fetch + verify the current signed set and cache it for the NEXT page load.
 * Returns the verified set, or null on any failure / skip. Never throws — the content script always
 * has the bundled seed regardless. A fetched set is only persisted when STRICTLY newer than the
 * existing (verified) cache, so a rolled-back or stale deployment can't clobber a newer hotfix.
 *
 * Single-flight (R6): N service tabs navigating at once fire N concurrent refreshes against the one
 * cache slot; callers arriving while a refresh is in flight share ITS promise instead of fanning out
 * parallel fetch+read+write passes (the write-side version compare already made the race benign —
 * this is fan-out elimination, not a correctness fix). The slot clears in a finally, so a later call
 * fetches fresh and a rejection (fetchCurrentRuleSet never throws, but defensively) can't wedge it.
 */
export function refreshRuleSetCache<F extends RuleFormat = 1>(
  cfg: FetchConfig<F> | null,
  area: ReadableArea & WritableArea,
): Promise<RuleSetFor<F> | null> {
  if (!cfg) return Promise.resolve(null);
  const format = cfg.format ?? 1;
  const existing = refreshInFlight.get(format);
  if (existing) return existing as Promise<RuleSetFor<F> | null>;
  const flight = (async (): Promise<RuleSetFor<F> | null> => {
    const fetched = await fetchCurrentRuleSet(cfg);
    if (!fetched) return null;
    const cached = await readCachedRuleSet(area, cfg); // FetchConfig carries the trust fields
    if (!cached || compareVersions(fetched.version, cached.version) > 0) {
      await writeCachedRuleSet(area, fetched);
    }
    return fetched;
  })().finally(() => {
    if (refreshInFlight.get(format) === flight) refreshInFlight.delete(format);
  });
  refreshInFlight.set(format, flight);
  return flight;
}

/**
 * Content-load resolution: the newest of {cached, bundled}, with the cache re-verified against this
 * build's trust anchor. Content never blocks on the network — the background's fetch lands in the
 * cache for the next load, and storage is a fast local read here.
 */
export function resolveRuleSetForLoad(
  bundled: SignedRuleSetV2,
  area: ReadableArea,
  trust: VerifyOptions,
): Promise<ResolvedRuleSet<SignedRuleSetV2>>;
export function resolveRuleSetForLoad(
  bundled: SignedRuleSet,
  area: ReadableArea,
  trust: VerifyOptions,
): Promise<ResolvedRuleSet>;
export async function resolveRuleSetForLoad(
  bundled: AnySignedRuleSet,
  area: ReadableArea,
  trust: VerifyOptions,
): Promise<ResolvedRuleSet<AnySignedRuleSet>> {
  if ("format" in bundled) {
    const validation = validateRuleSetV2(bundled);
    if (!validation.ok) throw new Error("Invalid packaged format2 rule set");
    const cached = await readCachedRuleSet(area, { ...trust, format: 2 });
    return resolveRuleSet({ bundled: validation.value, cached });
  }
  const cached = await readCachedRuleSet(area, trust);
  return resolveRuleSet({ bundled, cached });
}
