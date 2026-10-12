import { afterEach, describe, expect, it, vi } from "vitest";
import vectors from "../../../../../tests/access-proof/vectors.json";
import { ChromeEntitlementAdapter } from "../chrome-adapter.js";
import { createAccountAccessReconciler, verifyAccountAccessResponse } from "../account-access-transport.js";
import { verifyAccessProof, type AccessTrust } from "../access-proof.js";
import { EMPTY_ACCESS_RECORD, type AccessCacheRecord } from "../access-record.js";
import type { TrustedAccessContext } from "../access-policy.js";

// ISS-0030: a signed-out, never-bought install must see every supported Still Pro row as
// `locked` (lock chip and purchase offer), while every real uncertainty stays
// `verification_required`. Signed synthetic proof vectors only; no network, no provider.
const trust: AccessTrust = {
  environment: "sandbox",
  keys: [{ kid: "synthetic-access", publicKeyHex: vectors.publicKeyHex, environment: "sandbox", purpose: "access" }],
};
const session = { userId: vectors.account, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const account = vectors.vectors.find((v) => v.name === "paid-account")!.envelope;
const PRO = "youtube.comments" as const;

function chromeStore(initial?: AccessCacheRecord, extra: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = initial ? { "still:entitlement": { access: structuredClone(initial), ...extra } } : {};
  const area = {
    get: vi.fn(async () => structuredClone(store)),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(store, structuredClone(values)); }),
  };
  vi.stubGlobal("chrome", { storage: { local: area, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  return { store, area, record: () => (store["still:entitlement"] as { access: AccessCacheRecord }).access };
}

function reconciler(reply: unknown, wall: () => number = () => vectors.verifiedAt) {
  let epoch = 0;
  const r = createAccountAccessReconciler({
    trust, routeProfile: "shared-hosted-sandbox", readSession: async () => session,
    invoke: async () => ({ data: reply, error: null }), commit: async () => "committed", epoch: () => epoch, now: wall,
  });
  return { r, bump: () => { epoch++; } };
}
const none = { access: { status: "none", environment: "sandbox", proofs: [], revocations: [], issuer_time: vectors.verifiedAt } };

/** The background's context builder shape: session plus the reconciler's evidence for it. */
function writer(
  readSession: () => TrustedAccessContext["session"],
  evidence: ReturnType<typeof createAccountAccessReconciler>,
  wall: () => number = () => vectors.verifiedAt,
) {
  return new ChromeEntitlementAdapter(wall, {
    authority: true, trust,
    context: () => {
      const verified = readSession();
      return { paidMode: true, supported: new Set([PRO, "youtube.shorts"]), localRights: new Set(), session: verified,
        evidenceStatus: evidence.evidenceStatus(verified), evidenceDeadline: evidence.evidenceDeadline() };
    },
    evidenceDeadline: () => evidence.evidenceDeadline(),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("account evidence for the host's session answer", () => {
  it("signed out (null) is conclusive account absence without any reconciliation", () => {
    const { r } = reconciler(none);
    expect(r.evidenceStatus(null)).toBe("absent");
  });
  it("verification unavailable (undefined) stays unknown", () => {
    const { r } = reconciler(none);
    expect(r.evidenceStatus(undefined)).toBe("unknown");
  });
  it("signed in is absent only for a fresh conclusive none of that session; unavailable stays unknown", async () => {
    const fresh = reconciler(none);
    expect(fresh.r.evidenceStatus(session)).toBe("unknown");
    expect(await fresh.r.reconcile()).toBe("ok");
    expect(fresh.r.evidenceStatus(session)).toBe("absent");
    const down = reconciler({ access: { ...none.access, status: "unavailable" } });
    expect(await down.r.reconcile()).toBe("unavailable");
    expect(down.r.evidenceStatus(session)).toBe("unknown");
  });
});

describe("signed-out Still Pro access through the background writer (ISS-0030)", () => {
  it("a fresh signed-out install resolves supported Pro rows to locked, with a normal refresh", async () => {
    chromeStore();
    const { r } = reconciler(none);
    const snapshot = await writer(() => null, r).observeBenefits();
    expect(snapshot.states[PRO]).toBe("locked");
    expect(snapshot.states["youtube.shorts"]).toBe("free");
    expect(snapshot.refreshAfterMs).toBe(60_000);
  });
  it("signed-out absence is not treated as an expired reconciliation on later observations", async () => {
    chromeStore();
    const { r } = reconciler(none);
    let wall = vectors.verifiedAt;
    const authority = writer(() => null, r, () => wall);
    expect((await authority.observeBenefits()).states[PRO]).toBe("locked");
    wall += 61_000;
    expect((await authority.observeBenefits()).states[PRO]).toBe("locked");
    wall += 10 * 60_000;
    expect((await authority.observeBenefits()).states[PRO]).toBe("locked");
  });
  it("verification unavailable (undefined session) stays verification_required", async () => {
    chromeStore();
    const { r } = reconciler(none);
    expect((await writer(() => undefined, r).observeBenefits()).states[PRO]).toBe("verification_required");
  });
  it("signed in without a reconciliation, or with an unavailable server, stays verification_required", async () => {
    chromeStore();
    const quiet = reconciler(none);
    expect((await writer(() => session, quiet.r).observeBenefits()).states[PRO]).toBe("verification_required");
    const down = reconciler({ access: { ...none.access, status: "unavailable" } });
    await down.r.reconcile();
    expect((await writer(() => session, down.r).observeBenefits()).states[PRO]).toBe("verification_required");
  });
  it("signed in with a fresh conclusive none is locked; once that absence expires it is verification_required", async () => {
    chromeStore();
    let wall = vectors.verifiedAt;
    const { r } = reconciler(none, () => wall);
    expect(await r.reconcile()).toBe("ok");
    const authority = writer(() => session, r, () => wall);
    expect((await authority.observeBenefits()).states[PRO]).toBe("locked");
    wall += 60_001;
    expect((await authority.observeBenefits()).states[PRO]).toBe("verification_required");
  });
  it("signed out with unreadable local protection, or an unverifiable stored right, stays verification_required", async () => {
    chromeStore({ ...EMPTY_ACCESS_RECORD, sessionId: null, localProtection: { schema: 99 } as never });
    const { r } = reconciler(none);
    expect((await writer(() => null, r).observeBenefits()).states[PRO]).toBe("verification_required");
    chromeStore({ ...EMPTY_ACCESS_RECORD, sessionId: null, rights: [{ envelope: "{\"tampered\":true}", clock: null }] });
    expect((await writer(() => null, r).observeBenefits()).states[PRO]).toBe("verification_required");
  });
  it("signing out after an account purchase locks; signing back in restores Pro on the next reconcile", async () => {
    const s = chromeStore();
    const verified = await verifyAccountAccessResponse(
      { access: { status: "verified", environment: "sandbox", proofs: [account], revocations: [], issuer_time: vectors.verifiedAt } },
      session.userId, trust);
    let current: TrustedAccessContext["session"] = session;
    const { r, bump } = reconciler(none);
    const authority = writer(() => current, r);
    expect(await authority.commitAccountAccess(session, verified, () => true)).toBe("committed");
    expect((await authority.observeBenefits()).states[PRO]).toBe("purchased");
    // Sign-out: the auth boundary bumps the reconciler epoch and invalidates the context.
    current = null; bump(); authority.invalidateAccessContext();
    expect((await authority.observeBenefits()).states[PRO]).toBe("locked");
    expect(s.record().accountId).toBeNull();
    expect(s.record().rights).toHaveLength(0); // account proofs never apply while signed out
    // Sign back in: unknown until the account reconcile lands, then purchased again.
    current = session; bump(); authority.invalidateAccessContext();
    expect((await authority.observeBenefits()).states[PRO]).toBe("verification_required");
    expect(await authority.commitAccountAccess(session, verified, () => true)).toBe("committed");
    authority.invalidateBenefitSnapshot();
    expect((await authority.observeBenefits()).states[PRO]).toBe("purchased");
  });
  it("signed out, an independently verified local Apple right still grants; absence only covers the account lane", async () => {
    chromeStore();
    const local = vectors.vectors.find((v) => v.name === "paid-apple-local")!.envelope;
    const proof = await verifyAccessProof(local, trust);
    if (proof.status !== "verified") throw new Error("synthetic local proof");
    const right = proof.proof.claims.right;
    const { r } = reconciler(none);
    const authority = new ChromeEntitlementAdapter(() => vectors.verifiedAt, {
      authority: true, trust,
      context: () => ({ paidMode: true, supported: new Set([PRO]), localRights: new Set([right]), session: null,
        evidenceStatus: r.evidenceStatus(null), evidenceDeadline: r.evidenceDeadline() }),
    });
    await authority.mutateAccess({ kind: "install", proof: proof.proof, generation: 0, issuerNow: vectors.verifiedAt,
      wall: vectors.verifiedAt, localRights: new Set([right]) });
    expect((await authority.observeBenefits()).states[PRO]).toBe("purchased");
  });
});

describe("a signed-out open never flashes verify again (ISS-0030)", () => {
  /** chrome.storage.local that reports every set to onChanged, identical writes included (Firefox). */
  function noisyStore() {
    const store: Record<string, unknown> = {};
    const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
    const area = {
      get: vi.fn(async () => structuredClone(store)),
      set: vi.fn(async (values: Record<string, unknown>) => {
        const changes: Record<string, chrome.storage.StorageChange> = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: structuredClone(store[key]), newValue: structuredClone(value) };
          store[key] = structuredClone(value);
        }
        for (const listener of [...listeners]) listener(changes, "local");
      }),
    };
    vi.stubGlobal("chrome", { storage: { local: area, onChanged: {
      addListener: (listener: Parameters<typeof listeners.add>[0]) => listeners.add(listener),
      removeListener: (listener: Parameters<typeof listeners.add>[0]) => listeners.delete(listener),
    } } });
    return store;
  }

  it.each(["first-ever open", "a later open"])("%s goes from checking straight to locked", async (when) => {
    const store = noisyStore();
    const { r } = reconciler(none);
    if (when === "a later open") await writer(() => null, r).observeBenefits(); // a previous popup
    const { EntitlementCache } = await import("../cache.js");
    const cache = new EntitlementCache(writer(() => null, r), { access: { paidMode: true, supported: new Set([PRO, "youtube.shorts"]) } });
    const seen: string[] = [cache.currentAccess(PRO)];
    cache.subscribeAccess((snapshot) => seen.push(snapshot.states[PRO]));
    const stop = cache.watch();
    await cache.refreshAccess();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    stop();
    expect(store["still:entitlement"]).toBeDefined(); // the observation did write
    expect(seen).toEqual(["checking", "locked"]);
  });
});
