import { describe, expect, it, vi, afterEach } from "vitest";
import vectors from "../../../../../tests/access-proof/local-protection-vectors.json";
import signedVectors from "../../../../../tests/access-proof/vectors.json";
import type { BenefitId, LocalProtectionRecord } from "@still/shared-types";
import { assessOriginalProtection, localProtectionCutoff, mutateLocalProtection, parseLocalProtection, type LocalProtectionCutoff } from "../local-protection.js";
import { resolveBenefitAccess } from "../access-policy.js";
import { ChromeEntitlementAdapter } from "../chrome-adapter.js";
import { createEntitlementMessageRouter } from "../messages.js";
import { verifyAccessProof, type AccessTrust } from "../access-proof.js";

function cutoff(): LocalProtectionCutoff {
  return localProtectionCutoff({ product: vectors.cutoff.product, benefits: vectors.cutoff.benefits as BenefitId[] }, vectors.cutoff.activatedAt);
}
function declaration(policy: LocalProtectionCutoff | null = cutoff()) {
  return mutateLocalProtection(null, { kind: "declare", confirmed: true, priorEvidence: "absent", cutoff: policy })!;
}
const context = { paidMode: true, supported: true, free: false, accountId: null, localRights: new Set<string>(), evidenceStatus: "unknown" as const };
afterEach(() => vi.unstubAllGlobals());

