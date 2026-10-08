import { afterEach, describe, expect, it, vi } from "vitest";
import vectors from "../../../../../tests/access-proof/vectors.json";
import { ChromeEntitlementAdapter } from "../chrome-adapter.js";
import {
  createAccountAccessReconciler,
  verifyAccountAccessResponse,
  type AccountAccessResult,
} from "../account-access-transport.js";
import { verifyAccessProof, type AccessTrust } from "../access-proof.js";
import {
  EMPTY_ACCESS_RECORD,
  type AccessCacheRecord,
} from "../access-record.js";
const trust: AccessTrust = {
  environment: "sandbox",
  keys: [
    {
      kid: "synthetic-access",
      publicKeyHex: vectors.publicKeyHex,
      environment: "sandbox",
      purpose: "access",
    },
  ],
};
const session = {
  userId: vectors.account,
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const account = vectors.vectors.find(
  (v) => v.name === "paid-account",
)!.envelope;
const local = vectors.vectors.find(
  (v) => v.name === "paid-apple-local",
)!.envelope;
function response(
  proofs = [account],
  revocations: readonly { right: string; revision: number }[] = [],
  status = "verified",
) {
  return {
    access: {
      status,
      environment: "sandbox",
      proofs,
      revocations,
      issuer_time: vectors.verifiedAt,
    },
  };
}
async function verified(value = response()) {
  return verifyAccountAccessResponse(value, session.userId, trust);
}
function chromeStore(initial: AccessCacheRecord = { ...EMPTY_ACCESS_RECORD }) {
  const store: Record<string, unknown> = {
    "still:entitlement": {
      entitled: true,
      updatedAt: 99,
      access: structuredClone(initial),
    },
  };
  const writes: Record<string, unknown>[] = [];
  const area = {
    get: vi.fn(async () => structuredClone(store)),
    set: vi.fn(async (values: Record<string, unknown>) => {
      writes.push(structuredClone(values));
      Object.assign(store, structuredClone(values));
    }),
  };
  vi.stubGlobal("chrome", {
    storage: {
      local: area,
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  return {
    store,
    writes,
    area,
    record: () =>
      (store["still:entitlement"] as { access: AccessCacheRecord }).access,
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("atomic browser account proof batch", () => {
  it("installs session/proof with one writer commit and never touches legacy clock", async () => {
    const s = chromeStore();
    const writer = new ChromeEntitlementAdapter(() => vectors.verifiedAt, {
      authority: true,
      trust,
    });
    expect(
      await writer.commitAccountAccess(session, await verified(), () => true),
    ).toBe("committed");
    expect(s.writes).toHaveLength(1);
    expect(s.record().accountId).toBe(session.userId);
    expect(s.record().sessionId).toBe(session.sessionId);
    expect(s.record().rights).toHaveLength(1);
    expect(s.record().rights[0]?.accountGeneration).toBe(s.record().generation);
    expect(
      (s.store["still:entitlement"] as { updatedAt: number }).updatedAt,
    ).toBe(99);
  });
  it("unavailable and stale admission never write or renew clocks", async () => {
    const s = chromeStore();
    const writer = new ChromeEntitlementAdapter(() => vectors.verifiedAt, {
      authority: true,
      trust,
    });
    expect(
      await writer.commitAccountAccess(
        session,
        { status: "unavailable" },
        () => true,
      ),
    ).toBe("unavailable");
    expect(
      await writer.commitAccountAccess(session, await verified(), () => false),
    ).toBe("stale");
    expect(s.writes).toHaveLength(0);
  });
  it("same exact envelope is not restamped on retry", async () => {
    const s = chromeStore();
    let wall = vectors.verifiedAt;
    const writer = new ChromeEntitlementAdapter(() => wall, {
      authority: true,
      trust,
    });
    const result = await verified();
    await writer.commitAccountAccess(session, result, () => true);
    const before = s.record().rights[0]?.clock;
    wall += 6000;
    await writer.commitAccountAccess(session, result, () => true);
    expect(s.record().rights[0]?.clock).toEqual(before);
  });
  it("unavailable partial refund removes only its known right and preserves unrelated Apple clocks", async () => {
    const s = chromeStore();
    const writer = new ChromeEntitlementAdapter(() => vectors.verifiedAt, {
      authority: true,
      trust,
    });
    const apple = await verifyAccessProof(local, trust);
    if (apple.status !== "verified") throw Error("local");
    await writer.mutateAccess({
      kind: "install",
      proof: apple.proof,
      generation: 0,
      issuerNow: vectors.verifiedAt,
      wall: vectors.verifiedAt,
      localRights: new Set([apple.proof.claims.right]),
    });
    const accountResult = await verified();
    if (accountResult.status === "unavailable") throw Error("account");
    await writer.commitAccountAccess(session, accountResult, () => true);
    const before = structuredClone(s.record());
    const writes = s.writes.length;
    const claims = accountResult.proofs[0]!.claims;
    const removal = await verified(
      response(
        [],
        [{ right: claims.right, revision: claims.ownership_revision }],
        "unavailable",
      ),
    );
    expect(await writer.commitAccountAccess(session, removal, () => true)).toBe(
      "committed",
    );
    expect(s.writes).toHaveLength(writes + 1);
    expect(s.record().rights.find((right) => right.envelope === local)).toEqual(
      before.rights.find((right) => right.envelope === local),
    );
    expect(
      s.record().rights.find((right) => right.envelope === account)?.clock,
    ).toEqual({
      ...before.rights.find((right) => right.envelope === account)!.clock,
      revoked: true,
    });
    expect(s.record().generation).toBe(before.generation);
    expect(s.record().revocations).toContainEqual({
      right: claims.right,
      revision: claims.ownership_revision,
    });
    expect(
      (s.store["still:entitlement"] as { updatedAt: number }).updatedAt,
    ).toBe(99);
  });
  it("stale admission and auth replacement during removal read never persist removals", async () => {
    const s = chromeStore();
    const writer = new ChromeEntitlementAdapter(() => vectors.verifiedAt, {
      authority: true,
      trust,
    });
    const grant = await verified();
    if (grant.status === "unavailable") throw Error("account");
    await writer.commitAccountAccess(session, grant, () => true);
    const removal = await verified(
      response(
        [],
        [{ right: grant.proofs[0]!.claims.right, revision: 1 }],
        "unavailable",
      ),
    );
    const before = structuredClone(s.record()),
      writes = s.writes.length;
    expect(
      await writer.commitAccountAccess(session, removal, () => false),
    ).toBe("stale");
    let current = true;
    const get = s.area.get.getMockImplementation()!;
    s.area.get.mockImplementationOnce(async () => {
      const value = await get();
      current = false;
      return value;
    });
    expect(
      await writer.commitAccountAccess(session, removal, () => current),
    ).toBe("stale");
    expect(s.writes).toHaveLength(writes);
    expect(s.record()).toEqual(before);
  });
  it("revocation and all proofs are atomic, and revoked ownership cannot be reinstalled", async () => {
    const s = chromeStore();
    const writer = new ChromeEntitlementAdapter(() => vectors.verifiedAt, {
      authority: true,
      trust,
    });
    await writer.commitAccountAccess(session, await verified(), () => true);
    const right = await verified();
    if (right.status === "unavailable") throw Error("proof");
    const id = right.proofs[0]!.claims.right,
      revision = right.proofs[0]!.claims.ownership_revision;
    await writer.commitAccountAccess(
      session,
      await verified(response([], [{ right: id, revision }], "none")),
      () => true,
    );
    const prior = structuredClone(s.record());
    const writes = s.writes.length;
    await expect(
      writer.commitAccountAccess(session, right, () => true),
    ).rejects.toThrow("Known revoked access");
    expect(s.record()).toEqual(prior);
    expect(s.writes).toHaveLength(writes);
  });
  it("a later invalid proof cannot leave the first proof installed", async () => {
    const s = chromeStore();
    const writer = new ChromeEntitlementAdapter(() => vectors.verifiedAt, {
      authority: true,
      trust,
    });
    const valid = await verified();
    if (valid.status === "unavailable") throw Error("proof");
    const forged = {
      ...valid,
      proofs: [...valid.proofs, { ...valid.proofs[0]! }],
    } as AccountAccessResult;
    await expect(
      writer.commitAccountAccess(session, forged, () => true),
    ).rejects.toThrow();
    expect(s.writes).toHaveLength(0);
  });
  it("auth replacement while storage acknowledgment is pending clears obsolete account proofs before return", async () => {
    const s = chromeStore();
    let current = true;
    const writer = new ChromeEntitlementAdapter(() => vectors.verifiedAt, {
      authority: true,
      trust,
    });
    const set = s.area.set.getMockImplementation()!;
    s.area.set.mockImplementationOnce(async (values) => {
      await set(values);
      current = false;
    });
    expect(
      await writer.commitAccountAccess(
        session,
        await verified(),
        () => current,
      ),
    ).toBe("stale");
    expect(s.writes).toHaveLength(2);
    expect(s.record().accountId).toBeNull();
    expect(s.record().rights).toHaveLength(0);
  });
  it("same-session overlap after storage commit does not erase valid rights", async () => {
    const s = chromeStore();
    let current = true;
    const writer = new ChromeEntitlementAdapter(() => vectors.verifiedAt, {
      authority: true,
      trust,
    });
    const set = s.area.set.getMockImplementation()!;
    s.area.set.mockImplementationOnce(async (values) => {
      await set(values);
      current = false;
    });
    expect(
      await writer.commitAccountAccess(
        session,
        await verified(),
        () => current,
        () => true,
      ),
    ).toBe("stale");
    expect(s.writes).toHaveLength(1);
    expect(s.record().accountId).toBe(session.userId);
    expect(s.record().rights).toHaveLength(1);
  });
  it("new absence evidence invalidates projections without aborting an in-flight read", async () => {
    const s = chromeStore();
    let absent = false;
    const writer = new ChromeEntitlementAdapter(() => vectors.verifiedAt, {
      authority: true,
      trust,
      context: () => ({
        paidMode: true,
        supported: new Set(["youtube.comments"]),
        session,
        localRights: new Set(),
        evidenceStatus: absent ? "absent" : "unknown",
      }),
    });
    let release!: () => void;
    const get = s.area.get.getMockImplementation()!;
    s.area.get.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return get();
    });
    const old = writer.observeBenefits();
    for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
    absent = true;
    writer.invalidateBenefitSnapshot();
    release();
    expect((await old).states["youtube.comments"]).toBe(
      "verification_required",
    );
    expect((await writer.observeBenefits()).states["youtube.comments"]).toBe(
      "locked",
    );
  });
  it("rejects explicit absence whose deadline expired between synchronous clock reads", async () => {
    chromeStore();
    const writer = new ChromeEntitlementAdapter(() => 60_000, {
      authority: true, trust,
      context: () => ({ paidMode: true, supported: new Set(["youtube.comments"]), session,
        localRights: new Set(), evidenceStatus: "absent", evidenceDeadline: null }),
    });
    await expect(writer.observeBenefits()).rejects.toThrow("Access observation expired");
  });
  it.each(["expires", "new reconciliation"])("does not renew captured absence when %s during the durable read", async (change) => {
    const s = chromeStore();
    let wall = 59_950;
    let deadline: number | null = 60_000;
    const writer = new ChromeEntitlementAdapter(() => wall, {
      authority: true, trust,
      context: () => ({ paidMode: true, supported: new Set(["youtube.comments"]), session,
        localRights: new Set(), evidenceStatus: "absent" }),
      evidenceDeadline: () => deadline,
    });
    const set = s.area.set.getMockImplementation()!;
    s.area.set.mockImplementationOnce(async (values) => {
      wall = change === "expires" ? 60_010 : 59_980;
      deadline = null;
      await set(values);
    });
    if (change === "expires") await expect(writer.observeBenefits()).rejects.toThrow("Access observation expired");
    else expect((await writer.observeBenefits()).refreshAfterMs).toBe(20);
  });
  it("changing sessions or signing out preserves independently verified Apple rights", async () => {
    const s = chromeStore();
    const writer = new ChromeEntitlementAdapter(() => vectors.verifiedAt, {
      authority: true,
      trust,
    });
    const proof = await verifyAccessProof(local, trust);
    expect(proof.status).toBe("verified");
    if (proof.status !== "verified") throw Error("local");
    await writer.mutateAccess({
      kind: "install",
      proof: proof.proof,
      generation: 0,
      issuerNow: vectors.verifiedAt,
      wall: vectors.verifiedAt,
      localRights: new Set([proof.proof.claims.right]),
    });
    await writer.commitAccountAccess(session, await verified(), () => true);
    expect(s.record().rights).toHaveLength(2);
    await writer.mutateAccess({ kind: "session", session: null });
    expect(s.record().rights).toHaveLength(1);
    expect(s.record().rights[0]?.envelope).toBe(local);
    await writer.commitAccountAccess(
      { ...session, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      await verified(),
      () => true,
    );
    expect(s.record().rights).toHaveLength(2);
    expect(s.record().generation).toBe(3);
  });
});
describe("verified auth captured outside writer", () => {
  function harness() {
    let epoch = 0;
    const invoke = vi.fn(async () => ({ data: response(), error: null }));
    const readSession = vi.fn(async () => session);
    const commit = vi.fn(async () => "committed" as const);
    const r = createAccountAccessReconciler({
      trust,
      invoke,
      readSession,
      commit,
      epoch: () => epoch,
    });
    return { r, invoke, readSession, commit, bump: () => epoch++ };
  }
  it("calls the real scoped verifier and passes only branded proof to one atomic commit", async () => {
    const h = harness();
    expect(await h.r.reconcile()).toBe("ok");
    expect(h.r.read()).toBe("entitled");
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.invoke).toHaveBeenCalledWith("reconcile-entitlement", {
      body: { access_schema: 1 },
    });
    expect(h.readSession.mock.invocationCallOrder[0]).toBeLessThan(
      h.commit.mock.invocationCallOrder[0]!,
    );
  });
  it("a conclusive no-right observation expires and is fenced to its exact verified session", async () => {
    let wall = 100;
    const invoke = vi.fn(async () => ({
      data: response([], [], "none"),
      error: null,
    }));
    const r = createAccountAccessReconciler({
      trust,
      invoke,
      readSession: async () => session,
      commit: async () => "committed",
      epoch: () => 0,
      now: () => wall,
    });
    expect(await r.reconcile()).toBe("ok");
    expect(r.evidenceStatus(session)).toBe("absent");
    expect(
      r.evidenceStatus({
        ...session,
        sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).toBe("unknown");
    wall = 99;
    expect(r.evidenceStatus(session)).toBe("unknown");
    wall = 60_100;
    expect(r.evidenceStatus(session)).toBe("unknown");
  });
  it("structured HTTP401 requires re-sign-in without committing absence", async () => {
    const commit = vi.fn(async () => "committed" as const);
    const r = createAccountAccessReconciler({
      trust,
      readSession: async () => session,
      commit,
      epoch: () => 0,
      invoke: async () => ({ data: null, error: { status: 401 } }),
      authRequired: (error) => (error as { status?: number })?.status === 401,
    });
    expect(await r.reconcile()).toBe("auth-required");
    expect(commit).not.toHaveBeenCalled();
    expect(r.read()).toBe("unknown");
  });
  it("missing Boolean-only evidence never writes", async () => {
    const h = harness();
    h.invoke.mockResolvedValue({
      data: { still_sync: true } as never,
      error: null,
    });
    expect(await h.r.reconcile()).toBe("unavailable");
    expect(h.commit).not.toHaveBeenCalled();
  });
  it("validated unavailable removals commit but cannot establish absence or readiness", async () => {
    const h = harness();
    h.invoke.mockResolvedValue({
      data: response(
        [],
        [{ right: "11111111-1111-4111-8111-111111111111", revision: 2 }],
        "unavailable",
      ),
      error: null,
    });
    expect(await h.r.reconcile()).toBe("unavailable");
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.commit).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        status: "unavailable",
        proofs: [],
        revocations: [
          { right: "11111111-1111-4111-8111-111111111111", revision: 2 },
        ],
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(h.r.read()).toBe("unknown");
    expect(h.r.evidenceStatus(session)).toBe("unknown");
  });
  it("same-account ABA fences unavailable removals before the writer", async () => {
    const h = harness();
    h.invoke.mockImplementationOnce(async () => {
      h.bump();
      h.bump();
      return {
        data: response(
          [],
          [{ right: "11111111-1111-4111-8111-111111111111", revision: 2 }],
          "unavailable",
        ),
        error: null,
      };
    });
    expect(await h.r.reconcile()).toBe("unavailable");
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.r.evidenceStatus(session)).toBe("unknown");
  });
  it("conflict is definitive for Boolean throttling while access evidence remains unknown", async () => {
    const h = harness();
    for (const proofs of [[], [account]]) {
      h.invoke.mockResolvedValue({
        data: response(proofs, [], "conflict"),
        error: null,
      });
      expect(await h.r.reconcile()).toBe("ok");
      expect(h.r.read()).toBe(proofs.length ? "entitled" : "not-entitled");
      expect(h.r.evidenceStatus(session)).toBe("unknown");
      expect(h.r.evidenceDeadline()).toBeNull();
    }
  });
  it("same-user ABA during asynchronous verification fences commit", async () => {
    const h = harness();
    h.invoke.mockImplementationOnce(async () => {
      h.bump();
      h.bump();
      return { data: response(), error: null };
    });
    expect(await h.r.reconcile()).toBe("unavailable");
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.r.read()).toBe("unknown");
  });
  it("a newer reconcile fences an older same-session response before it reaches the writer", async () => {
    const h = harness();
    let release!: (value: {
      data: ReturnType<typeof response>;
      error: null;
    }) => void;
    h.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const old = h.r.reconcile();
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(await h.r.reconcile()).toBe("ok");
    release({ data: response(), error: null });
    expect(await old).toBe("unavailable");
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.r.read()).toBe("entitled");
  });
  it("auth changes during SDK refresh are fenced before invocation", async () => {
    const h = harness();
    h.readSession.mockImplementationOnce(async () => {
      h.bump();
      return session;
    });
    expect(await h.r.reconcile()).toBe("unavailable");
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("a later unavailable response cannot renew the prior validated compatibility observation", async () => {
    const h = harness();
    await h.r.reconcile();
    h.invoke.mockResolvedValue({
      data: null as never,
      error: new Error("offline") as never,
    });
    expect(await h.r.reconcile()).toBe("unavailable");
    expect(h.r.read()).toBe("unknown");
    expect(h.commit).toHaveBeenCalledOnce();
  });
});
