import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ed from "@noble/ed25519";
import { describe, expect, it, vi } from "vitest";
import { createApplePurchaseAuthority } from "../apple-purchase-authority.js";
import { initialAccessSnapshot } from "../../entitlement/access-policy.js";
import { accessSigningBytes, canonicalAccessClaims, encodeAccessBase64, verifyAccessProof, type AccessTrust } from "../../entitlement/access-proof.js";
import type { NativeAppleAccessObservation } from "../bridge.js";
import type { AccessClaims } from "@still/shared-types";

const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../../tests/access-proof/vectors.json"), "utf8"));
const localText: string = vectors.vectors.find((v: {name: string}) => v.name === "paid-apple-local").envelope;
const claims: AccessClaims = JSON.parse(Buffer.from(JSON.parse(localText).payload, "base64url").toString());
const trust: AccessTrust = {environment: "sandbox", keys: [{kid: "synthetic-access", publicKeyHex: vectors.publicKeyHex, purpose: "access", environment: "sandbox"}]};

async function setup() {
  const local = await verifyAccessProof(localText, trust);
  if (local.status !== "verified") throw new Error("Invalid test vector");
  const accountClaims: AccessClaims = {...claims, kind: "paid_account", holder: vectors.account};
  const payload = canonicalAccessClaims(accountClaims);
  const accountText = JSON.stringify({payload: encodeAccessBase64(new TextEncoder().encode(payload)), kid: "synthetic-access", alg: "ed25519", signature: encodeAccessBase64(await ed.signAsync(accessSigningBytes(payload), new Uint8Array(32).fill(7)))});
  const account = await verifyAccessProof(accountText, trust);
  if (account.status !== "verified") throw new Error("Invalid account fixture");
  const snapshot = initialAccessSnapshot();
  const ack = {schema: 1 as const, status: "committed" as const, generation: 2, localRight: claims.right,
    ownershipRevision: claims.ownership_revision, verifiedAt: claims.verified_at, expiresAt: claims.expires_at!, localProofIdentity: local.proof.identity, accountProofIdentity: null as string|null};
  const bridge = {
    applePurchaseEvidence: vi.fn(async () => null),
    appleLocalPurchaseEvidence: vi.fn(async () => ({productId: "still_pro_v3" as const, bundleId: "org.example.Still", signedTransaction: "header.payload.signature"})),
    installAppleAccess: vi.fn(async () => ({...ack})),
    observeAppleAccess: vi.fn(async () => ({schema: 1 as const, generation: 2, rights: [{...ack, status: "purchased" as const}]})),
    observeAppleLinkAccess: vi.fn(async (): Promise<NativeAppleAccessObservation> => ({
      schema: 1, generation: 2, rights: [{ ...ack, status: "purchased" }],
    })),
    observeBenefits: vi.fn(async () => snapshot),
  };
  const response = {schema: 1, status: "verified", proofs: [localText], issuerTime: claims.verified_at, localRight: claims.right, nativeBinding: "signed-native-binding"};
  const deps = {trust, bridge, now: () => claims.verified_at + 1,
    verifyLocal: vi.fn(async (): Promise<unknown> => response),
    fulfillLink: vi.fn(async () => ({status: "unavailable"})),
    readVerifiedAccount: vi.fn(async () => ({id: vectors.account as string, emailConfirmed: true})),
    readAccessToken: vi.fn(async () => ({accountId: vectors.account as string, accessToken: "transient-bearer"})),
  };
  const authority = createApplePurchaseAuthority(deps);
  const commit = {accountId: vectors.account as string, accountRevision: 1, localProof: local.proof, accountProof: account.proof, issuerTime: claims.verified_at, ownershipRevision: claims.ownership_revision, nativeBinding: "signed-native-binding"};
  return {authority, deps, bridge, response, ack, snapshot, commit};
}