describe("honest permanent local free protection", () => {
  for (const item of vectors.originals) {
    it(`shared raw vector ${item.name}`, () => {
      const before = JSON.stringify(item.browser);
      expect(assessOriginalProtection(item.browser).status).toBe(item.assessment);
      const result = mutateLocalProtection(null, { kind: "assess-original", original: item.browser, cutoff: cutoff() });
      expect(result?.grant !== null && result?.grant !== undefined).toBe(item.granted);
      expect(JSON.stringify(item.browser)).toBe(before);
    });
  }
  it("holds final issuance until actual cutoff exists, retaining sparse legacy facts", () => {
    const original = { firstRecordedAt: 1000, firstRecordedAppVersion: "2.0.0", opaque: { retain: true } };
    const pending = mutateLocalProtection(null, { kind: "assess-original", original, cutoff: null });
    expect(pending?.grant).toBeNull();
    expect(pending?.original?.firstRecordedAt).toBe(1000);
    expect(resolveBenefitAccess("youtube.comments", [], { ...context, localProtection: pending })).toBe("verification_required");
    const granted = mutateLocalProtection(pending, { kind: "apply-cutoff", cutoff: cutoff() });
    expect(granted?.grant?.benefits).toEqual(vectors.cutoff.benefits);
    expect(granted?.provenance).toBe("accepted_legacy_local");
    expect(original).toEqual({ firstRecordedAt: 1000, firstRecordedAppVersion: "2.0.0", opaque: { retain: true } });
  });
  it("requires affirmative explicit recovery and genuinely absent usable prior evidence", () => {
    for (const mutation of [
      {kind: "declare", confirmed: false, priorEvidence: "absent", cutoff: cutoff()},
      {kind: "declare", confirmed: true, priorEvidence: "unavailable", cutoff: cutoff()},
      {kind: "declare", confirmed: true, priorEvidence: "unreadable", cutoff: cutoff()},
    ]) expect(() => mutateLocalProtection(null, mutation as never)).toThrow();
    expect(declaration(null)).toEqual({schema: 1, provenance: "free_self_declaration", original: null, grant: null});
    expect(declaration().grant?.product).not.toBe("still-pro-v3");
  });
  it("never expires or requires a session, and never expands with a new registry/policy", () => {
    const local = declaration();
    const original = JSON.stringify(local);
    const changed = localProtectionCutoff({product: "fixture-later", benefits: ["youtube.related"]}, vectors.cutoff.activatedAt + 1000);
    for (const accountId of [null, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", null]) {
      expect(resolveBenefitAccess("youtube.comments", [], {...context, accountId, localProtection: local})).toBe("protected");
      expect(resolveBenefitAccess("youtube.related", [], {...context, accountId, localProtection: local, evidenceStatus: "absent"})).toBe("locked");
      expect(mutateLocalProtection(local, {kind: "apply-cutoff", cutoff: changed})).toEqual(local);
      expect(mutateLocalProtection(local, {kind: "assess-original", original: null, cutoff: null})).toEqual(local);
    }
    expect(resolveBenefitAccess("youtube.comments", [], {...context, supported: false, localProtection: local})).toBe("unsupported");
    expect(resolveBenefitAccess("youtube.comments", [], {...context, paidMode: false, localProtection: local})).toBe("free");
    expect(resolveBenefitAccess("youtube.comments", [], {...context, free: true, localProtection: local})).toBe("free");
    expect(JSON.stringify(local)).toBe(original);
  });
  it("rejects raw caller policy, paid products, malformed/unknown grant members and prototype getters", () => {
    expect(() => mutateLocalProtection(null, {kind: "declare", confirmed: true, priorEvidence: "absent", cutoff: vectors.cutoff as LocalProtectionCutoff})).toThrow("Untrusted");
    expect(() => localProtectionCutoff({product: "still-pro-v3", benefits: ["youtube.comments"]}, 1000)).toThrow();
    const local = declaration();
    for (const invalid of [
      {...local, accountId: "private"}, {...local, schema: 2}, {...local, provenance: "provider_verified"},
      {...local, original: {firstRecordedAt: 1, firstRecordedAppVersion: "1.0"}},
      {...local, grant: {...local.grant, benefits: ["future.anything"]}},
      {...local, grant: {...local.grant, product: "still-pro-v3"}},
      {...local, grant: {...local.grant, expiresAt: 1000}},
    ]) expect(() => parseLocalProtection(invalid)).toThrow();
    const getter = vi.fn(() => 1000);
    expect(assessOriginalProtection({get firstRecordedAt(){return getter();}, firstRecordedAppVersion:"1.0"}).status).toBe("unreadable");
    expect(getter).not.toHaveBeenCalled();
  });
});

it("local writes preserve a verified paid right's high-water and revocation; signing out retains independent local protection", async () => {
  const trust: AccessTrust = { environment: "sandbox", keys: [{kid: "synthetic-access", purpose: "access", environment: "sandbox", publicKeyHex: signedVectors.publicKeyHex}],
    protectedSnapshot: {product: signedVectors.protectedProduct, benefits: ["youtube.comments"]} };
  const result = await verifyAccessProof(signedVectors.vectors.find(item => item.name === "paid-account")!.envelope, trust);
  if (result.status !== "verified") throw new Error("synthetic paid vector invalid");
  let value: unknown;
  const area = {get: async () => ({"still:entitlement": value}), set: async (items: Record<string, unknown>) => {value = structuredClone(items["still:entitlement"]);} };
  vi.stubGlobal("chrome", {storage: {local: area}});
  const a = new ChromeEntitlementAdapter(() => 4000, {authority: true, trust});
  const b = new ChromeEntitlementAdapter(() => 4000, {authority: true, trust});
  const scope = await a.mutateAccess({kind: "account", accountId: signedVectors.account});
  await a.mutateAccess({kind: "install", proof: result.proof, generation: scope.record.generation, issuerNow: signedVectors.verifiedAt, wall: 1000, localRights: new Set()});
  await Promise.all([
    a.mutateLocalProtection({kind: "declare", confirmed: true, priorEvidence: "absent", cutoff: cutoff()}),
    b.mutateAccess({kind: "observe", observation: {wall: 4000}}),
    a.mutateAccess({kind: "revoke", right: result.proof.claims.right, revision: 1, generation: scope.record.generation}),
    b.setRecord({entitled: true, userId: signedVectors.account, updatedAt: 4000}),
  ]);
  const observed = await a.mutateAccess({kind: "observe", observation: {wall: 4000}});
  expect(observed.record.rights[0]!.clock?.highWater).toBe(signedVectors.verifiedAt + 3000);
  expect(observed.record.revocations).toHaveLength(1);
  expect(observed.evidence[0]?.revoked).toBe(true);
  expect(resolveBenefitAccess("youtube.comments", observed.evidence, {...context, accountId: signedVectors.account, localProtection: observed.record.localProtection})).toBe("protected");
  const snapshot = structuredClone(observed.record);
  await a.mutateLocalProtection({kind: "apply-cutoff", cutoff: cutoff()});
  expect(await a.observeAccess()).toEqual(snapshot);
  const signedOut = await b.mutateAccess({kind: "account", accountId: null});
  expect(signedOut.record.rights).toHaveLength(0);
  expect(signedOut.record.localProtection).toEqual(snapshot.localProtection);
  expect(signedOut.record.revocations).toEqual(snapshot.revocations);
});

it("existing serialized entitlement writer atomically preserves local and signed state across account/legacy writes", async () => {
  let value: unknown = {opaque: {keep: true}, access: {schema: 1, accountId: null, generation: 0, rights: [], revocations: [], futureMember: "retain"}};
  const area = {get: async () => ({"still:entitlement": value}), set: vi.fn(async (items: Record<string, unknown>) => { value = structuredClone(items["still:entitlement"]); })};
  vi.stubGlobal("chrome", {storage: {local: area}});
  const first = new ChromeEntitlementAdapter(() => 1000, {authority: true});
  const second = new ChromeEntitlementAdapter(() => 1000, {authority: true});
  await Promise.all([
    first.mutateLocalProtection({kind: "declare", confirmed: true, priorEvidence: "absent", cutoff: cutoff()}),
    second.mutateAccess({kind: "account", accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}),
    first.setRecord({entitled: false, updatedAt: 1000}),
  ]);
  const record = (value as {access: {localProtection: LocalProtectionRecord; generation: number; futureMember: string}; opaque: unknown}).access;
  expect(record.localProtection.provenance).toBe("free_self_declaration");
  expect(record.localProtection.grant?.benefits).toEqual(vectors.cutoff.benefits);
  expect(record.generation).toBe(2);
  expect(record.futureMember).toBe("retain");
  expect((value as {opaque: unknown}).opaque).toEqual({keep: true});
  const before = JSON.stringify(value);
  area.set.mockRejectedValueOnce(new Error("synthetic failed save"));
  await expect(first.mutateLocalProtection({kind: "apply-cutoff", cutoff: cutoff()})).rejects.toThrow("synthetic failed save");
  expect(JSON.stringify(value)).toBe(before);
  await expect(new ChromeEntitlementAdapter().mutateLocalProtection({kind: "declare", confirmed: true, priorEvidence: "absent", cutoff: cutoff()})).rejects.toThrow("authority");
  const router = createEntitlementMessageRouter(first, "extension", "chrome-extension://extension/");
  expect(router({kind: "declareFreeProtection", product: "still-pro-v3"}, {id: "extension", url: "chrome-extension://extension/popup.html"}, vi.fn())).toBe(false);
});
