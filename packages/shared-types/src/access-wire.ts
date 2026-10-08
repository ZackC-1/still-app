import type { AccessClaims } from "./access.js";

/** The single canonical signed wire grammar used by issuer and verifier. */
export function canonicalAccessClaims(claims: AccessClaims): string {
  const paid = claims.kind === "paid_account" || claims.kind === "paid_apple_local";
  return JSON.stringify({ schema: claims.schema, issuer: claims.issuer, environment: claims.environment,
    audience: claims.audience, kind: claims.kind, provenance: claims.provenance, right: claims.right,
    holder: claims.holder, product: claims.product, benefits: claims.benefits,
    ownership_revision: claims.ownership_revision, verified_at: claims.verified_at,
    ...(paid ? { expires_at: claims.expires_at } : {}),
  });
}

export function accessSigningBytes(payload: string): Uint8Array {
  return new TextEncoder().encode("still-access-proof-v1\n" + payload);
}

export function encodeAccessBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
