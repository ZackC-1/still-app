import type { BenefitAccessSnapshot } from "@still/shared-types";
import { isAccessUUID, isSafeAccessInteger, verifyAccessProof, type AccessTrust, type VerifiedAccessProof } from "../entitlement/access-proof.js";
import type { ApplePurchaseLinkAuthority, ApplePurchaseLinkCommit } from "../sync/apple-session.js";
import type { NativeAppleAccessCommit, NativeApplePurchaseEvidence, NativeBridge } from "./bridge.js";

export interface ApplePurchaseAuthorityDeps {
  readonly trust: AccessTrust;
  readonly bridge: Pick<NativeBridge, "appleLocalPurchaseEvidence" | "installAppleAccess" | "observeAppleAccess" | "observeAppleLinkAccess" | "observeBenefits"> & Partial<Pick<NativeBridge, "reconcileAccountAccess">>;
  readonly readVerifiedAccount: ApplePurchaseLinkAuthority["readVerifiedAccount"];
  readonly readAccessToken: () => Promise<{ readonly accountId: string; readonly accessToken: string; readonly sessionId?: string } | null>;
  readonly verifyLocal: (body: { readonly schema: 1; readonly transaction: NativeApplePurchaseEvidence }) => Promise<unknown>;
  readonly fulfillLink: ApplePurchaseLinkAuthority["fulfill"];
  readonly now?: () => number;
  /** The SDK's current bearer, read without verifying it. "none" means the SDK holds no session
   * at all and is treated as signed out: the SDK drops a session after Auth refuses it, and also
   * after some refresh failures once the token has expired (for example a 429 or an unparseable
   * 4xx), an accepted trade-off that only ever removes access. "unknown" is any read failure. */
  readonly readSessionToken?: () => Promise<{ readonly status: "session"; readonly accessToken: string } | { readonly status: "none" | "unknown" }>;
  /** Ends this app's signed-in session the ordinary way, which also clears native account rights. */
  readonly endSession?: () => Promise<void>;
}

const unavailable = () => new Error("Apple purchase requires verification");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** App composition only: native verifies StoreKit identity and commits both lanes atomically.
 * Sign-in reconciles account rights only; local fulfillment and linking remain deliberate.
 * The bearer token is never persisted here. */
