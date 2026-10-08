// deno-lint-ignore-file require-await
// Async test ports deliberately match production contracts.
import { assertEquals, assertNotEquals } from "@std/assert";
import { Buffer } from "node:buffer";
import { createPrivateKey, sign } from "node:crypto";
import { SignedDataVerifier, Environment } from "@apple/app-store-server-library";
import { APPLE_ROOT_CERTIFICATES } from "./apple-roots.ts";
import { createAppleAccessVerifier, isAppleEvidence, parseAppleProducts, VerifiedAppleAccessClient,
  type AppleProduct } from "./apple-access.ts";

const product: AppleProduct = { bundleId: "com.example.still", appAppleId: 1234, productId: "still_pro_v3" };
async function command(directory: string, args: string[]) {
  const result = await new Deno.Command("openssl", { args, cwd: directory, stdout: "null", stderr: "piped" }).output();
  if (!result.success) throw new Error("Test certificate generation failed");
}
async function testChain(directory: string) {
  await Deno.writeTextFile(`${directory}/ca.ext`, "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n1.2.840.113635.100.6.2.1=DER:05:00\n");
  await Deno.writeTextFile(`${directory}/leaf.ext`, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n1.2.840.113635.100.6.11.1=DER:05:00\n");
  await command(directory, ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "root.key", "-out", "root.pem", "-days", "1", "-subj", "/CN=Apple Impersonator Test Root", "-addext", "basicConstraints=critical,CA:TRUE"]);
  for (const name of ["intermediate", "leaf"]) {
    await command(directory, ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
    const issuer = name === "leaf" ? "intermediate" : "root";
    await command(directory, ["x509", "-req", "-in", `${name}.csr`, "-CA", `${issuer}.pem`, "-CAkey", `${issuer}.key`, "-CAcreateserial", "-out", `${name}.pem`, "-days", "1", "-extfile", name === "leaf" ? "leaf.ext" : "ca.ext"]);
  }
  const certs: Buffer[] = [];
  for (const name of ["leaf", "intermediate", "root"]) {
    await command(directory, ["x509", "-in", `${name}.pem`, "-outform", "DER", "-out", `${name}.der`]);
    certs.push(Buffer.from(await Deno.readFile(`${directory}/${name}.der`)));
  }
  const key = createPrivateKey(await Deno.readTextFile(`${directory}/leaf.key`));
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jws = (payload: unknown, extraHeader: Record<string, unknown> = {}) => {
    const content = `${encode({ alg: "ES256", x5c: certs.map(c => c.toString("base64")), ...extraHeader })}.${encode(payload)}`;
    return `${content}.${sign("sha256", Buffer.from(content), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  return { certs, jws };
}
const canGenerateCertificates = (await Deno.permissions.query({ name: "run", command: "openssl" })).state === "granted";
Deno.test({ name: "Apple JWS actual certificate/signature boundary and fresh canonical ownership", ignore: !canGenerateCertificates, fn: async t => {
  const directory = await Deno.makeTempDir({ prefix: "still-apple-test-ca-" });
  try {
    const chain = await testChain(directory);
    const now = Date.now();
    const payload = { bundleId: product.bundleId, productId: product.productId, environment: "Sandbox", type: "Non-Consumable",
      inAppOwnershipType: "PURCHASED", quantity: 1, originalTransactionId: "900719925474099312345",
      transactionId: "900719925474099312345", purchaseDate: now - 1000, originalPurchaseDate: now - 1000,
      signedDate: now, price: 9990, currency: "USD" };
    // ONLY this test double uses a generated CA/offline cert checking; runtime factory pins Apple roots and online OCSP.
    const verifier = new SignedDataVerifier([chain.certs[2]!], false, Environment.SANDBOX, product.bundleId, product.appAppleId);
    let canonical = chain.jws(payload); let lookups = 0;
    const client = new VerifiedAppleAccessClient("sandbox", [product], new Map([[product.bundleId, { verifier,
      api: { getTransactionInfo: async (id: string) => { lookups++; assertEquals(id, payload.transactionId); return { signedTransactionInfo: canonical }; } } }]]), () => now);
    const evidence = { productId: product.productId, bundleId: product.bundleId, signedTransaction: chain.jws(payload) };
    let verified = await client.authenticate(evidence);
    await t.step("real chain and ES256 signature pass, long Apple IDs preserve bytes", () => {
      assertEquals(verified?.originalTransactionId, payload.originalTransactionId);
      assertEquals(verified?.active, true); assertEquals(lookups, 0);
    });
    await t.step("independent current transaction lookup required", async () => {
      assertEquals((await client.refresh(verified!))?.active, true); assertEquals(lookups, 1);
    });
    await t.step("untrusted counterfeit Apple-named certificate chain fails official Apple roots", async () => {
      const official = new SignedDataVerifier(APPLE_ROOT_CERTIFICATES, true, Environment.SANDBOX, product.bundleId, product.appAppleId);
      const strict = new VerifiedAppleAccessClient("sandbox", [product], new Map([[product.bundleId, { verifier: official, api: { getTransactionInfo: async () => ({}) } }]]));
      assertEquals(await strict.authenticate(evidence), null);
    });
    await t.step("tampered payload cannot survive a valid chain", async () => {
      const parts = evidence.signedTransaction.split(".");
      parts[1] = Buffer.from(JSON.stringify({ ...payload, originalTransactionId: "123" })).toString("base64url");
      assertEquals(await client.authenticate({ ...evidence, signedTransaction: parts.join(".") }), null);
    });
    await t.step("missing certificate chain fails", async () => {
      assertEquals(await client.authenticate({ ...evidence, signedTransaction: chain.jws(payload, { x5c: [] }) }), null);
    });
    for (const [name, patch] of Object.entries({
      "wrong bundle": { bundleId: "com.other.app" }, "wrong product": { productId: "still_sync" },
      "wrong environment": { environment: "Production" }, "Xcode cannot skip crypto": { environment: "Xcode" },
      "unknown ownership": { inAppOwnershipType: "UNKNOWN" }, "subscription": { type: "Auto-Renewable Subscription" },
      "numeric transaction": { transactionId: 123 }, "zero price": { price: 0 }, "unknown paid amount": { price: undefined },
      "future signing": { signedDate: now + 61_000 }, "future purchase": { purchaseDate: now + 61_000 },
      "missing signature time": { signedDate: undefined }, "expiry on lifetime": { expiresDate: now + 100_000 },
    })) {
      await t.step(name, async () => assertEquals(await client.authenticate({ ...evidence, signedTransaction: chain.jws({ ...payload, ...patch }) }), null));
    }
    await t.step("algorithm confusion is rejected before official decoder", async () => {
      assertEquals(await client.authenticate({ ...evidence, signedTransaction: chain.jws(payload, { alg: "ES384" }) }), null);
    });
    await t.step("latest canonical refund beats an older active device proof", async () => {
      canonical = chain.jws({ ...payload, revocationDate: now, revocationReason: 1 });
      assertEquals((await client.refresh(verified!))?.active, false);
    });
    await t.step("verified refund with absent/zero historic paid amount persists a revocation, never a grant", async () => {
      for (const price of [undefined, 0]) {
        canonical = chain.jws({ ...payload, price, currency: undefined, revocationDate: now, revocationReason: 1 });
        assertEquals((await client.refresh(verified!))?.active, false);
      }
    });
    await t.step("actual verified family receipt establishes only local possession", async () => {
      const familyEvidence = { ...evidence, signedTransaction: chain.jws({ ...payload, inAppOwnershipType: "FAMILY_SHARED" }) };
      const family = await client.authenticate(familyEvidence);
      assertEquals(family?.active, true); assertEquals(family?.localOnly, true);
      canonical = familyEvidence.signedTransaction;
      assertEquals((await client.refresh(family!))?.localOnly, true);
      canonical = evidence.signedTransaction;
      assertEquals(await client.refresh(family!), null);
    });
    await t.step("canonical identity substitution fails", async () => {
      canonical = chain.jws({ ...payload, originalTransactionId: "12345" });
      assertEquals(await client.refresh(verified!), null);
    });
    await t.step("old canonical signed response does not renew the offline clock", async () => {
      canonical = chain.jws({ ...payload, signedDate: now - 300_001 });
      assertEquals(await client.refresh(verified!), null);
    });
    await t.step("stable key is independent of signature refresh and environment fenced", async () => {
      verified = await client.authenticate({ ...evidence, signedTransaction: chain.jws({ ...payload, signedDate: now + 1 }) });
      const original = await client.authenticate(evidence); assertEquals(verified?.key, original?.key);
      const prodPayload = { ...payload, environment: "Production" };
      const prod = new VerifiedAppleAccessClient("production", [product], new Map([[product.bundleId, {
        verifier: new SignedDataVerifier([chain.certs[2]!], false, Environment.PRODUCTION, product.bundleId, 1234),
        api: { getTransactionInfo: async () => ({}) } }]]));
      assertNotEquals((await prod.authenticate({ ...evidence, signedTransaction: chain.jws(prodPayload) }))?.key, original?.key);
    });
  } finally { await Deno.remove(directory, { recursive: true }); }
} });
Deno.test("Apple configuration and request input fail closed", () => {
  assertEquals(parseAppleProducts(JSON.stringify([product])), [product]);
  for (const value of [[], [product, product], [{ ...product, extra: 1 }], [{ ...product, productId: "still_sync" }], [{ ...product, appAppleId: 0 }]]) {
    assertEquals(parseAppleProducts(JSON.stringify(value)), null);
  }
  assertEquals(isAppleEvidence({ productId: "still_pro_v3", bundleId: product.bundleId, signedTransaction: "a.b.c", environment: "sandbox" }), false);
  assertEquals(createAppleAccessVerifier({ environment: "Xcode", productsJson: JSON.stringify([product]) }), null);
  assertEquals(createAppleAccessVerifier({ environment: "sandbox", productsJson: JSON.stringify([product]) }), null);
});
