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
 * Read a response body as text while BOUNDING memory by `maxBytes` (a true cap, not a post-hoc
 * assertion). Rejects (returns null) up front on a `Content-Length` over the cap and on any
 * `Content-Encoding` (a small compressed body could decompress past the cap — the first-party rule-set
 * RPC needn't compress a ≤256 KB JSON payload). Otherwise streams the body, decoding with
 * `TextDecoder({ stream: true })` so multibyte characters split across chunk boundaries reassemble
 * correctly, and aborts once accumulated bytes exceed the cap. There is intentionally no `res.text()`
 * fallback — that would re-buffer the whole body and reopen the OOM/DoS path this guards.
 */
async function readCappedBody(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string | null> {
  if (res.headers.get("content-encoding")) return null;
  const declared = res.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) return null;
  if (!res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      controller.abort();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode(); // flush any trailing multibyte state
  return text;
}

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
    const text = await readCappedBody(res, cfg.maxBytes ?? DEFAULT_MAX_BYTES, controller);
    if (text === null) return null; // oversized / compressed / no readable body
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