export function createApplePurchaseAuthority(deps: ApplePurchaseAuthorityDeps) {
  let accountEpoch = 0;
  let ownershipEpoch = 0;
  let linkEligibilityEpoch = 0;
  let revision = 0;
  const now = deps.now ?? Date.now;
  const invalidateAccount = () => { accountEpoch++; };
  const ownershipRevision = () => revision;

  function acknowledge(ack: NativeAppleAccessCommit, local: VerifiedAccessProof, account?: VerifiedAccessProof): void {
    const claims = local.claims;
    if (ack.schema !== 1 || ack.status !== "committed" || !isSafeAccessInteger(ack.generation) ||
      ack.localRight !== claims.right || ack.ownershipRevision !== claims.ownership_revision ||
      ack.verifiedAt !== claims.verified_at || ack.expiresAt !== claims.expires_at ||
      ack.localProofIdentity !== local.identity || ack.accountProofIdentity !== (account?.identity ?? null)) throw unavailable();
    ownershipEpoch++;
    revision = ack.ownershipRevision;
  }

  async function refreshOwnership(): Promise<void> {
    const epoch = ownershipEpoch;
    const observation = await deps.bridge.observeAppleAccess();
    if (epoch !== ownershipEpoch) return;
    // Multiple historical StoreKit mappings cannot silently choose a transfer target.
    if (observation.rights.length > 1) throw unavailable();
    revision = observation.rights[0]?.ownershipRevision ?? 0;
  }

  /** A UI affordance only: native matches current purchaser ownership to its signed local cache.
   * Generic account/protected/family benefits cannot supply this provenance. No proof renewal. */
  async function readLinkEligibility(): Promise<{
    readonly ownershipRevision: number;
  } | null> {
    const epoch = ownershipEpoch;
    const ticket = ++linkEligibilityEpoch;
    const observation = await deps.bridge.observeAppleLinkAccess();
    if (
      ticket !== linkEligibilityEpoch ||
      epoch !== ownershipEpoch ||
      observation.rights.length !== 1
    )
      return null;
    const right = observation.rights[0];
    if (
      !right ||
      right.status !== "purchased" ||
      !isSafeAccessInteger(right.ownershipRevision)
    )
      return null;
    return { ownershipRevision: right.ownershipRevision };
  }

  async function verifyLocalPurchase(): Promise<BenefitAccessSnapshot> {
    const evidence = await deps.bridge.appleLocalPurchaseEvidence();
    if (!evidence) throw unavailable();
    const response = await deps.verifyLocal({ schema: 1, transaction: evidence });
    if (!object(response) || Object.keys(response).sort().join(",") !== "issuerTime,localRight,nativeBinding,proofs,schema,status" ||
      response.schema !== 1 || response.status !== "verified" || typeof response.nativeBinding !== "string" ||
      !Array.isArray(response.proofs) || response.proofs.length !== 1 || typeof response.proofs[0] !== "string" ||
      !isSafeAccessInteger(response.issuerTime)) throw unavailable();
    const verified = await verifyAccessProof(response.proofs[0], deps.trust);
    if (verified.status !== "verified") throw unavailable();
    const proof = verified.proof, claims = proof.claims;
    const wall = now();
    if (claims.kind !== "paid_apple_local" || claims.holder !== claims.right || response.localRight !== claims.right ||
      response.issuerTime !== claims.verified_at || !isSafeAccessInteger(wall) ||
      claims.expires_at === undefined || wall >= claims.expires_at) throw unavailable();
    const ack = await deps.bridge.installAppleAccess({
      nativeBinding: response.nativeBinding, localProof: response.proofs[0], issuerTime: response.issuerTime,
    });
    acknowledge(ack, proof);
    return deps.bridge.observeBenefits();
  }

  /** Native obtains and verifies account proofs itself; JavaScript supplies only current Auth.
   * Its acknowledgement is not an entitlement: benefits come from the same accepted cache. */
  async function refreshAccountAccess(): Promise<BenefitAccessSnapshot> {
    const epoch = accountEpoch;
    const current = () => epoch === accountEpoch;
    // Read the bearer before any SDK verification: verifying a revoked session makes the SDK
    // discard it, and native must still be able to ask hosted Auth about that exact token.
    const held = deps.readSessionToken ? await deps.readSessionToken().catch(() => ({ status: "unknown" as const })) : { status: "unknown" as const };
    if (!current()) throw unavailable();
    if (held.status === "none") {
      // The SDK signed out on its own (a refused refresh: deleted account or revoked session).
      // Ending the app session publishes signed-out to native, which removes account rights.
      await deps.endSession?.().catch(() => {});
      throw unavailable();
    }
    let before: Awaited<ReturnType<typeof deps.readVerifiedAccount>> | undefined;
    try { before = await deps.readVerifiedAccount(); } catch { before = undefined; }
    if (!before && held.status === "session" && deps.bridge.reconcileAccountAccess) {
      // The SDK could not confirm the account. Native asks hosted Auth about the same token
      // itself; only a definitive refusal ends the stored account rights, offline keeps them.
      // Deliberately not gated by the account epoch: on a revoked session the SDK discards it and
      // announces sign-out (advancing the epoch) before this read rejects. Native scopes clearing
      // to the token's own subject being the account it still has bound, so a stale token for
      // another or replaced account changes nothing.
      await deps.bridge.reconcileAccountAccess(held.accessToken).catch(() => {});
      throw unavailable();
    }
    if (!current() || !before?.emailConfirmed || !deps.bridge.reconcileAccountAccess) throw unavailable();
    const token = await deps.readAccessToken();
    if (!current() || !token || token.accountId !== before.id || !token.accessToken ||
      !isAccessUUID(token.sessionId)) throw unavailable();
    const confirmed = await deps.readVerifiedAccount();
    if (!current() || !confirmed?.emailConfirmed || confirmed.id !== before.id) throw unavailable();
    const ack = await deps.bridge.reconcileAccountAccess(token.accessToken);
    if (!current() || ack.accountId !== before.id || ack.sessionId !== token.sessionId) throw unavailable();
    const fresh = await deps.readAccessToken();
    const account = await deps.readVerifiedAccount();
    if (!current() || !account?.emailConfirmed || account.id !== before.id ||
      fresh?.accountId !== before.id || fresh.sessionId !== token.sessionId ||
      fresh.accessToken !== token.accessToken) throw unavailable();
    const snapshot = await deps.bridge.observeBenefits();
    // Observe the committed removals without turning surviving cached rights into a fresh
    // account confirmation. A conflict without accepted proofs is also unresolved;
    // Restore can still independently verify a local Apple purchase.
    if (!current() || ack.accountStatus === "unavailable" ||
      (ack.accountStatus === "conflict" && ack.proofIdentities.length === 0)) throw unavailable();
    return snapshot;
  }

  const purchaseLink: ApplePurchaseLinkAuthority = {
    trust: deps.trust,
    readVerifiedAccount: deps.readVerifiedAccount,
    fulfill: deps.fulfillLink,
    async commit(proofs: ApplePurchaseLinkCommit): Promise<NativeAppleAccessCommit> {
      const epoch = accountEpoch;
      const current = () => epoch === accountEpoch;
      const before = await deps.readVerifiedAccount();
      if (!current() || !before?.emailConfirmed || before.id !== proofs.accountId) throw unavailable();
      const token = await deps.readAccessToken();
      if (!current() || !token || token.accountId !== proofs.accountId || !token.accessToken) throw unavailable();
      const confirmed = await deps.readVerifiedAccount();
      if (!current() || !confirmed?.emailConfirmed || confirmed.id !== proofs.accountId) throw unavailable();
      const ack = await deps.bridge.installAppleAccess({
        nativeBinding: proofs.nativeBinding,
        localProof: JSON.stringify(proofs.localProof.envelope),
        accountProof: JSON.stringify(proofs.accountProof.envelope),
        issuerTime: proofs.issuerTime,
        accessToken: token.accessToken,
      });
      if (!current()) throw unavailable();
      acknowledge(ack, proofs.localProof, proofs.accountProof);
      return ack;
    },
  };
  return { refreshAccountAccess, verifyLocalPurchase, ownershipRevision, purchaseLink, invalidateAccount, refreshOwnership, readLinkEligibility };
}
