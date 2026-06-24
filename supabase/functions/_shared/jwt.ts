// Minimal HS256 JWT verify/sign over Web Crypto. The reconcile function verifies the user JWT
// in-handler (defense in depth over the platform's verify_jwt=true) so the subject UUID comes
// only from a cryptographically valid token — never the request body (KTD5 IDOR defense).

export interface JwtPayload {
  sub?: string;
  exp?: number;
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
