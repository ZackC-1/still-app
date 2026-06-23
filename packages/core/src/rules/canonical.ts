import type { RuleSetPayload } from "@still/shared-types";
import { utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Deterministic JSON serialization: object keys sorted recursively, arrays order-preserved, no
 * insignificant whitespace. Signing and verification both run over this exact string, so a set
 * signed by the publisher verifies byte-for-byte on the client regardless of key ordering.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortDeep(source[key]);
    }
    return out;
  }
  return value;
}

/** The exact bytes signed/verified: canonical JSON of `{ version, services }` (no signature field). */
export function ruleSetSigningBytes(payload: RuleSetPayload): Uint8Array {
  return utf8ToBytes(canonicalize({ version: payload.version, services: payload.services }));
}
