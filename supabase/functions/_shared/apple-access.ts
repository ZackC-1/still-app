import { Environment,
  type JWSTransactionDecodedPayload } from "@apple/app-store-server-library";
import type { AccessEnvironment } from "@still/shared-types";
import { APPLE_ROOT_CERTIFICATES } from "./apple-roots.ts";
import { EdgeAppleSignedDataVerifier, EdgeAppleTransactionClient } from "./apple-edge-verifier.ts";

export interface AppleEvidence { readonly productId: string; readonly bundleId: string; readonly signedTransaction: string; }
export interface AppleProduct { readonly bundleId: string; readonly appAppleId: number; readonly productId: "still_pro_v3"; }
export interface VerifiedAppleTransaction {
  readonly key: string; readonly environment: AccessEnvironment; readonly bundleId: string;
  readonly productId: "still_pro_v3"; readonly originalTransactionId: string; readonly transactionId: string;
  readonly active: boolean;
  /** Family Sharing establishes native local possession only; it cannot link/transfer an account. */
  readonly localOnly?: true;
}
export interface AppleAccessVerifier {
  authenticate(evidence: AppleEvidence): Promise<VerifiedAppleTransaction | null>;
  refresh(transaction: VerifiedAppleTransaction): Promise<VerifiedAppleTransaction | null>;
}
export interface AppleSignedDataPort { verifyAndDecodeTransaction(jws: string): Promise<JWSTransactionDecodedPayload>; }
export interface AppleTransactionPort { getTransactionInfo(id: string): Promise<{ signedTransactionInfo?: string }>; }
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const identifier = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,39}$/.test(v);
const bundle = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(v) && v.length <= 160;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseAppleProducts(text: string): readonly AppleProduct[] | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
    if (value.some(p => !record(p) || Object.keys(p).sort().join(",") !== "appAppleId,bundleId,productId" ||
      !bundle(p.bundleId) || !integer(p.appAppleId) || p.appAppleId === 0 || p.productId !== "still_pro_v3") ||
      new Set(value.map(p => p.bundleId)).size !== value.length) return null;
    return value as AppleProduct[];
  } catch { return null; }
}

export function isAppleEvidence(v: unknown): v is AppleEvidence {
  return record(v) && Object.keys(v).sort().join(",") === "bundleId,productId,signedTransaction" &&
    bundle(v.bundleId) && v.productId === "still_pro_v3" && typeof v.signedTransaction === "string" &&
    v.signedTransaction.length <= 24_000 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v.signedTransaction);
}

/** All payload fields below have already passed the official Apple chain/OID/OCSP/JWS verifier.
 * A device proof is only an identity hint. A fresh API response establishes current revocation.
 * Numeric-looking Apple IDs remain strings; original transaction identifies one lifetime right. */
export class VerifiedAppleAccessClient implements AppleAccessVerifier {
  constructor(readonly environment: AccessEnvironment, private readonly products: readonly AppleProduct[],
    private readonly ports: ReadonlyMap<string, { readonly verifier: AppleSignedDataPort; readonly api: AppleTransactionPort }>,
    private readonly now: () => number = Date.now) {}

