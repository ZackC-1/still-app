import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import * as asn1 from "asn1js";
import * as pki from "pkijs";
import { compactVerify, importPKCS8, importSPKI, SignJWT } from "jose";
import { Buffer } from "node:buffer";

// Supabase's Node X509Certificate has unimplemented verify/raw/infoAccess/toString.
// Only the official protected crypto seam is replaced. Its public transaction
// schema validator and bundle/environment checks remain in the Apple library.
const engine = new pki.CryptoEngine({ name: "still-native-webcrypto", crypto });
const SKEW = 60_000;
const LIMIT = 65_536;
const modernSignatures = new Set(["1.2.840.10045.4.3.2", "1.2.840.10045.4.3.3", "1.2.840.10045.4.3.4",
  "1.2.840.113549.1.1.11", "1.2.840.113549.1.1.12", "1.2.840.113549.1.1.13"]);
const ocspHosts = new Set(["ocsp.apple.com", "ocsp2.apple.com", "ocsp.g.aaplimg.com"]);
const fail = (): never => { throw new Error("Apple verification unavailable"); };
const same = (a: ArrayBuffer, b: ArrayBuffer) => Buffer.from(a).equals(Buffer.from(b));
const bytes = (a: Uint8Array): ArrayBuffer => Uint8Array.from(a).buffer;

function schema(der: ArrayBuffer) {
  if (!der.byteLength || der.byteLength > LIMIT) return fail();
  const parsed = asn1.fromBER(der);
  if (parsed.offset !== der.byteLength) return fail();
  return parsed.result;
}
function certificate(der: ArrayBuffer): pki.Certificate {
  if (der.byteLength > 8_192) return fail();
  const cert = new pki.Certificate({ schema: schema(der) });
  if (new Set(cert.extensions?.map(e => e.extnID)).size !== cert.extensions?.length) return fail();
  return cert;
}
function dates(cert: pki.Certificate, now: number) {
  const start = cert.notBefore.value.getTime(), end = cert.notAfter.value.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > now + SKEW || end < now - SKEW || start > end) fail();
}
function usage(cert: pki.Certificate, bit: number) {
  const ext = cert.extensions?.find(e => e.extnID === "2.5.29.15");
  if (!ext) return fail();
  const value = schema(bytes(ext.extnValue.valueBlock.valueHexView));
  if (!(value instanceof asn1.BitString) || !(value.valueBlock.valueHexView[0]! & bit)) fail();
}
function ca(cert: pki.Certificate, expected: boolean) {
  const value = cert.extensions?.find(e => e.extnID === "2.5.29.19")?.parsedValue;
  if (!(value instanceof pki.BasicConstraints) || value.cA !== expected) fail();
}

/** Native fetch only, strict destination, deadline through body read, bounded bytes. */
async function fetchBytes(url: URL, init: RequestInit, timeout: number): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
    if (!response.ok || !response.body) return fail();
    reader = response.body.getReader();
    const parts: Uint8Array[] = []; let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > LIMIT) return fail();
      parts.push(next.value);
    }
    const result = new Uint8Array(size); let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
    return result.buffer;
  } finally {
    clearTimeout(timer);
    if (reader) await reader.cancel().catch(() => {});
    controller.abort();
  }
}

function responderUrl(cert: pki.Certificate): URL {
  const info = cert.extensions?.find(e => e.extnID === "1.3.6.1.5.5.7.1.1")?.parsedValue;
  if (!(info instanceof pki.InfoAccess)) return fail();
  const locations = info.accessDescriptions.filter(a => a.accessMethod === "1.3.6.1.5.5.7.48.1" && a.accessLocation.type === 6);
  if (locations.length !== 1 || typeof locations[0]!.accessLocation.value !== "string") return fail();
  const url = new URL(locations[0]!.accessLocation.value);
  if (!["http:", "https:"].includes(url.protocol) || !ocspHosts.has(url.hostname) ||
    url.username || url.password || url.port || url.hash || url.search) return fail();
  return url;
}

/** Testable policy, with real maintained ASN.1 parsing and WebCrypto signatures.
 * This receives raw responder bytes, never a caller assertion of a good status. */
