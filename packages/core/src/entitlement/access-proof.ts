import * as ed from "@noble/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  FEATURE_IDS, PAID_ACCESS_WINDOW_MS, STILL_PRO_V3_BENEFITS,
  type AccessClaims, type AccessEnvelope, type AccessEnvironment, type BenefitId,
  type ProtectedBenefitSnapshot,
  canonicalAccessClaims, accessSigningBytes, encodeAccessBase64,
} from "@still/shared-types";

export { canonicalAccessClaims, accessSigningBytes, encodeAccessBase64 } from "@still/shared-types";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const BASE_KEYS = ["schema", "issuer", "environment", "audience", "kind", "provenance", "right", "holder", "product", "benefits", "ownership_revision", "verified_at"];
const BENEFITS = new Set<string>([...FEATURE_IDS, "tiktok.all"]);
const PAIRS: Readonly<Record<string, readonly string[]>> = {
  paid_account: ["provider_verified", "owner_attested_legacy_paid"],
  paid_apple_local: ["provider_verified"],
  protected_local: ["legacy_free_verified"],
  protected_account: ["legacy_free_verified", "free_self_declaration"],
};
const verified = new WeakSet<object>();

export interface AccessTrust {
  readonly environment: AccessEnvironment;
  readonly keys: readonly { readonly kid: string; readonly publicKeyHex: string; readonly purpose: "access"; readonly environment: AccessEnvironment }[];
  readonly protectedSnapshot?: ProtectedBenefitSnapshot;
}

export interface VerifiedAccessProof {
  readonly claims: AccessClaims;
  readonly envelope: AccessEnvelope;
  /** Exact signature identifies cache context; this is not an analytics/device identifier. */
  readonly identity: string;
}
export type AccessProofResult = { readonly status: "verified"; readonly proof: VerifiedAccessProof } | { readonly status: "invalid" | "unsupported" | "verification_required" };

export function isVerifiedAccessProof(value: VerifiedAccessProof): boolean { return verified.has(value); }
export function isSafeAccessInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function isAccessUUID(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
export function isPaidAccess(claims: AccessClaims): boolean { return claims.kind === "paid_account" || claims.kind === "paid_apple_local"; }

function decodeBase64(value: unknown, max: number): Uint8Array | null {
  if (typeof value !== "string" || !B64.test(value) || value.length > Math.ceil(max * 4 / 3) || value.length % 4 === 1) return null;
  try {
    const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
    return bytes.length <= max && encodeAccessBase64(bytes) === value ? bytes : null;
  } catch { return null; }
}


/** Text admission is deliberate: duplicate members cannot be detected after JSON.parse. */
export async function verifyAccessProof(text: string, trust: AccessTrust): Promise<AccessProofResult> {
  const invalid = { status: "invalid" } as const;
  if (typeof text !== "string" || text.length > 6_144) return invalid;
  try {
    const envelope: unknown = JSON.parse(text);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return invalid;
    const e = envelope as Record<string, unknown>;
    if (Object.keys(e).length !== 4 || !["payload", "kid", "alg", "signature"].every(k => Object.hasOwn(e, k))) return invalid;
    if (e.alg !== "ed25519" || typeof e.kid !== "string" || !ID.test(e.kid)) return invalid;
    // Envelope values are closed ASCII strings. Whitespace removal is safe only after rejecting
    // all escapes and whitespace within strings; round-trip then detects duplicate/unknown keys.
    if (/\\/.test(text) || !/^\s*\{(?:\s*"[A-Za-z_]+"\s*:\s*"[A-Za-z0-9_.-]+"\s*,?\s*)+\}\s*$/.test(text)) return invalid;
    if (text.replace(/\s/g, "") !== JSON.stringify(e)) return invalid;
    const payload = decodeBase64(e.payload, 4096), signature = decodeBase64(e.signature, 64);
    if (!payload || !signature || signature.length !== 64) return invalid;
    const key = trust.keys.find(k => k.kid === e.kid && k.purpose === "access" && k.environment === trust.environment);
    if (!key || !/^[0-9a-f]{64}$/.test(key.publicKeyHex)) return invalid;
    const publicKey = hexToBytes(key.publicKeyHex);
    const point = ed.Point.fromBytes(publicKey, false);
    if (point.isSmallOrder() || !point.isTorsionFree()) return invalid;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    if (!(await ed.verifyAsync(signature, accessSigningBytes(decoded), publicKey, { zip215: false }))) return invalid;
    const raw: unknown = JSON.parse(decoded);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid;
    const c = raw as Record<string, unknown>;
    if (isSafeAccessInteger(c.schema) && c.schema > 1) return { status: "unsupported" };
    if (c.schema !== 1 || c.issuer !== "still-access" || c.environment !== trust.environment || c.audience !== "still-app") return invalid;
    if (typeof c.kind !== "string" || typeof c.provenance !== "string" || !PAIRS[c.kind]?.includes(c.provenance)) return invalid;
    const paid = c.kind === "paid_account" || c.kind === "paid_apple_local";
    const keys = paid ? [...BASE_KEYS, "expires_at"] : BASE_KEYS;
    if (Object.keys(c).length !== keys.length || !keys.every(k => Object.hasOwn(c, k))) return invalid;
    if (!isAccessUUID(c.right) || !isAccessUUID(c.holder) || !isSafeAccessInteger(c.ownership_revision) || !isSafeAccessInteger(c.verified_at)) return invalid;
    if (paid && (!isSafeAccessInteger(c.expires_at) || c.expires_at !== c.verified_at + PAID_ACCESS_WINDOW_MS)) return invalid;
    if (typeof c.product !== "string" || !ID.test(c.product) || !Array.isArray(c.benefits) || c.benefits.length === 0 || c.benefits.length > 32) return invalid;
    if (!c.benefits.every((b, i, all) => typeof b === "string" && BENEFITS.has(b) && (i === 0 || all[i - 1] < b))) return invalid;
    const claims = c as unknown as AccessClaims;
    if (canonicalAccessClaims(claims) !== decoded) return invalid;
    const snapshot = paid ? { product: "still-pro-v3", benefits: STILL_PRO_V3_BENEFITS } : trust.protectedSnapshot;
    if (!snapshot) return { status: "verification_required" };
    if (c.product !== snapshot.product || !c.benefits.every(b => snapshot.benefits.includes(b as BenefitId))) return invalid;
    const proof = Object.freeze({ claims: Object.freeze({ ...claims, benefits: Object.freeze([...claims.benefits]) }),
      envelope: Object.freeze(e as unknown as AccessEnvelope), identity: `${e.kid}:${bytesToHex(signature)}` });
    verified.add(proof);
    return { status: "verified", proof };
  } catch { return invalid; }
}
