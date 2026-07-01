import type { SignedRuleSet } from "@still/shared-types";
import { fetchCurrentRuleSet, resolveRuleSet } from "./fetch.js";
import type { FetchConfig, ResolvedRuleSet, RuleSetEndpoint } from "./fetch.js";
import type { TrustedKey } from "./signature.js";
import {
  DEV_RULE_SET_KEYS,
  PRODUCTION_RULE_SET_KEYS,
  RULE_SET_MIN_VERSION,
} from "./trusted-keys.js";

// The extension rule-set loader — the ONE wiring every extension build shares (Safari, Chromium,
// Firefox). The content script applies the newest of {cached, bundled}; the background fetches +
// verifies + caches the current signed set for the next load. Reuses the U12 fetch/verify/cache
// machinery verbatim — no new crypto here. Living in core (not per-extension) is what makes the
// over-the-air selector-hotfix capability reach every store, not just Safari.
//
// Safety with empty production keys: a PRODUCTION build trusts ONLY PRODUCTION_RULE_SET_KEYS (empty
// until the human publishes them) — so nothing verifies, fetch returns null, and the bundled seed is
// used. The dev key is NEVER trusted in a production build.

const CACHE_KEY = "still:ruleset";

/** Trusted signing keys for THIS build: prod build → PRODUCTION_RULE_SET_KEYS only; dev build → the
 * dev key (so the fetch/verify path is exercised end-to-end against the dev-signed seed). */
export function ruleSetTrustedKeys(prod: boolean): readonly TrustedKey[] {
  return prod ? PRODUCTION_RULE_SET_KEYS : DEV_RULE_SET_KEYS;
}

/** Build the fetch config, or null when fetching should be skipped: no endpoint configured (CI/dev
 * with no .env), or no trusted keys for this build (a prod build before prod keys are published). */
export function ruleSetFetchConfig(input: {
  prod: boolean;
  endpoint: RuleSetEndpoint | null;
}): FetchConfig | null {
  if (!input.endpoint) return null;
  const allowedKeys = ruleSetTrustedKeys(input.prod);
  if (allowedKeys.length === 0) return null;
  return { endpoint: input.endpoint, allowedKeys, minVersion: RULE_SET_MIN_VERSION };
}

// Minimal storage-area shapes so these are testable with a fake (no webextension polyfill needed).
export interface ReadableArea {
  get(key: string): Promise<Record<string, unknown>>;
}
export interface WritableArea {
  set(items: Record<string, unknown>): Promise<void>;
}

export async function readCachedRuleSet(area: ReadableArea): Promise<SignedRuleSet | null> {
  try {
    const got = await area.get(CACHE_KEY);
    const val = got[CACHE_KEY];
    return val && typeof val === "object" ? (val as SignedRuleSet) : null;
  } catch {
    return null; // storage unavailable → bundled seed still applies
  }
}

export async function writeCachedRuleSet(area: WritableArea, set: SignedRuleSet): Promise<void> {
  try {
    await area.set({ [CACHE_KEY]: set });
  } catch {
    /* non-fatal: the bundled seed still applies, and the next load retries the fetch */
  }
}

/**
 * Background refresh: fetch + verify the current signed set and cache it for the NEXT page load.
 * Returns the verified set, or null on any failure / skip. Never throws — the content script always
 * has the bundled seed regardless.
 */
export async function refreshRuleSetCache(
  cfg: FetchConfig | null,
  area: WritableArea,
): Promise<SignedRuleSet | null> {
  if (!cfg) return null;
  const fetched = await fetchCurrentRuleSet(cfg);
  if (fetched) await writeCachedRuleSet(area, fetched);
  return fetched;
}

/**
 * Content-load resolution: the newest of {cached, bundled}. Content never blocks on the network — the
 * background's fetch lands in the cache for the next load, and storage is a fast local read here.
 */
export async function resolveRuleSetForLoad(
  bundled: SignedRuleSet,
  area: ReadableArea,
): Promise<ResolvedRuleSet> {
  const cached = await readCachedRuleSet(area);
  return resolveRuleSet({ bundled, cached });
}