export async function verifyAppleOcsp(der: ArrayBuffer, cert: pki.Certificate, issuer: pki.Certificate, root: pki.Certificate, now = Date.now()): Promise<void> {
  const response = new pki.OCSPResponse({ schema: schema(der) });
  if (response.responseStatus.valueBlock.valueDec !== 0 || response.responseBytes?.responseType !== "1.3.6.1.5.5.7.48.1.1") return fail();
  const basic = new pki.BasicOCSPResponse({ schema: schema(bytes(response.responseBytes.response.valueBlock.valueHexView)) });
  if (!modernSignatures.has(basic.signatureAlgorithm.algorithmId) || (basic.certs?.length ?? 0) > 4 ||
    basic.tbsResponseData.responses.length > 4 || basic.tbsResponseData.responseExtensions?.some(e => e.critical)) return fail();
  // Requests intentionally carry no nonce, matching Apple's verifier. Never pin a
  // responder as trusted: authorization must follow the exact certificate issuer.
  // RFC6960 certs is OPTIONAL for a direct issuer signature. PKI.js selects
  // candidates only from this array; issuerCerts supplies path/authorization only.
  // Add the exact already chain-verified issuer, never an arbitrary trusted responder.
  const candidates = basic.certs ?? [];
  if (!candidates.some(candidate => same(candidate.toSchema().toBER(false), issuer.toSchema().toBER(false)))) candidates.push(issuer);
  basic.certs = candidates;
  if (!await basic.verify({ trustedCerts: [root], issuerCerts: [issuer, root] }, engine)) return fail();
  const expected = await pki.CertID.create(cert, { issuerCertificate: issuer, hashAlgorithm: "SHA-256" }, engine);
  const matches = basic.tbsResponseData.responses.filter(r => r.certID.isEqual(expected));
  if (matches.length !== 1) return fail();
  const match = matches[0]!;
  const start = match.thisUpdate.getTime(), end = match.nextUpdate?.getTime(), produced = basic.tbsResponseData.producedAt.getTime();
  if (!Number.isFinite(start) || end === undefined || !Number.isFinite(end) || !Number.isFinite(produced) ||
    start > now + SKEW || end < now - SKEW || start > end || produced > now + SKEW || produced < start - SKEW ||
    match.singleExtensions?.some(e => e.critical)) return fail();
  // Status and freshness must come from the SAME exact requested CertID. The
  // library's status helper selects the first matching entry under any hash.
  if (!(match.certStatus instanceof asn1.Primitive) || match.certStatus.idBlock.tagClass !== 3 ||
    match.certStatus.idBlock.tagNumber !== 0 || match.certStatus.valueBlock.valueHexView.byteLength !== 0) fail();
}
async function ocsp(cert: pki.Certificate, issuer: pki.Certificate, root: pki.Certificate): Promise<void> {
  const url = responderUrl(cert);
  const id = await pki.CertID.create(cert, { issuerCertificate: issuer, hashAlgorithm: "SHA-256" }, engine);
  const request = new pki.OCSPRequest({ tbsRequest: new pki.TBSRequest({ requestList: [new pki.Request({ reqCert: id })] }) });
  const response = await fetchBytes(url, { method: "POST", headers: { "content-type": "application/ocsp-request" },
    body: request.toSchema(true).toBER(false) }, 8_000);
  await verifyAppleOcsp(response, cert, issuer, root);
}

