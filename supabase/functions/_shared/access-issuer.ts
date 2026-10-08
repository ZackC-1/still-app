import {
  accessSigningBytes, canonicalAccessClaims, encodeAccessBase64,
  PAID_ACCESS_WINDOW_MS, STILL_PRO_V3_BENEFITS,
  type AccessClaims, type AccessEnvironment,
} from "@still/shared-types";

export interface ProviderRight {
  readonly key: string; readonly product: "still_pro_v3" | "still_sync";
  /** Only canonical provider status can revoke an individual known transaction. Absence cannot. */
  readonly state?: "revoked";
}
export interface AccountRight {
  readonly right: string; readonly holder: string; readonly revision: number; readonly verified_at: number;
}
export type CommittedAccess = {
  readonly status: "committed" | "conflict"; readonly rights: readonly AccountRight[]; readonly issuer_time: number;
  /** Freshly observed RC rows only; independent/unobserved ledger rows retain their old clock. */
  readonly observed_rights?: readonly AccountRight[];
  readonly revocations: readonly { readonly right: string; readonly revision: number }[];
} | { readonly status: "stale" };
/** Negative observations only. The holder/environment are checked again at the HTTP boundary. */
export interface AccountAccessRemovals {
  readonly holder: string; readonly environment: AccessEnvironment;
  readonly revocations: readonly { readonly right: string; readonly revision: number }[];
  readonly issuer_time: number;
}
export function isAccountAccessRemovals(value: unknown, holder: string, environment: AccessEnvironment): value is AccountAccessRemovals {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 4 || !["holder", "environment", "revocations", "issuer_time"].every(key => Object.hasOwn(v, key)) ||
      v.holder !== holder || v.environment !== environment || !UUID.test(holder) || !safe(v.issuer_time) ||
      !Array.isArray(v.revocations) || !v.revocations.length || v.revocations.length > 64) return false;
  const ids = new Set<string>();
  for (const value of v.revocations) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const r = value as Record<string, unknown>;
    if (Object.keys(r).length !== 2 || typeof r.right !== "string" || !UUID.test(r.right) || !safe(r.revision) || ids.has(r.right)) return false;
    ids.add(r.right);
  }
  return true;
}
export interface AccessRightStore {
  begin(holder: string, environment: AccessEnvironment): Promise<string>;
  commit(holder: string, environment: AccessEnvironment, token: string, rights: readonly ProviderRight[]): Promise<CommittedAccess>;
  confirm(holder: string, environment: AccessEnvironment, token: string): Promise<boolean>;
  /** Optional for older deployments; absence yields plain unavailable, never inferred removal. */
  removals?(holder: string, environment: AccessEnvironment, token: string): Promise<AccountAccessRemovals | null>;
}
export interface AccessSigner {
  readonly environment: AccessEnvironment;
  sign(right: AccountRight, kind?: "paid_account" | "paid_apple_local"): Promise<string>;
  signAppleBinding?(binding: AppleRightBinding): Promise<string>;
}

export interface AppleRightBinding {
  readonly schema: 1; readonly environment: AccessEnvironment; readonly appBundleId: string;
  readonly productId: "still_pro_v3"; readonly originalTransactionId: string; readonly right: string;
  readonly ownershipRevision: number; readonly verifiedAt: number; readonly expiresAt: number;
}
export function canonicalAppleRightBinding(binding: AppleRightBinding): string {
  return JSON.stringify({ schema: binding.schema, environment: binding.environment, appBundleId: binding.appBundleId,
    productId: binding.productId, originalTransactionId: binding.originalTransactionId, right: binding.right,
    ownershipRevision: binding.ownershipRevision, verifiedAt: binding.verifiedAt, expiresAt: binding.expiresAt });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const safe = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Imports existing secret material only. No key generation or client-selected environment/key.
 * A bad/missing pair disables issuance; proof keys are independent of auth and rule keys. */
export async function createAccessSigner(config: {
  readonly environment?: string; readonly kid?: string; readonly privateKeyPkcs8Base64?: string; readonly publicKeyHex?: string;
}): Promise<AccessSigner | null> {
  const { environment, kid, privateKeyPkcs8Base64, publicKeyHex } = config;
  if ((environment !== "sandbox" && environment !== "production") || !kid ||
      !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(kid) || !privateKeyPkcs8Base64 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(privateKeyPkcs8Base64) || !publicKeyHex || !/^[0-9a-f]{64}$/.test(publicKeyHex)) return null;
  try {
    const secret = Uint8Array.from(atob(privateKeyPkcs8Base64), c => c.charCodeAt(0));
    const publicBytes = Uint8Array.from(publicKeyHex.match(/../g)!, b => parseInt(b, 16));
    const privateKey = await crypto.subtle.importKey("pkcs8", secret, "Ed25519", false, ["sign"]);
    secret.fill(0);
    const publicKey = await crypto.subtle.importKey("raw", publicBytes, "Ed25519", false, ["verify"]);
    const challenge = new TextEncoder().encode(`still-access-key-check-v1:${environment}:${kid}`);
    const check = await crypto.subtle.sign("Ed25519", privateKey, challenge);
    if (!await crypto.subtle.verify("Ed25519", publicKey, check, challenge)) return null;
    return {
      environment,
      async sign(right, kind = "paid_account") {
        if (!UUID.test(right.right) || !UUID.test(right.holder) || !safe(right.revision) || !safe(right.verified_at) ||
            !safe(right.verified_at + PAID_ACCESS_WINDOW_MS) ||
            (kind !== "paid_account" && kind !== "paid_apple_local") || (kind === "paid_apple_local" && right.holder !== right.right)) throw new Error("Invalid access right");
        const claims: AccessClaims = { schema: 1, issuer: "still-access", environment, audience: "still-app",
          kind, provenance: "provider_verified", right: right.right, holder: right.holder,
          product: "still-pro-v3", benefits: STILL_PRO_V3_BENEFITS, ownership_revision: right.revision,
          verified_at: right.verified_at, expires_at: right.verified_at + PAID_ACCESS_WINDOW_MS };
        const canonical = canonicalAccessClaims(claims);
        const signature = await crypto.subtle.sign("Ed25519", privateKey, new Uint8Array(accessSigningBytes(canonical)));
        return JSON.stringify({ payload: encodeAccessBase64(new TextEncoder().encode(canonical)), kid,
          alg: "ed25519", signature: encodeAccessBase64(new Uint8Array(signature)) });
      },
      async signAppleBinding(binding) {
        if (binding.schema !== 1 || binding.environment !== environment || !UUID.test(binding.right) ||
          !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(binding.appBundleId) || binding.appBundleId.length > 160 ||
          binding.productId !== "still_pro_v3" || !/^[1-9][0-9]{0,39}$/.test(binding.originalTransactionId) ||
          !safe(binding.ownershipRevision) || !safe(binding.verifiedAt) || !safe(binding.expiresAt) ||
          binding.expiresAt !== binding.verifiedAt + PAID_ACCESS_WINDOW_MS) throw new Error("Invalid Apple binding");
        const payload = canonicalAppleRightBinding(binding);
        const bytes = new TextEncoder().encode("still-apple-right-binding-v1\n" + payload);
        const signature = await crypto.subtle.sign("Ed25519", privateKey, bytes);
        return JSON.stringify({ payload: encodeAccessBase64(new TextEncoder().encode(payload)), kid,
          alg: "ed25519", signature: encodeAccessBase64(new Uint8Array(signature)) });
      },
    };
  } catch { return null; }
}
