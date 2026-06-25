// JWT verify/sign over Web Crypto. The reconcile/account functions verify the user JWT in-handler
// (defense in depth over the platform's verify_jwt=true) so the subject UUID comes only from a
// cryptographically valid token — never the request body (KTD5 IDOR defense).
//
// `verifyJwt` dispatches on the token's `alg`: HS256 against a symmetric secret (local Supabase, and
// the legacy project secret) and ES256 against the project's JWKS public key (hosted Supabase issues
// asymmetric ES256 access tokens by default). An unsupported/absent alg fails closed.

export interface JwtPayload {
  sub?: string;
  exp?: number;
  iss?: string;
  aud?: string | string[];
  role?: string;
  [key: string]: unknown;
}

function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function verifyHs256(token: string, secret: string, now: number = Date.now()): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const key = await hmacKey(secret, "verify");
  const data = utf8(`${header}.${payload}`);
  let valid = false;
  try {
    valid = await crypto.subtle.verify("HMAC", key, base64urlToBytes(signature), data);
  } catch {
    return null;
  }
  if (!valid) return null;
  let claims: JwtPayload;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64urlToBytes(payload))) as JwtPayload;
  } catch {
    return null;
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 <= now) return null; // expired
  return claims;
}

/** Sign an HS256 JWT — used by tests to mint user tokens; harmless in production. */
export async function signHs256(payload: JwtPayload, secret: string): Promise<string> {
  const enc = (obj: unknown) => bytesToBase64url(utf8(JSON.stringify(obj)));
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc(payload);
  const key = await hmacKey(secret, "sign");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(`${head}.${body}`)));
  return `${head}.${body}.${bytesToBase64url(sig)}`;
}

// ── ES256 (asymmetric) verification via the project JWKS ──────────────────────────────────────────

export interface JwtVerifyConfig {
  /** HS256 symmetric secret — local Supabase / the legacy project secret. Empty/undefined on hosted. */
  readonly hs256Secret?: string;
  /** JWKS endpoint — hosted Supabase signs ES256 access tokens with rotating EC P-256 keys. */
  readonly jwksUrl?: string;
  /** Standard claims to additionally enforce (iss/aud/role) — defense in depth over signature+exp+sub.
   *  Omit to skip claim checks (legacy callers / direct verifyHs256/verifyEs256 tests). */
  readonly expected?: ExpectedClaims;
}

// ── Standard-claim validation (iss / aud / role) ─────────────────────────────────────────────────
// A signature-valid token from the wrong issuer/audience, or with a non-authenticated role (e.g.
// `anon`), must not be accepted on the privileged account/entitlement paths. We validate these in
// the shared verifier so every consumer is covered uniformly.

export const SUPABASE_AUTHENTICATED_AUD = "authenticated";
export const SUPABASE_AUTHENTICATED_ROLE = "authenticated";

export interface ExpectedClaims {
  /** Expected issuer, e.g. `${SUPABASE_URL}/auth/v1`. Omitted when the project URL is unknown. */
  readonly iss?: string;
  /** Expected audience — string equality, or membership when the token's `aud` is an array. */
  readonly aud?: string;
  /** Expected `role` claim (Supabase sets `authenticated` for signed-in users). */
  readonly role?: string;
}

/**
 * The expected claims for a Supabase *authenticated* user token. `iss` is enforced only when the
 * project URL is known (always set on hosted); `aud`/`role` are always enforced. Centralizes the
 * policy so all three edge functions agree.
 */
export function authenticatedClaims(supabaseUrl: string | undefined): ExpectedClaims {
  return {
    iss: supabaseUrl ? `${supabaseUrl}/auth/v1` : undefined,
    aud: SUPABASE_AUTHENTICATED_AUD,
    role: SUPABASE_AUTHENTICATED_ROLE,
  };
}

/** True when every *configured* expected claim matches the token. A configured claim absent from the
 *  token fails closed. */