export interface AppleChainPolicy {
  verify(leaf: pki.Certificate, intermediate: pki.Certificate, root: pki.Certificate): Promise<void>;
}
/** No response or clock cache: every authenticated proof gets current OCSP. */
export class EdgeAppleSignedDataVerifier extends SignedDataVerifier {
  private readonly anchors: readonly ArrayBuffer[];
  private readonly transactionScope: { readonly environment: Environment; readonly bundle: string };
  constructor(roots: readonly Buffer[], environment: Environment, bundle: string, appAppleId: number,
    private readonly revocation: AppleChainPolicy = { verify: async (leaf, intermediate, root) => {
      await Promise.all([ocsp(leaf, intermediate, root), ocsp(intermediate, root, root)]);
    } }) {
    if (environment !== Environment.SANDBOX && environment !== Environment.PRODUCTION) fail();
    // Empty Node roots: the overridden crypto seam uses only explicit raw anchors.
    super([], true, environment, bundle, appAppleId);
    this.anchors = roots.map(r => bytes(r));
    this.transactionScope = { environment, bundle };
  }
  protected override async verifyJWT<T>(jwt: string, validator: { validate(value: unknown): value is T },
    _signedDateExtractor: (decodedJWT: T) => Date): Promise<T> {
    if (jwt.length > 24_000) return fail();
    const parts = jwt.split(".");
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return fail();
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    if (!header || typeof header !== "object" || Array.isArray(header)) return fail();
    const h = header as Record<string, unknown>;
    if (h.alg !== "ES256" || h.crit !== undefined || h.b64 !== undefined || !Array.isArray(h.x5c) || h.x5c.length !== 3) return fail();
    const der = h.x5c.map(c => {
      if (typeof c !== "string" || c.length > 11_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(c)) return fail();
      const result = Buffer.from(c, "base64");
      if (result.toString("base64") !== c) return fail();
      return bytes(result);
    });
    const rootDer = this.anchors.find(r => same(r, der[2]!));
    if (!rootDer) return fail();
    const [leaf, intermediate, root] = [certificate(der[0]!), certificate(der[1]!), certificate(rootDer)];
    if (!modernSignatures.has(leaf!.signatureAlgorithm.algorithmId) || !modernSignatures.has(intermediate!.signatureAlgorithm.algorithmId) ||
      !leaf!.issuer.isEqual(intermediate!.subject) || !intermediate!.issuer.isEqual(root!.subject)) return fail();
    ca(leaf!, false); ca(intermediate!, true); ca(root!, true);
    usage(leaf!, 0x80); usage(intermediate!, 0x04); usage(root!, 0x04);
    if (!leaf!.extensions?.some(e => e.extnID === "1.2.840.113635.100.6.11.1") ||
      !intermediate!.extensions?.some(e => e.extnID === "1.2.840.113635.100.6.2.1")) return fail();
    const now = Date.now();
    for (const cert of [leaf!, intermediate!, root!]) dates(cert, now);
    const validation = await new pki.CertificateChainValidationEngine({ trustedCerts: [root!],
      certs: [intermediate!, leaf!], checkDate: new Date(now) }).verify({ passedWhenNotRevValues: true }, engine);
    if (!validation.result || validation.certificatePath?.length !== 3) return fail();
    // Verify JWS before network work; compactVerify fixes ES256 and rejects JOSE critical extensions.
    const spki = leaf!.subjectPublicKeyInfo.toSchema().toBER(false);
    const pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spki).toString("base64")}\n-----END PUBLIC KEY-----`;
    const key = await importSPKI(pem, "ES256");
    const result = await compactVerify(jwt, key, { algorithms: ["ES256"] });
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.payload));
    if (!validator.validate(value)) return fail();
    // Reject other applications/products/environments before any OCSP request.
    // This is an early rejection only; the maintained public Apple decoder still
    // performs its transaction schema and application checks after this seam.
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const transaction = value as Record<string, unknown>;
    if (transaction.bundleId !== this.transactionScope.bundle || transaction.environment !== this.transactionScope.environment ||
      transaction.productId !== "still_pro_v3") return fail();
    await this.revocation.verify(leaf!, intermediate!, root!);
    return value;
  }
}

/** Only Apple's read-only transaction-info API; fixed environment host and no redirects.
 * JOSE uses native WebCrypto for the API bearer, avoiding Node/OpenSSL key operations. */
export class EdgeAppleTransactionClient {
  constructor(private readonly config: { privateKey: string; keyId: string; issuerId: string; bundleId: string; environment: Environment }) {}
  async getTransactionInfo(id: string): Promise<{ signedTransactionInfo: string }> {
    if (!/^[1-9][0-9]{0,39}$/.test(id)) return fail();
    const host = this.config.environment === Environment.SANDBOX ? "api.storekit-sandbox.apple.com" :
      this.config.environment === Environment.PRODUCTION ? "api.storekit.apple.com" : fail();
    const key = await importPKCS8(this.config.privateKey, "ES256");
    const bearer = await new SignJWT({ bid: this.config.bundleId }).setProtectedHeader({ alg: "ES256", kid: this.config.keyId, typ: "JWT" })
      .setIssuer(this.config.issuerId).setAudience("appstoreconnect-v1").setIssuedAt().setExpirationTime("5m").sign(key);
    const response = await fetchBytes(new URL(`https://${host}/inApps/v1/transactions/${id}`), {
      method: "GET", headers: { authorization: `Bearer ${bearer}`, accept: "application/json" } }, 10_000);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response));
    if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).signedTransactionInfo !== "string") return fail();
    const signed = (value as Record<string, string>).signedTransactionInfo!;
    if (signed.length > 24_000) return fail();
    return { signedTransactionInfo: signed };
  }
}
