import { assertEquals } from "@std/assert";
import { signEs256, signHs256, verifyEs256, verifyJwt } from "./jwt.ts";

const A = "11111111-1111-1111-1111-111111111111";
const HS_SECRET = "test-jwt-secret-at-least-32-characters-long!!";

// Each fixture gets a unique JWKS URL so the module-level JWKS cache can't bleed between tests.
let urlSeq = 0;
async function es256Fixture(): Promise<{ priv: CryptoKey; url: string; restore: () => void }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwks = JSON.stringify({ keys: [{ ...jwk, kid: "kid-test" }] });
  const url = `https://example.test/jwks/${urlSeq++}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(jwks, { status: 200 }))) as typeof fetch;
  return { priv: pair.privateKey, url, restore: () => (globalThis.fetch = realFetch) };
}

Deno.test("verifyJwt dispatches HS256 to the symmetric secret", async () => {
  const token = await signHs256({ sub: A }, HS_SECRET);
  assertEquals((await verifyJwt(token, { hs256Secret: HS_SECRET }))?.sub, A);
  // wrong secret → null
  assertEquals(await verifyJwt(token, { hs256Secret: "a-different-secret-also-32-chars-long!!" }), null);
  // hosted config (no HS256 secret) for an HS256 token → null, never trust it
  assertEquals(await verifyJwt(token, { jwksUrl: "https://x/jwks" }), null);
});

Deno.test("verifyJwt verifies a real ES256 token against the JWKS", async () => {
  const fx = await es256Fixture();
  try {
    const token = await signEs256({ sub: A }, fx.priv, "kid-test");
    assertEquals((await verifyJwt(token, { jwksUrl: fx.url }))?.sub, A);
  } finally {
    fx.restore();
  }
});

Deno.test("ES256 token signed by a different key → null", async () => {
  const fx = await es256Fixture();
  try {
    const other = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const token = await signEs256({ sub: A }, other.privateKey, "kid-test"); // claims the kid, wrong key
    assertEquals(await verifyJwt(token, { jwksUrl: fx.url }), null);
  } finally {
    fx.restore();
  }
});

Deno.test("ES256 expired token → null", async () => {
  const fx = await es256Fixture();
  try {
    const token = await signEs256({ sub: A, exp: 1000 }, fx.priv, "kid-test"); // 1970 → long expired
    assertEquals(await verifyEs256(token, fx.url, "kid-test"), null);
  } finally {
    fx.restore();
  }
});

Deno.test("ES256 with no jwksUrl configured → null (fail closed)", async () => {
  const fx = await es256Fixture();
  try {
    const token = await signEs256({ sub: A }, fx.priv, "kid-test");
    assertEquals(await verifyJwt(token, { hs256Secret: HS_SECRET }), null); // ES256 token, no JWKS
  } finally {
    fx.restore();
  }
});

Deno.test("unsupported alg (none) → null", async () => {
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const token = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: A })}.`;
  assertEquals(await verifyJwt(token, { hs256Secret: HS_SECRET, jwksUrl: "https://x/jwks" }), null);
});
