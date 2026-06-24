import type { SignedRuleSet } from "@still/shared-types";
import { validateRuleSet } from "./schema.js";
import { verifyRuleSet, type TrustedKey } from "./signature.js";
import { compareVersions } from "./version.js";

// Runtime rule-set fetch with bundled fallback (R11, KTD13). A fetched set is treated strictly as
// data: short timeout, size cap, full schema + safe-CSS validation, Ed25519 signature verification
// against the client key allowlist (reject unknown kid / below the version floor), and it is only
// adopted if strictly newer. Any failure falls through to the cached, then bundled, set.

export interface RuleSetEndpoint {
  /** Supabase project URL, e.g. https://xxxx.supabase.co */
  readonly url: string;
  readonly anonKey: string;
  /** Defaults to the current-only RPC. */
  readonly rpc?: string;
}

export interface FetchConfig {
  readonly endpoint: RuleSetEndpoint;
  readonly allowedKeys: readonly TrustedKey[];
  readonly minVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Fetch + fully validate + verify the current rule set. Returns the verified set, or null on any
 * failure (offline, timeout, oversized, malformed, bad/unknown signature, below floor) — callers
 * fall back to cache/bundled.
 */
export async function fetchCurrentRuleSet(cfg: FetchConfig): Promise<SignedRuleSet | null> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const rpc = cfg.endpoint.rpc ?? "get_current_rule_set";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(`${cfg.endpoint.url}/rest/v1/rpc/${rpc}`, {
      method: "POST",
      headers: {
        apikey: cfg.endpoint.anonKey,
        Authorization: `Bearer ${cfg.endpoint.anonKey}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > (cfg.maxBytes ?? DEFAULT_MAX_BYTES)) return null; // size cap
    const parsed: unknown = JSON.parse(text);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row || typeof row !== "object") return null;
    const { payload, signature } = row as { payload?: Record<string, unknown>; signature?: unknown };
    const candidate = { ...(payload ?? {}), signature };

    const validation = validateRuleSet(candidate);
    if (!validation.ok) return null;
    const verdict = await verifyRuleSet(validation.value, {
      allowedKeys: cfg.allowedKeys,
      minVersion: cfg.minVersion,
    });
    return verdict.ok ? validation.value : null;
  } catch {
    return null; // offline / abort / parse error
  } finally {
    clearTimeout(timer);
  }
}

export type RuleSetSource = "fetched" | "cached" | "bundled";

export interface ResolvedRuleSet {
  readonly ruleSet: SignedRuleSet;
  readonly source: RuleSetSource;
}

/**
 * Pick the rule set to apply: the newest of {fetched, cached, bundled}. The bundled set is always
 * present and trusted (packaged with the signed extension); fetched is already verified by
 * fetchCurrentRuleSet; cached was verified when stored. Ties prefer fetched, then cached.
 */
export function resolveRuleSet(input: {
  bundled: SignedRuleSet;
  cached?: SignedRuleSet | null;
  fetched?: SignedRuleSet | null;
}): ResolvedRuleSet {
  const ordered: Array<{ set: SignedRuleSet; source: RuleSetSource }> = [];
  if (input.fetched) ordered.push({ set: input.fetched, source: "fetched" });
  if (input.cached) ordered.push({ set: input.cached, source: "cached" });
  ordered.push({ set: input.bundled, source: "bundled" });

  let best = ordered[0]!;
  for (const candidate of ordered.slice(1)) {
    if (compareVersions(candidate.set.version, best.set.version) > 0) best = candidate;
  }
  return { ruleSet: best.set, source: best.source };
}
