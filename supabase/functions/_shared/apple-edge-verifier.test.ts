import { assertEquals, assertRejects } from "@std/assert";
import * as pki from "pkijs";
import * as asn1 from "asn1js";
import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";
import { Environment } from "@apple/app-store-server-library";
import { exportPKCS8, exportSPKI, importSPKI, SignJWT } from "jose";
import { EdgeAppleSignedDataVerifier, EdgeAppleTransactionClient, verifyAppleOcsp } from "./apple-edge-verifier.ts";
import { APPLE_ROOT_CERTIFICATES } from "./apple-roots.ts";

const engine = new pki.CryptoEngine({ name: "test-webcrypto", crypto });
const bundle = "com.example.still";
const now = Date.now();
const name = (value: string) => new pki.RelativeDistinguishedNames({ typesAndValues: [new pki.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1.Utf8String({ value }) })] });
const extension = (oid: string, value: asn1.BaseBlock, critical = false) => new pki.Extension({ extnID: oid, critical, extnValue: value.toBER(false) });
interface Identity { cert: pki.Certificate; keys: CryptoKeyPair; }
let serial = 1;
async function identity(label: string, issuer?: Identity, options: { ca?: boolean; oid?: string; usage?: number; expired?: boolean; eku?: boolean; ocspUrl?: string } = {}): Promise<Identity> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const cert = new pki.Certificate({ version: 2, serialNumber: new asn1.Integer({ value: serial++ }), issuer: issuer?.cert.subject ?? name(label), subject: name(label),
    notBefore: new pki.Time({ type: 0, value: new Date(now - 60_000) }),
    notAfter: new pki.Time({ type: 0, value: new Date(options.expired ? now - 120_000 : now + 3_600_000) }), extensions: [
      extension("2.5.29.19", new pki.BasicConstraints({ cA: options.ca ?? false }).toSchema(), true),
      extension("2.5.29.15", new asn1.BitString({ valueHex: new Uint8Array([options.usage ?? (options.ca ? 0x06 : 0x80)]).buffer }), true),
      ...(options.oid ? [extension(options.oid, new asn1.Null())] : []),
      ...(options.eku ? [extension("2.5.29.37", new pki.ExtKeyUsage({ keyPurposes: ["1.3.6.1.5.5.7.3.9"] }).toSchema())] : []),
      extension("1.3.6.1.5.5.7.1.1", new pki.InfoAccess({ accessDescriptions: [new pki.AccessDescription({ accessMethod: "1.3.6.1.5.5.7.48.1", accessLocation: new pki.GeneralName({ type: 6, value: options.ocspUrl ?? "http://ocsp.apple.com/test" }) })] }).toSchema()),
    ] });
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey, engine);
  await cert.sign(issuer?.keys.privateKey ?? keys.privateKey, "SHA-256", engine);
  return { cert: pki.Certificate.fromBER(cert.toSchema().toBER(false)), keys };
}
const der = (cert: pki.Certificate) => cert.toSchema().toBER(false);
async function chain(options: Parameters<typeof identity>[2] = {}) {
  const root = await identity("Test Explicit Root", undefined, { ca: true });
  const intermediate = await identity("Test Apple Intermediate", root, { ca: true, oid: "1.2.840.113635.100.6.2.1" });
  const leaf = await identity("Test Apple Leaf", intermediate, { oid: "1.2.840.113635.100.6.11.1", ...options });
  return { root, intermediate, leaf };
}
async function response(cert: Identity, issuer: Identity, options: { status?: number; start?: number; end?: number; missingNextUpdate?: boolean; produced?: number; signer?: Identity; wrongCert?: Identity; duplicate?: boolean; tamper?: boolean; omitCertificates?: boolean; additionalCertificates?: pki.Certificate[]; firstHashStatus?: number; malformedGood?: boolean } = {}) {
  const id = await pki.CertID.create(options.wrongCert?.cert ?? cert.cert, { issuerCertificate: issuer.cert, hashAlgorithm: "SHA-256" }, engine);
  const item = new pki.SingleResponse({ certID: id, certStatus: options.status === 1 ? new asn1.Constructed({ idBlock: { tagClass: 3, tagNumber: 1 }, value: [new asn1.GeneralizedTime({ valueDate: new Date(now) })] }) :
    new asn1.Primitive({ idBlock: { tagClass: 3, tagNumber: options.status ?? 0 }, valueHex: options.malformedGood ? new Uint8Array([1]).buffer : new ArrayBuffer(0) }),
    thisUpdate: new Date(options.start ?? now - 1000), ...(options.missingNextUpdate ? {} : { nextUpdate: new Date(options.end ?? now + 60_000) }) });
  const signer = options.signer ?? issuer;
  const firstHash = options.firstHashStatus === undefined ? undefined : new pki.SingleResponse({
    certID: await pki.CertID.create(cert.cert, { issuerCertificate: issuer.cert, hashAlgorithm: "SHA-1" }, engine),
    certStatus: new asn1.Primitive({ idBlock: { tagClass: 3, tagNumber: options.firstHashStatus }, valueHex: new ArrayBuffer(0) }),
    thisUpdate: new Date(now - 180_000), nextUpdate: new Date(now - 120_000),
  });
  const basic = new pki.BasicOCSPResponse({ tbsResponseData: new pki.ResponseData({ responderID: signer.cert.subject, producedAt: new Date(options.produced ?? now), responses: options.duplicate ? [item, item] : firstHash ? [firstHash, item] : [item] }), certs: [signer.cert, issuer.cert, ...(options.additionalCertificates ?? [])] });
  await basic.sign(signer.keys.privateKey, "SHA-256", engine);
  if (options.tamper) basic.signature.valueBlock.valueHexView[0]! ^= 1;
  if (options.omitCertificates) delete basic.certs;
  return new pki.OCSPResponse({ responseStatus: new asn1.Enumerated({ value: 0 }), responseBytes: new pki.ResponseBytes({ responseType: "1.3.6.1.5.5.7.48.1.1", response: new asn1.OctetString({ valueHex: basic.toSchema().toBER(false) }) }) }).toSchema().toBER(false);
}
async function transaction(c: Awaited<ReturnType<typeof chain>>, patch = {}, header = {}) {
  return await new SignJWT({ bundleId: bundle, productId: "still_pro_v3", environment: "Sandbox", type: "Non-Consumable", inAppOwnershipType: "PURCHASED", quantity: 1,
    originalTransactionId: "900719925474099312345", transactionId: "900719925474099312345", signedDate: now, ...patch })
    .setProtectedHeader({ alg: "ES256", x5c: [c.leaf, c.intermediate, c.root].map(i => Buffer.from(der(i.cert)).toString("base64")), ...header }).sign(c.leaf.keys.privateKey);
}
function verifier(c: Awaited<ReturnType<typeof chain>>) {
  return new EdgeAppleSignedDataVerifier([Buffer.from(der(c.root.cert))], Environment.SANDBOX, bundle, 1234, {
    verify: async (leaf, intermediate, root) => {
      await verifyAppleOcsp(await response(c.leaf, c.intermediate), leaf, intermediate, root);
      await verifyAppleOcsp(await response(c.intermediate, c.root), intermediate, root, root);
    },
  });
}