function claimsMatch(claims: JwtPayload, expected: ExpectedClaims): boolean {
  if (expected.iss !== undefined && claims.iss !== expected.iss) return false;
  if (expected.aud !== undefined) {
    const aud = claims.aud;
    const ok =
      typeof aud === "string" ? aud === expected.aud : Array.isArray(aud) && aud.includes(expected.aud);
    if (!ok) return false;
  }
  if (expected.role !== undefined && claims.role !== expected.role) return false;
  return true;
}

interface JwtHeader {
  alg: string;
  kid?: string;
}

function parseHeader(token: string): JwtHeader | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const h = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[0]!))) as {
      alg?: unknown;
      kid?: unknown;
    };
    if (typeof h.alg !== "string") return null;
    return { alg: h.alg, kid: typeof h.kid === "string" ? h.kid : undefined };
  } catch {
    return null;
  }
}

/**
 * Verify a Supabase user JWT, dispatching on its `alg`: HS256 (symmetric secret) or ES256 (the
 * project JWKS public key). Returns the claims only for a cryptographically valid, unexpired token,
 * else null. An unsupported alg, or a missing key for the alg, fails closed.
 */
export async function verifyJwt(
  token: string,
  config: JwtVerifyConfig,
  now: number = Date.now(),
): Promise<JwtPayload | null> {
  const header = parseHeader(token);
  if (!header) return null;
  let claims: JwtPayload | null;
  if (header.alg === "HS256") {
    claims = config.hs256Secret ? await verifyHs256(token, config.hs256Secret, now) : null;
  } else if (header.alg === "ES256") {
    claims = config.jwksUrl ? await verifyEs256(token, config.jwksUrl, header.kid, now) : null;
  } else {
    claims = null; // unsupported/absent alg fails closed
  }
  if (!claims) return null;
  // Defense in depth: a cryptographically valid token from the wrong issuer/audience/role is rejected.
  if (config.expected && !claimsMatch(claims, config.expected)) return null;
  return claims;
}

interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
}

const jwksCache = new Map<string, { keys: Jwk[]; at: number }>();
const JWKS_TTL_MS = 10 * 60 * 1000;

async function loadJwks(url: string, force: boolean): Promise<Jwk[]> {
  const cached = jwksCache.get(url);
  if (!force && cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
  try {
    const res = await fetch(url);
    if (!res.ok) return cached?.keys ?? [];
    const json = (await res.json()) as { keys?: Jwk[] };
    const keys = Array.isArray(json.keys) ? json.keys : [];
    jwksCache.set(url, { keys, at: Date.now() });
    return keys;
  } catch {
    return cached?.keys ?? [];
  }
}

/** Verify an ES256 (EC P-256) JWT against the project JWKS, refetching once on a key-id miss
 * (rotation). The JWT signature is raw r‖s — exactly Web Crypto's ECDSA format, no DER conversion. */
export async function verifyEs256(
  token: string,
  jwksUrl: string,
  kid: string | undefined,
  now: number = Date.now(),
): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const data = utf8(`${header}.${payload}`);
  const sig = base64urlToBytes(signature);

  for (const force of [false, true]) {
    const keys = await loadJwks(jwksUrl, force);
    const jwk = kid ? keys.find((k) => k.kid === kid) : keys[0];
    if (!jwk) {
      if (force) return null; // key not found even after a refetch
      continue;
    }
    let valid: boolean;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true } as JsonWebKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data);
    } catch {
      return null;
    }
    if (!valid) return null;
    let claims: JwtPayload;
    try {
      claims = JSON.parse(new TextDecoder().decode(base64urlToBytes(payload))) as JwtPayload;
    } catch {
      return null;
    }
    if (typeof claims.exp === "number" && claims.exp * 1000 <= now) return null;
    return claims;
  }
  return null;
}

/** Sign an ES256 JWT with an EC P-256 private key — test helper mirroring hosted Supabase's signing. */
export async function signEs256(
  payload: JwtPayload,
  privateKey: CryptoKey,
  kid: string,
): Promise<string> {
  const enc = (obj: unknown) => bytesToBase64url(utf8(JSON.stringify(obj)));
  const head = enc({ alg: "ES256", typ: "JWT", kid });
  const body = enc(payload);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, utf8(`${head}.${body}`)),
  );
  return `${head}.${body}.${bytesToBase64url(sig)}`;
}
