import { describe, expect, it, vi } from "vitest";
import vectors from "../../../../../tests/access-proof/vectors.json";
import { reconcileAccountAccess, verifyAccountAccessResponse } from "../account-access-transport.js";
import type { AccessTrust } from "../access-proof.js";

const trust: AccessTrust = { environment: "sandbox", keys: [{ kid: "synthetic-access", publicKeyHex: vectors.publicKeyHex,
  environment: "sandbox", purpose: "access" }] };
const proof = vectors.vectors.find(vector => vector.name === "paid-account")!.envelope;
const response = () => ({ still_sync: true, access: { status: "verified", environment: "sandbox", proofs: [proof],
  revocations: [], issuer_time: vectors.verifiedAt } });

describe("authenticated scoped account transport", () => {
  it("admits only verified account proof through the existing grammar", async () => {
    const result = await verifyAccountAccessResponse(response(), vectors.account, trust);
    expect(result.status).toBe("verified");
    if (result.status === "unavailable") throw new Error("Expected proof");
    expect(result.proofs[0]?.claims.holder).toBe(vectors.account);
    expect(result.issuerTime).toBe(vectors.verifiedAt);
  });
  it("ignores the legacy Boolean, provider success text and missing evidence", async () => {
    for (const value of [{ still_sync: true }, { success: true }, null, { access: { status: "unavailable" } }]) {
      expect(await verifyAccountAccessResponse(value, vectors.account, trust)).toEqual({ status: "unavailable" });
    }
  });
  it("wrong account/environment, duplicate, forged and local proof cannot grant account access", async () => {
    expect(await verifyAccountAccessResponse(response(), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", trust)).toEqual({ status: "unavailable" });
    expect(await verifyAccountAccessResponse(response(), vectors.account, { ...trust, environment: "production" })).toEqual({ status: "unavailable" });
    for (const proofs of [[proof, proof], [proof.replace("synthetic-access", "fake-access")],
      [vectors.vectors.find(vector => vector.name === "paid-local")?.envelope ?? "forged"]]) {
      expect(await verifyAccountAccessResponse({ access: { ...response().access, proofs } }, vectors.account, trust)).toEqual({ status: "unavailable" });
    }
  });
  it("exact deadline and future issuer mismatch reject proof without fabricating absent rights", async () => {
    for (const issuer_time of [vectors.expiresAt, vectors.verifiedAt - 1]) {
      expect(await verifyAccountAccessResponse({ access: { ...response().access, issuer_time } }, vectors.account, trust)).toEqual({ status: "unavailable" });
    }
  });
  it("conclusive none and affected revision revocation stay explicit", async () => {
    const revocations = [{ right: "11111111-1111-4111-8111-111111111111", revision: 2 }];
    expect(await verifyAccountAccessResponse({ access: { ...response().access, status: "none", proofs: [], revocations } }, vectors.account, trust))
      .toMatchObject({ status: "none", proofs: [], revocations });
    expect(await verifyAccountAccessResponse({ access: { ...response().access, revocations } }, vectors.account, trust)).toEqual({ status: "unavailable" });
  });
  it("transport uses fixed schema and errors never become no-right", async () => {
    const invoke = vi.fn().mockResolvedValue({ data: response(), error: null });
    expect((await reconcileAccountAccess(invoke, vectors.account, trust)).status).toBe("verified");
    expect(invoke).toHaveBeenCalledWith("reconcile-entitlement", { body: { access_schema: 1 } });
    invoke.mockResolvedValue({ data: response(), error: new Error("offline") });
    expect(await reconcileAccountAccess(invoke, vectors.account, trust)).toEqual({ status: "unavailable" });
  });
  it("unavailable with authenticated removals remains removals-only, never a grant or verified-none", async () => {
    const revocations = [{ right: "11111111-1111-4111-8111-111111111111", revision: 2 }];
    const access = { ...response().access, status: "unavailable", proofs: [], revocations };
    expect(await verifyAccountAccessResponse({ access }, vectors.account, trust))
      .toEqual({ status: "unavailable", proofs: [], revocations, issuerTime: vectors.verifiedAt });
    for (const patch of [{ proofs: [proof] }, { environment: "production" }, { issuer_time: -1 }, { issuer_time: NaN },
      { revocations: [] }, { revocations: [{ ...revocations[0], revision: -1 }] },
      { revocations: [{ ...revocations[0], right: "not-a-right" }] }, { revocations: [revocations[0], revocations[0]] },
      { revocations: [{ ...revocations[0], extra: true }] }, { extra: "unknown" }]) {
      expect(await verifyAccountAccessResponse({ access: { ...access, ...patch } }, vectors.account, trust)).toEqual({ status: "unavailable" });
    }
  });
});

describe("removal-only unavailable account evidence", () => {
  const revocations = [{ right: "11111111-1111-4111-8111-111111111111", revision: 2 }];
  const removal = () => ({ access: { status: "unavailable", environment: "sandbox", proofs: [], revocations, issuer_time: vectors.verifiedAt } });
  it("retains unavailable while admitting exact bounded removals and no grants", async () => {
    expect(await verifyAccountAccessResponse(removal(), vectors.account, trust)).toEqual({ status: "unavailable", proofs: [], revocations, issuerTime: vectors.verifiedAt });
  });
  it("plain unavailable has no removal authority and malformed envelopes cannot remove", async () => {
    const invalid = [ { status: "unavailable", revocations }, { ...removal().access, proofs: [proof] },
      { ...removal().access, environment: "production" }, { ...removal().access, issuer_time: -1 },
      { ...removal().access, holder: vectors.account }, { ...removal().access, revocations: [revocations[0], revocations[0]] },
      { ...removal().access, revocations: [{ ...revocations[0], revision: -1 }] },
      { ...removal().access, revocations: [{ ...revocations[0], extra: true }] } ];
    for (const access of invalid) expect(await verifyAccountAccessResponse({ access }, vectors.account, trust)).toEqual({ status: "unavailable" });
    expect(await verifyAccountAccessResponse(removal(), "invalid-account", trust)).toEqual({ status: "unavailable" });
  });
});