Deno.test("Edge Apple verifier: real maintained chain/JWS/OCSP; official schema and app fences", async t => {
  const c = await chain(); const v = verifier(c); const jws = await transaction(c);
  await t.step("valid actual signatures and canonical long ID", async () => assertEquals((await v.verifyAndDecodeTransaction(jws)).originalTransactionId, "900719925474099312345"));
  await t.step("counterfeit named root cannot become Apple authority", async () => {
    const strict = new EdgeAppleSignedDataVerifier(APPLE_ROOT_CERTIFICATES, Environment.SANDBOX, bundle, 1234);
    await assertRejects(() => strict.verifyAndDecodeTransaction(jws));
  });
  for (const [label, patch] of Object.entries({ foreignBundle: { bundleId: "com.other.app" }, foreignEnvironment: { environment: "Production" }, invalidAppleSchema: { transactionId: 123 } })) {
    await t.step(label, async () => { await assertRejects(async () => await v.verifyAndDecodeTransaction(await transaction(c, patch))); });
  }
  await t.step("tampered payload", async () => { const p = jws.split("."); p[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p[1]!, "base64url").toString()), originalTransactionId: "123456" })).toString("base64url"); await assertRejects(() => v.verifyAndDecodeTransaction(p.join("."))); });
  await t.step("wrong chain length", async () => { await assertRejects(async () => await v.verifyAndDecodeTransaction(await transaction(c, {}, { x5c: [] }))); });
  for (const [label, options] of Object.entries({ absentLeafOid: { oid: "1.2.3.4" }, leafIsCa: { ca: true }, wrongKeyUsage: { usage: 0x04 }, expiredLeaf: { expired: true } })) {
    await t.step(label, async () => { const other = { ...c, leaf: await identity(label, c.intermediate, options) }; await assertRejects(async () => await verifier(other).verifyAndDecodeTransaction(await transaction(other))); });
  }
  await t.step("invalid intermediate signature", async () => {
    const attacker = await identity("attacker", undefined, { ca: true });
    const intermediate = await identity("Test Apple Intermediate", attacker, { ca: true, oid: "1.2.840.113635.100.6.2.1" });
    const other = { ...c, intermediate, leaf: await identity("leaf", intermediate, { oid: "1.2.840.113635.100.6.11.1" }) };
    await assertRejects(async () => await verifier(other).verifyAndDecodeTransaction(await transaction(other)));
  });
  for (const [label, options] of Object.entries({ absentIntermediateOid: { ca: true }, intermediateNotCa: { ca: false, oid: "1.2.840.113635.100.6.2.1" },
    intermediateWrongKeyUsage: { ca: true, usage: 0x80, oid: "1.2.840.113635.100.6.2.1" } })) await t.step(label, async () => {
      const intermediate = await identity(label, c.root, options);
      const other = { ...c, intermediate, leaf: await identity("leaf", intermediate, { oid: "1.2.840.113635.100.6.11.1" }) };
      await assertRejects(async () => await verifier(other).verifyAndDecodeTransaction(await transaction(other)));
  });
});