  private async decoded(jws: string, product: AppleProduct, current: boolean): Promise<VerifiedAppleTransaction | null> {
    try {
      // Explicitly restrict alg before the official library: no library algorithm negotiation.
      const header: unknown = JSON.parse(atob(jws.split(".")[0]!.replaceAll("-", "+").replaceAll("_", "/")));
      if (!record(header) || header.alg !== "ES256" || header.crit !== undefined) return null;
      const decoded = await this.ports.get(product.bundleId)!.verifier.verifyAndDecodeTransaction(jws);
      const expected = this.environment === "sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
      if (decoded.bundleId !== product.bundleId || decoded.productId !== product.productId || decoded.environment !== expected ||
        decoded.type !== "Non-Consumable" || !["PURCHASED", "FAMILY_SHARED"].includes(decoded.inAppOwnershipType ?? "") || decoded.quantity !== 1 ||
        !identifier(decoded.originalTransactionId) || !identifier(decoded.transactionId) ||
        !integer(decoded.purchaseDate) || !integer(decoded.originalPurchaseDate) ||
        decoded.purchaseDate < decoded.originalPurchaseDate || decoded.purchaseDate > this.now() + 60_000 ||
        !integer(decoded.signedDate) || decoded.signedDate > this.now() + 60_000 ||
        (current && decoded.signedDate < this.now() - 300_000) ||
        decoded.expiresDate !== undefined || decoded.isUpgraded === true ||
        // Refund is still authoritative when the current payload omits historical paid amounts.
        // Missing/zero payment never establishes an ACTIVE paid right.
        (decoded.revocationDate === undefined && decoded.revocationReason === undefined && decoded.revocationType === undefined && decoded.revocationPercentage === undefined &&
          (!integer(decoded.price) || decoded.price <= 0 || typeof decoded.currency !== "string" || !/^[A-Z]{3}$/.test(decoded.currency))) ||
        (decoded.revocationDate !== undefined && !integer(decoded.revocationDate))) return null;
      const identity = JSON.stringify(["apple", this.environment, product.bundleId, product.productId, decoded.originalTransactionId]);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)));
      return { key: Array.from(hash, b => b.toString(16).padStart(2, "0")).join(""), environment: this.environment,
        bundleId: product.bundleId, productId: product.productId, originalTransactionId: decoded.originalTransactionId,
        transactionId: decoded.transactionId, ...(decoded.inAppOwnershipType === "FAMILY_SHARED" ? { localOnly: true as const } : {}),
        active: decoded.revocationDate === undefined && decoded.revocationReason === undefined &&
          decoded.revocationType === undefined && decoded.revocationPercentage === undefined };
    } catch { return null; }
  }
  async authenticate(evidence: AppleEvidence): Promise<VerifiedAppleTransaction | null> {
    if (!isAppleEvidence(evidence)) return null;
    const product = this.products.find(p => p.bundleId === evidence.bundleId && p.productId === evidence.productId);
    return product ? await this.decoded(evidence.signedTransaction, product, false) : null;
  }
  async refresh(transaction: VerifiedAppleTransaction): Promise<VerifiedAppleTransaction | null> {
    try {
      if (transaction.environment !== this.environment) return null;
      const product = this.products.find(p => p.bundleId === transaction.bundleId && p.productId === transaction.productId);
      if (!product) return null;
      const response = await this.ports.get(product.bundleId)!.api.getTransactionInfo(transaction.transactionId);
      if (!response.signedTransactionInfo || response.signedTransactionInfo.length > 24_000) return null;
      const current = await this.decoded(response.signedTransactionInfo, product, true);
      return current && current.key === transaction.key && current.transactionId === transaction.transactionId &&
        current.localOnly === transaction.localOnly ? current : null;
    } catch { return null; }
  }
}

export function createAppleAccessVerifier(config: {
  environment?: string; productsJson?: string; apiPrivateKey?: string; apiKeyId?: string; apiIssuerId?: string;
}): AppleAccessVerifier | null {
  const products = parseAppleProducts(config.productsJson ?? "");
  if ((config.environment !== "sandbox" && config.environment !== "production") || !products ||
    !config.apiPrivateKey?.startsWith("-----BEGIN PRIVATE KEY-----") || !/^[A-Z0-9]{10}$/.test(config.apiKeyId ?? "") ||
    !/^[0-9a-f-]{36}$/.test(config.apiIssuerId ?? "")) return null;
  const environment = config.environment === "sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
  try {
    const ports = new Map(products.map(p => [p.bundleId, {
      verifier: new EdgeAppleSignedDataVerifier(APPLE_ROOT_CERTIFICATES, environment, p.bundleId, p.appAppleId),
      api: new EdgeAppleTransactionClient({ privateKey: config.apiPrivateKey!, keyId: config.apiKeyId!, issuerId: config.apiIssuerId!, bundleId: p.bundleId, environment }),
    }]));
    return new VerifiedAppleAccessClient(config.environment, products, ports);
  } catch { return null; }
}
