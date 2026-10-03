import * as ed from "@noble/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { RuleSetPayload, SignedRuleSet, RuleSetPayloadV2, SignedRuleSetV2 } from "@still/shared-types";
import { ruleSetSigningBytes, ruleSetSigningBytesV2 } from "./canonical.js";
import { isRuleVersionV2, validateRuleSetV2 } from "./schema.js";
import { compareVersions } from "./version.js";

// Ed25519 signing/verification for rule sets (KTD8). Clients ship an allowlist of trusted public
// keys (current + next rotation) plus a minimum-acceptable version floor. A leaked DB write
// credential alone cannot publish a trusted set, and a key rotation needs no store resubmission.
// The private signing key is human deploy-only and never enters the loop environment (U2).

export interface TrustedKey {
  readonly kid: string;
  readonly publicKeyHex: string;
}

export interface VerifyOptions {
  /** Trusted public keys, selected by the set's `kid`. */
  readonly allowedKeys: readonly TrustedKey[];
  /** Reject any validly-signed set below this version (rollback defense). */
  readonly minVersion: string;
}

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Sign a payload (used by the publisher / by tests with a throwaway key — never in the loop). */
export async function signRuleSet(
  payload: RuleSetPayload,
  privateKeyHex: string,
  kid: string,
): Promise<SignedRuleSet> {
  const sig = await ed.signAsync(ruleSetSigningBytes(payload), hexToBytes(privateKeyHex));
  return { ...payload, signature: { kid, alg: "ed25519", value: bytesToHex(sig) } };
}

/** Derive the public key hex for a private key (used by the signing script to print the allowlist). */
export async function publicKeyHexFor(privateKeyHex: string): Promise<string> {
  return bytesToHex(await ed.getPublicKeyAsync(hexToBytes(privateKeyHex)));
}

/**
 * Verify a fetched rule set before it may be swapped in: known `kid`, version at/above the floor,
 * and a cryptographically valid Ed25519 signature over the canonical payload.
 */
export async function verifyRuleSet(set: SignedRuleSet, opts: VerifyOptions): Promise<VerifyResult> {
  const key = opts.allowedKeys.find((k) => k.kid === set.signature.kid);
  if (!key) return { ok: false, reason: `unknown signing kid '${set.signature.kid}'` };
  if (compareVersions(set.version, opts.minVersion) < 0) {
    return { ok: false, reason: `version ${set.version} below floor ${opts.minVersion}` };
  }
  let valid: boolean;
  try {
    valid = await ed.verifyAsync(
      hexToBytes(set.signature.value),
      ruleSetSigningBytes(set),
      hexToBytes(key.publicKeyHex),
    );
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: "signature verification failed" };
}

/** Opt-in signing foundation; never publishes, fetches or activates a new format. */
export async function signRuleSetV2(
  payload: RuleSetPayloadV2,
  privateKeyHex: string,
  kid: string,
): Promise<SignedRuleSetV2> {
  // Preserve descriptors for admission instead of invoking a caller-supplied getter by spreading.
  const candidate: unknown = Object.defineProperty(
    Object.create(Object.getPrototypeOf(payload), Object.getOwnPropertyDescriptors(payload)),
    "signature", { enumerable: true, value: { kid, alg: "ed25519", value: "00".repeat(64) } },
  );
  const validation = validateRuleSetV2(candidate);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  const set = validation.value;
  const sig = await ed.signAsync(ruleSetSigningBytesV2(set), hexToBytes(privateKeyHex));
  return { ...set, signature: { kid, alg: "ed25519", value: bytesToHex(sig) } };
}

/** Shape admission and exact canonical signature verification, using the caller's build trust. */
export async function verifyRuleSetV2(input: unknown, opts: VerifyOptions): Promise<VerifyResult> {
  const validation = validateRuleSetV2(input);
  if (!validation.ok) return { ok: false, reason: validation.errors.join("; ") };
  const set = validation.value;
  if (!isRuleVersionV2(opts.minVersion)) return { ok: false, reason: "invalid format 2 version floor" };
  const key = opts.allowedKeys.find((candidate) => candidate.kid === set.signature.kid);
  if (!key) return { ok: false, reason: `unknown signing kid '${set.signature.kid}'` };
  if (compareVersions(set.version, opts.minVersion) < 0) return { ok: false, reason: `version ${set.version} below floor ${opts.minVersion}` };
  try {
    const valid = await ed.verifyAsync(hexToBytes(set.signature.value), ruleSetSigningBytesV2(set), hexToBytes(key.publicKeyHex));
    return valid ? { ok: true } : { ok: false, reason: "signature verification failed" };
  } catch {
    return { ok: false, reason: "signature verification failed" };
  }
}