Deno.test("Edge Apple OCSP: issuer authorization, signature, exact identity, fresh good status", async t => {
  const c = await chain();
  await t.step("direct issuer signed", async () => await verifyAppleOcsp(await response(c.leaf, c.intermediate), c.leaf.cert, c.intermediate.cert, c.root.cert));
  await t.step("direct issuer without optional certs", async () => await verifyAppleOcsp(await response(c.leaf, c.intermediate, { omitCertificates: true }), c.leaf.cert, c.intermediate.cert, c.root.cert));
  const delegate = await identity("authorized responder", c.intermediate, { eku: true });
  await t.step("delegate without its certificate cannot borrow issuer authority", async () => { await assertRejects(async () => await verifyAppleOcsp(await response(c.leaf, c.intermediate, { signer: delegate, omitCertificates: true }), c.leaf.cert, c.intermediate.cert, c.root.cert)); });
  await t.step("delegated authorized signer", async () => await verifyAppleOcsp(await response(c.leaf, c.intermediate, { signer: delegate }), c.leaf.cert, c.intermediate.cert, c.root.cert));
  const impostor = await identity("self signed ocsp impostor", undefined, { eku: true });
  const namedIssuer = await identity("Test Apple Intermediate", undefined, { ca: true });
  const noEku = await identity("issued but lacks eku", c.intermediate);
  const foreign = await identity("foreign CA", undefined, { ca: true });
  const foreignSigner = await identity("foreign delegate", foreign, { eku: true });
  for (const [label, options] of Object.entries({ selfSignedResponder: { signer: impostor }, missingEku: { signer: noEku }, wrongIssuerDelegate: { signer: foreignSigner },
    certlessCounterfeitIssuer: { signer: foreign, omitCertificates: true }, certlessSameNameWrongKey: { signer: namedIssuer, omitCertificates: true }, certlessImpostor: { signer: impostor, omitCertificates: true },
    revoked: { status: 1 }, unknown: { status: 2 }, stale: { end: now - 120_000 }, missingNextUpdate: { missingNextUpdate: true }, future: { start: now + 120_000 }, futureProduced: { produced: now + 120_000 },
    mismatchedCert: { wrongCert: c.root }, duplicateIdentity: { duplicate: true }, alteredSignature: { tamper: true } })) {
    await t.step(label, async () => { await assertRejects(async () => await verifyAppleOcsp(await response(c.leaf, c.intermediate, options), c.leaf.cert, c.intermediate.cert, c.root.cert)); });
  }
});

