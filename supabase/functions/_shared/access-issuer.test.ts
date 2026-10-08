import { assertEquals, assertRejects } from "@std/assert";
import { createAccessSigner } from "./access-issuer.ts";
import { PAID_ACCESS_WINDOW_MS, STILL_PRO_V3_BENEFITS, accessSigningBytes } from "@still/shared-types";

// Public RFC8032 test vector only. No deployment key is generated, read or retained.
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const hex = (text: string) => Uint8Array.from(text.match(/../g)!, byte => parseInt(byte, 16));
const privateKeyPkcs8Base64 = btoa(Array.from(hex("302e020100300506032b657004220420" + SEED), byte => String.fromCharCode(byte)).join(""));
const CONFIG = { environment: "sandbox", kid: "synthetic-access", privateKeyPkcs8Base64, publicKeyHex: PUBLIC };
const RIGHT = { right: "33333333-3333-3333-3333-333333333333", holder: "11111111-1111-1111-1111-111111111111", revision: 2, verified_at: 1791374400000 };

Deno.test("real Ed25519 issuer emits the frozen account scope and canonical thirty-day deadline", async () => {
  const signer = (await createAccessSigner(CONFIG))!;
  const text = await signer.sign(RIGHT);
  const envelope = JSON.parse(text);
  const decode = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  const payload = new TextDecoder().decode(decode(envelope.payload));
  const claims = JSON.parse(payload);
  assertEquals(Object.keys(envelope), ["payload", "kid", "alg", "signature"]);
  assertEquals(claims.environment, "sandbox");
  assertEquals(claims.holder, RIGHT.holder);
  assertEquals(claims.right, RIGHT.right);
  assertEquals(claims.kind, "paid_account");
  assertEquals(claims.provenance, "provider_verified");
  assertEquals(claims.ownership_revision, 2);
  assertEquals(claims.benefits, STILL_PRO_V3_BENEFITS);
  assertEquals(claims.expires_at, RIGHT.verified_at + PAID_ACCESS_WINDOW_MS);
  const publicKey = await crypto.subtle.importKey("raw", hex(PUBLIC), "Ed25519", false, ["verify"]);
  assertEquals(await crypto.subtle.verify("Ed25519", publicKey, decode(envelope.signature), new Uint8Array(accessSigningBytes(payload))), true);
  assertEquals(await crypto.subtle.verify("Ed25519", publicKey, decode(envelope.signature), new Uint8Array(accessSigningBytes(payload.replace(RIGHT.holder, RIGHT.right)))), false);
});

Deno.test("missing, wrong purpose material and mismatched key pair fail closed", async () => {
  for (const config of [{}, { ...CONFIG, environment: "test" }, { ...CONFIG, kid: "rules:key" },
    { ...CONFIG, privateKeyPkcs8Base64: "bad" }, { ...CONFIG, publicKeyHex: "00".repeat(32) }]) {
    assertEquals(await createAccessSigner(config), null);
  }
});

Deno.test("invalid holder/right/revision/time cannot be signed", async () => {
  const signer = (await createAccessSigner(CONFIG))!;
  for (const right of [{ ...RIGHT, holder: "somebody" }, { ...RIGHT, right: "BAD" },
    { ...RIGHT, revision: -1 }, { ...RIGHT, verified_at: Number.MAX_SAFE_INTEGER }]) {
    await assertRejects(() => signer.sign(right), Error, "Invalid access right");
  }
});

Deno.test("Apple local proof and binding carry the same right revision clock and distinct signed purpose", async () => {
  const signer = (await createAccessSigner(CONFIG))!;
  const local = { ...RIGHT, holder: RIGHT.right };
  const localEnvelope = JSON.parse(await signer.sign(local, "paid_apple_local"));
  const binding = { schema: 1 as const, environment: "sandbox" as const, appBundleId: "com.example.still",
    productId: "still_pro_v3" as const, originalTransactionId: "900719925474099312345", right: RIGHT.right,
    ownershipRevision: RIGHT.revision, verifiedAt: RIGHT.verified_at, expiresAt: RIGHT.verified_at + PAID_ACCESS_WINDOW_MS };
  const envelope = JSON.parse(await signer.signAppleBinding!(binding));
  const decode = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  const payload = new TextDecoder().decode(decode(envelope.payload));
  const localClaims = JSON.parse(new TextDecoder().decode(decode(localEnvelope.payload)));
  assertEquals(Object.keys(envelope), ["payload", "kid", "alg", "signature"]);
  assertEquals(JSON.parse(payload), binding);
  assertEquals(Object.keys(JSON.parse(payload)), ["schema", "environment", "appBundleId", "productId", "originalTransactionId", "right", "ownershipRevision", "verifiedAt", "expiresAt"]);
  assertEquals(localClaims.kind, "paid_apple_local");
  assertEquals(localClaims.holder, localClaims.right);
  assertEquals(localClaims.ownership_revision, binding.ownershipRevision);
  assertEquals(localClaims.expires_at, binding.expiresAt);
  const key = await crypto.subtle.importKey("raw", hex(PUBLIC), "Ed25519", false, ["verify"]);
  const bytes = (value: string) => new TextEncoder().encode("still-apple-right-binding-v1\n" + value);
  assertEquals(await crypto.subtle.verify("Ed25519", key, decode(envelope.signature), bytes(payload)), true);
  assertEquals(await crypto.subtle.verify("Ed25519", key, decode(envelope.signature), new Uint8Array(accessSigningBytes(payload))), false);
  for (const patch of [{ environment: "production" }, { right: RIGHT.holder }, { productId: "still_sync" },
    { originalTransactionId: "12345" }, { ownershipRevision: 99 }, { appBundleId: "com.other.app" }, { expiresAt: binding.expiresAt + 1 }]) {
    assertEquals(await crypto.subtle.verify("Ed25519", key, decode(envelope.signature), bytes(JSON.stringify({ ...binding, ...patch }))), false);
  }
  for (const patch of [{ environment: "production" as const }, { expiresAt: binding.expiresAt + 1 }, { originalTransactionId: "0" }]) {
    await assertRejects(() => signer.signAppleBinding!({ ...binding, ...patch }), Error, "Invalid Apple binding");
  }
  await assertRejects(() => signer.sign(RIGHT, "paid_apple_local"), Error, "Invalid access right");
});