describe("actual Apple signed purchase authority composition", () => {
  it("constructing or reading ownership never fulfills a purchase or associates an account", async () => {
    const h = await setup();
    await h.authority.refreshOwnership();
    expect(h.authority.ownershipRevision()).toBe(claims.ownership_revision);
    expect(h.deps.verifyLocal).not.toHaveBeenCalled();
    expect(h.deps.fulfillLink).not.toHaveBeenCalled();
    expect(h.bridge.installAppleAccess).not.toHaveBeenCalled();
  });
  it("uses current native evidence, verifies the issuer proof, commits and then observes existing native access", async () => {
    const h = await setup();
    expect(await h.authority.verifyLocalPurchase()).toBe(h.snapshot);
    expect(h.deps.verifyLocal).toHaveBeenCalledWith({schema: 1, transaction: await h.bridge.appleLocalPurchaseEvidence()});
    expect(h.bridge.installAppleAccess).toHaveBeenCalledWith({nativeBinding: h.response.nativeBinding, localProof: localText, issuerTime: claims.verified_at});
    expect(h.bridge.observeBenefits).toHaveBeenCalledOnce();
    expect(h.deps.readAccessToken).not.toHaveBeenCalled();
  });
  it("local family validation uses its dedicated port without account-link evidence or credentials", async () => {
    const h = await setup();
    h.bridge.applePurchaseEvidence.mockImplementation(async () => { throw new Error("Purchased-only link evidence must not run"); });
    expect(await h.authority.verifyLocalPurchase()).toBe(h.snapshot);
    expect(h.bridge.appleLocalPurchaseEvidence).toHaveBeenCalledOnce();
    expect(h.bridge.applePurchaseEvidence).not.toHaveBeenCalled();
    expect(h.deps.readVerifiedAccount).not.toHaveBeenCalled();
    expect(h.deps.readAccessToken).not.toHaveBeenCalled();
    expect(h.deps.fulfillLink).not.toHaveBeenCalled();
    expect(h.bridge.installAppleAccess).toHaveBeenCalledExactlyOnceWith({ nativeBinding: h.response.nativeBinding, localProof: localText, issuerTime: claims.verified_at });
  });
  it.each(["unknown-field", "wrong-right", "wrong-time", "counterfeit-proof", "expired", "missing-evidence"])("refuses %s before native install", async failure => {
    const h = await setup();
    if (failure === "unknown-field") h.deps.verifyLocal.mockResolvedValue({...h.response, entitled: true});
    if (failure === "wrong-right") h.deps.verifyLocal.mockResolvedValue({...h.response, localRight: vectors.account});
    if (failure === "wrong-time") h.deps.verifyLocal.mockResolvedValue({...h.response, issuerTime: claims.verified_at + 1});
    if (failure === "counterfeit-proof") h.deps.verifyLocal.mockResolvedValue({...h.response, proofs: [localText.replace("synthetic-access", "untrusted-access")]});
    if (failure === "expired") h.deps.now = () => claims.expires_at!;
    if (failure === "missing-evidence") h.bridge.appleLocalPurchaseEvidence.mockResolvedValue(null as never);
    // The clock is a captured host dependency, so rebuild when its function changes.
    const authority = createApplePurchaseAuthority(h.deps);
    await expect(authority.verifyLocalPurchase()).rejects.toThrow("requires verification");
    expect(h.bridge.installAppleAccess).not.toHaveBeenCalled();
  });
  it("lets native enforce issuer clock skew instead of refusing a benign issuer-ahead proof", async () => {
    const h = await setup();
    h.deps.now = () => claims.verified_at - 1_000;
    expect(await createApplePurchaseAuthority(h.deps).verifyLocalPurchase()).toBe(h.snapshot);
    expect(h.bridge.installAppleAccess).toHaveBeenCalledOnce();
  });
  it.each(["localRight", "ownershipRevision", "verifiedAt", "localProofIdentity", "accountProofIdentity"])("does not publish native acknowledgement with altered %s", async field => {
    const h = await setup();
    h.bridge.installAppleAccess.mockResolvedValue({...h.ack, [field]: field.endsWith("Identity") ? "wrong" : field === "localRight" ? vectors.account : 999});
    await expect(h.authority.verifyLocalPurchase()).rejects.toThrow("requires verification");
    expect(h.bridge.observeBenefits).not.toHaveBeenCalled();
  });
  it("deliberate linking sends the transient matching bearer and requires both proof identities", async () => {
    const h = await setup();
    h.bridge.installAppleAccess.mockResolvedValue({...h.ack, accountProofIdentity: h.commit.accountProof.identity});
    const result = await h.authority.purchaseLink.commit(h.commit);
    expect(result.accountProofIdentity).toBe(h.commit.accountProof.identity);
    expect(h.bridge.installAppleAccess).toHaveBeenCalledWith({nativeBinding: h.commit.nativeBinding,
      localProof: JSON.stringify(h.commit.localProof.envelope), accountProof: JSON.stringify(h.commit.accountProof.envelope), issuerTime: h.commit.issuerTime, accessToken: "transient-bearer"});
  });
  it("fences same-account sign-out/re-login during token retrieval before install", async () => {
    const h = await setup();
    h.deps.readAccessToken.mockImplementation(async () => {h.authority.invalidateAccount(); return {accountId: vectors.account, accessToken: "transient-bearer"};});
    await expect(h.authority.purchaseLink.commit(h.commit)).rejects.toThrow("requires verification");
    expect(h.bridge.installAppleAccess).not.toHaveBeenCalled();
  });
  it("does not publish an old install acknowledgement after account invalidation", async () => {
    const h = await setup();
    h.bridge.installAppleAccess.mockImplementation(async () => {h.authority.invalidateAccount(); return {...h.ack, accountProofIdentity: h.commit.accountProof.identity};});
    await expect(h.authority.purchaseLink.commit(h.commit)).rejects.toThrow("requires verification");
  });
  it("refuses another account token despite a confirmed display account", async () => {
    const h = await setup();
    h.deps.readAccessToken.mockResolvedValue({accountId: claims.right, accessToken: "another-bearer"});
    await expect(h.authority.purchaseLink.commit(h.commit)).rejects.toThrow("requires verification");
    expect(h.bridge.installAppleAccess).not.toHaveBeenCalled();
  });
  it("does not silently pick one of multiple historical local rights", async () => {
    const h = await setup();
    h.bridge.observeAppleAccess.mockResolvedValue({schema: 1, generation: 2, rights: [{...h.ack, status: "purchased"}, {...h.ack, localRight: vectors.account, status: "purchased"}]});
    await expect(h.authority.refreshOwnership()).rejects.toThrow("requires verification");
  });
  it("does not overwrite an acknowledged ownership revision with a delayed older native read", async () => {
    const h = await setup();
    let resolveRead!: (value: Awaited<ReturnType<typeof h.bridge.observeAppleAccess>>) => void;
    h.bridge.observeAppleAccess.mockImplementation(() => new Promise(resolve => {resolveRead = resolve;}));
    const reading = h.authority.refreshOwnership();
    await h.authority.verifyLocalPurchase();
    resolveRead({schema: 1, generation: 2, rights: [{...h.ack, ownershipRevision: 0, status: "purchased"}]});
    await reading;
    expect(h.authority.ownershipRevision()).toBe(claims.ownership_revision);
  });
});