Deno.test("Apple API transport uses native WebCrypto bearer and fixed fenced read-only URL", async () => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const original = globalThis.fetch; let calls = 0;
  const publicKey = await importSPKI(await exportSPKI(keys.publicKey), "ES256");
  globalThis.fetch = async (input, init) => {
    calls++; assertEquals(String(input), "https://api.storekit-sandbox.apple.com/inApps/v1/transactions/900719925474099312345");
    assertEquals(init?.redirect, "error"); assertEquals(init?.method, "GET");
    const jwt = new Headers(init?.headers).get("authorization")!.slice(7);
    const { jwtVerify } = await import("jose");
    const claims = await jwtVerify(jwt, publicKey, { issuer: "synthetic-issuer", audience: "appstoreconnect-v1", algorithms: ["ES256"] });
    assertEquals(claims.payload.bid, bundle);
    return Response.json({ signedTransactionInfo: "synthetic-provider-jws" });
  };
  try {
    const api = new EdgeAppleTransactionClient({ privateKey: await exportPKCS8(keys.privateKey), keyId: "SYNTHETIC1", issuerId: "synthetic-issuer", bundleId: bundle, environment: Environment.SANDBOX });
    assertEquals((await api.getTransactionInfo("900719925474099312345")).signedTransactionInfo, "synthetic-provider-jws");
    await assertRejects(() => api.getTransactionInfo("../escape")); assertEquals(calls, 1);
  } finally { globalThis.fetch = original; }
});

Deno.test("default Edge verifier uses bounded native OCSP fetch and survives unavailable Node X509 methods", async t => {
  const c = await chain(); const originalFetch = globalThis.fetch;
  const saved = new Map<string, PropertyDescriptor>();
  for (const key of ["verify", "raw", "infoAccess", "toString"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(X509Certificate.prototype, key)!);
    Object.defineProperty(X509Certificate.prototype, key, { configurable: true,
      value: () => { throw new Error("EdgeRuntime Node X509 primitive unavailable"); } });
  }
  let calls = 0; let mode = "good";
  globalThis.fetch = async (input, init) => {
    calls++; assertEquals(String(input), "http://ocsp.apple.com/test");
    assertEquals(init?.redirect, "error"); assertEquals(init?.method, "POST");
    const request = pki.OCSPRequest.fromBER(init!.body as ArrayBuffer);
    const id = request.tbsRequest.requestList[0]!.reqCert;
    const expected = await pki.CertID.create(c.leaf.cert, { issuerCertificate: c.intermediate.cert, hashAlgorithm: "SHA-256" }, engine);
    const data = id.isEqual(expected) ? await response(c.leaf, c.intermediate) : await response(c.intermediate, c.root);
    if (mode === "oversize") return new Response(new Uint8Array(65_537));
    if (mode === "http-error") return new Response(null, { status: 503 });
    return new Response(data);
  };
  try {
    const strict = new EdgeAppleSignedDataVerifier([Buffer.from(der(c.root.cert))], Environment.SANDBOX, bundle, 1234);
    await t.step("actual default OCSP chain passes with all affected Node methods disabled", async () => {
      assertEquals((await strict.verifyAndDecodeTransaction(await transaction(c))).bundleId, bundle); assertEquals(calls, 2);
    });
    for (const failure of ["oversize", "http-error"]) await t.step(failure, async () => {
      mode = failure; await assertRejects(async () => await strict.verifyAndDecodeTransaction(await transaction(c)));
    });
    mode = "good";
    for (const url of ["http://127.0.0.1/", "https://ocsp.apple.com.evil.invalid/", "http://ocsp.apple.com:81/", "http://user:pass@ocsp.apple.com/", "http://ocsp.apple.com/path?escape=1"]) await t.step("OCSP destination rejected before fetch", async () => {
      const other = { ...c, leaf: await identity("bad-url", c.intermediate, { oid: "1.2.840.113635.100.6.11.1", ocspUrl: url }) };
      // Intermediate revocation may start concurrently; the bad leaf URL is never fetched.
      await assertRejects(async () => await strict.verifyAndDecodeTransaction(await transaction(other)));
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) Object.defineProperty(X509Certificate.prototype, key, descriptor);
  }
});

Deno.test("pinned PKI.js authorizes the exact issuer, not a sibling CA under the same trusted root", async () => {
  const c = await chain();
  const sibling = await identity("Sibling Apple CA", c.root, { ca: true });
  const responder = await identity("Sibling OCSP delegate", sibling, { eku: true });
  const validation = await new pki.CertificateChainValidationEngine({ trustedCerts: [c.root.cert], certs: [sibling.cert, responder.cert] }).verify({}, engine);
  assertEquals(validation.result, true); // The signer really does have a valid path to the trusted root.
  const forgedAuthority = await response(c.leaf, c.intermediate, { signer: responder, additionalCertificates: [sibling.cert] });
  await assertRejects(() => verifyAppleOcsp(forgedAuthority, c.leaf.cert, c.intermediate.cert, c.root.cert));
  const authorized = await identity("Exact issuer delegate control", c.intermediate, { eku: true });
  await verifyAppleOcsp(await response(c.leaf, c.intermediate, { signer: authorized }), c.leaf.cert, c.intermediate.cert, c.root.cert);
});
Deno.test("OCSP status comes from the exact fresh requested SHA256 entry", async t => {
  const c = await chain();
  await t.step("older SHA1 good cannot override fresh SHA256 revoked", async () => {
    const responseBytes = await response(c.leaf, c.intermediate, { firstHashStatus: 0, status: 1 });
    await assertRejects(() => verifyAppleOcsp(responseBytes, c.leaf.cert, c.intermediate.cert, c.root.cert));
  });  await t.step("older SHA1 unknown does not replace fresh SHA256 good", async () => {
    await verifyAppleOcsp(await response(c.leaf, c.intermediate, { firstHashStatus: 2 }), c.leaf.cert, c.intermediate.cert, c.root.cert);
  });
  await t.step("malformed good ASN1 payload is rejected", async () => {
    await assertRejects(async () => await verifyAppleOcsp(await response(c.leaf, c.intermediate, { malformedGood: true }), c.leaf.cert, c.intermediate.cert, c.root.cert));
  });

});

Deno.test("foreign application tuples fail before any revocation network work", async () => {
  const c = await chain(); let calls = 0;
  const v = new EdgeAppleSignedDataVerifier([Buffer.from(der(c.root.cert))], Environment.SANDBOX, bundle, 1234,
    { verify: () => { calls++; return Promise.resolve(); } });
  for (const patch of [{ bundleId: "com.other.app" }, { environment: "Production" }, { productId: "another_product" }]) {
    await assertRejects(async () => await v.verifyAndDecodeTransaction(await transaction(c, patch)));
    assertEquals(calls, 0);
  }
  await v.verifyAndDecodeTransaction(await transaction(c)); assertEquals(calls, 1);
});