describe("native purchaser-only local link eligibility", () => {
  it("uses exact filtered native provenance rather than generic purchased/protected benefits", async () => {
    const h = await setup();
    expect(await h.authority.readLinkEligibility()).toEqual({
      ownershipRevision: claims.ownership_revision,
    });
    expect(h.bridge.observeAppleLinkAccess).toHaveBeenCalledOnce();
    expect(h.bridge.observeAppleAccess).not.toHaveBeenCalled();
    expect(h.bridge.observeBenefits).not.toHaveBeenCalled();
    expect(h.deps.verifyLocal).not.toHaveBeenCalled();
    expect(h.bridge.installAppleAccess).not.toHaveBeenCalled();
    expect(h.deps.fulfillLink).not.toHaveBeenCalled();
    expect(h.deps.readVerifiedAccount).not.toHaveBeenCalled();
    expect(h.deps.readAccessToken).not.toHaveBeenCalled();
  });
  it.each([
    "no-local-right",
    "family",
    "account-only",
    "protected",
    "expired",
    "multiple",
  ])("does not link %s provenance", async (kind) => {
    const h = await setup();
    const right = { ...h.ack, status: "purchased" as const };
    const rights =
      kind === "expired"
        ? [{ ...right, status: "verification_required" as const }]
        : kind === "multiple"
          ? [right, { ...right, localRight: vectors.account }]
          : [];
    h.bridge.observeAppleLinkAccess.mockResolvedValue({
      schema: 1,
      generation: 2,
      rights,
    });
    expect(await h.authority.readLinkEligibility()).toBeNull();
    expect(h.deps.fulfillLink).not.toHaveBeenCalled();
  });
  it("a delayed older purchaser observation cannot reopen eligibility after a newer held observation", async () => {
    const h = await setup();
    let finish!: (
      value: Awaited<ReturnType<typeof h.bridge.observeAppleLinkAccess>>,
    ) => void;
    h.bridge.observeAppleLinkAccess.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = h.authority.readLinkEligibility();
    h.bridge.observeAppleLinkAccess.mockResolvedValue({
      schema: 1,
      generation: 2,
      rights: [],
    });
    expect(await h.authority.readLinkEligibility()).toBeNull();
    finish({
      schema: 1,
      generation: 2,
      rights: [{ ...h.ack, status: "purchased" }],
    });
    expect(await old).toBeNull();
  });
  it("an acknowledged new proof fences a delayed old purchaser read", async () => {
    const h = await setup();
    let finish!: (
      value: Awaited<ReturnType<typeof h.bridge.observeAppleLinkAccess>>,
    ) => void;
    h.bridge.observeAppleLinkAccess.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = h.authority.readLinkEligibility();
    await h.authority.verifyLocalPurchase();
    finish({
      schema: 1,
      generation: 2,
      rights: [{ ...h.ack, status: "purchased" }],
    });
    expect(await old).toBeNull();
  });
});
