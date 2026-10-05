import { afterEach, describe, expect, it, vi } from "vitest";
import { OrdinaryPolicyCache, type PolicyCacheRecord, type PolicyCacheRead } from "../product-policy-cache.js";

type Projection = { readonly label: string; readonly nested: { readonly choices: readonly number[] } };
const projection = (label = "synthetic-known"): Projection => ({ label, nested: { choices: [1, 2] } });
const SIX_HOURS = 6 * 60 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(initial: PolicyCacheRead<Projection> = { status: "missing" }) {
  let wall = 1000;
  let stored = structuredClone(initial);
  const readTrusted = vi.fn(async (_signal: AbortSignal) => structuredClone(stored));
  const fetchVerified = vi.fn(async (_signal: AbortSignal) => ({ revision: 1, projection: projection() }));
  const commit = vi.fn(async (record: PolicyCacheRecord<Projection>, context: { readonly signal: AbortSignal; readonly isCurrent: () => boolean }) => {
    if (context.signal.aborted || !context.isCurrent()) throw new Error("stale synthetic commit");
    stored = { status: "loaded", record: structuredClone(record) };
    return { status: "committed" as const };
  });
  const cache = new OrdinaryPolicyCache({ now: () => wall, readTrusted, fetchVerified, commit });
  return { cache, readTrusted, fetchVerified, commit, stored: () => structuredClone(stored), setWall: (value: number) => { wall = value; } };
}
afterEach(() => vi.useRealTimers());

describe("dormant ordinary policy cache with synthetic trusted ports", () => {
  it("keeps an immediately readable missing baseline while a started fetch is pending and coalesces openings", async () => {
    const h = harness(), candidate = deferred<{ revision: number; projection: Projection }>();
    h.fetchVerified.mockImplementation(() => candidate.promise);
    const first = h.cache.onOrdinaryOpen();
    await vi.waitFor(() => expect(h.fetchVerified).toHaveBeenCalledTimes(1));
    const second = h.cache.onOrdinaryOpen();
    expect(first).toBe(second);
    expect(h.cache.current()).toMatchObject({ status: "missing", revision: null, projection: null, pending: true });
    expect(h.commit).not.toHaveBeenCalled();
    candidate.resolve({ revision: 1, projection: projection() });
    await first;
    expect(h.cache.current()).toMatchObject({ status: "loaded", revision: 1, projection: projection(), pending: false });
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  it("waits six hours after a trusted successful committed check before an ordinary refresh", async () => {
    const h = harness(); await h.cache.onOrdinaryOpen();
    h.setWall(1000 + SIX_HOURS - 1); await h.cache.onOrdinaryOpen();
    expect(h.fetchVerified).toHaveBeenCalledTimes(1);
    h.setWall(1000 + SIX_HOURS); await h.cache.onOrdinaryOpen();
    expect(h.fetchVerified).toHaveBeenCalledTimes(2);
    expect(h.commit).toHaveBeenCalledTimes(2);
  });

  it("spaces ordinary failed checks by fifteen minutes without overwriting prior bytes", async () => {
    const h = harness(); h.fetchVerified.mockRejectedValue(new Error("synthetic offline"));
    await h.cache.onOrdinaryOpen();
    const retained = h.stored();
    h.setWall(1000 + FIFTEEN_MINUTES - 1); await h.cache.onOrdinaryOpen();
    expect(h.fetchVerified).toHaveBeenCalledTimes(1);
    h.setWall(1000 + FIFTEEN_MINUTES); await h.cache.onOrdinaryOpen();
    expect(h.fetchVerified).toHaveBeenCalledTimes(2);
    expect(h.commit).not.toHaveBeenCalled(); expect(h.stored()).toEqual(retained);
  });

  it("distinguishes unreadable storage, retries only after failure spacing and never overwrites it", async () => {
    const h = harness({ status: "unreadable" });
    await h.cache.onOrdinaryOpen();
    expect(h.cache.current()).toMatchObject({ status: "unreadable", projection: null });
    expect(h.fetchVerified).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled();
    h.setWall(1000 + FIFTEEN_MINUTES - 1); await h.cache.onOrdinaryOpen();
    expect(h.readTrusted).toHaveBeenCalledTimes(1);
    h.setWall(1000 + FIFTEEN_MINUTES); await h.cache.onOrdinaryOpen();
    expect(h.readTrusted).toHaveBeenCalledTimes(2);
    expect(h.stored()).toEqual({ status: "unreadable" });
  });

  it("never publishes a candidate or successful-check metadata before acknowledged persistence", async () => {
    const h = harness(); await h.cache.onOrdinaryOpen();
    const retained = h.stored(), changes = vi.fn(); h.cache.subscribe(changes);
    const acknowledgment = deferred<{ status: "committed" }>();
    const commit = h.commit.getMockImplementation()!;
    h.commit.mockImplementationOnce(async (record, context) => { await acknowledgment.promise; return commit(record, context); });
    h.fetchVerified.mockResolvedValueOnce({ revision: 2, projection: projection("synthetic-new") });
    h.setWall(1000 + SIX_HOURS); const pending = h.cache.onOrdinaryOpen();
    await vi.waitFor(() => expect(h.commit).toHaveBeenCalledTimes(2));
    expect(h.cache.current().revision).toBe(1);
    expect(changes.mock.calls.some(([value]) => value.revision === 2)).toBe(false);
    acknowledgment.resolve({ status: "committed" }); await pending;
    expect(h.cache.current().revision).toBe(2);
    expect(h.stored()).not.toEqual(retained);
    expect(h.stored()).toMatchObject({ status: "loaded", record: { revision: 2 } });
  });

  it("keeps learned policy and storage through rejected persistence and rejects lower or conflicting revisions", async () => {
    const h = harness(); await h.cache.onOrdinaryOpen(); const retained = h.stored();
    h.setWall(1000 + SIX_HOURS);
    h.fetchVerified.mockResolvedValueOnce({ revision: 2, projection: projection("synthetic-new") });
    h.commit.mockRejectedValueOnce(new Error("synthetic disk failure"));
    await h.cache.onOrdinaryOpen(); expect(h.cache.current().revision).toBe(1); expect(h.stored()).toEqual(retained);
    h.setWall(1000 + SIX_HOURS + FIFTEEN_MINUTES);
    h.fetchVerified.mockResolvedValueOnce({ revision: 1, projection: projection("conflicting") });
    await h.cache.onOrdinaryOpen(); expect(h.commit).toHaveBeenCalledTimes(2); expect(h.stored()).toEqual(retained);
    h.setWall(1000 + SIX_HOURS + 2 * FIFTEEN_MINUTES);
    h.fetchVerified.mockResolvedValueOnce({ revision: 0, projection: projection() });
    await h.cache.onOrdinaryOpen(); expect(h.commit).toHaveBeenCalledTimes(2); expect(h.stored()).toEqual(retained);
  });

  it("detaches and freezes accepted projections and refuses backward or untrusted clock freshness", async () => {
    const h = harness(), candidate = { revision: 1, projection: projection() };
    h.fetchVerified.mockResolvedValueOnce(candidate); await h.cache.onOrdinaryOpen();
    (candidate.projection.nested.choices as number[]).push(3);
    expect(h.cache.current().projection?.nested.choices).toEqual([1, 2]);
    expect(Object.isFrozen(h.cache.current().projection)).toBe(true);
    expect(Object.isFrozen(h.cache.current().projection?.nested.choices)).toBe(true);
    h.setWall(999); await h.cache.onOrdinaryOpen();
    h.setWall(Number.NaN); await h.cache.onOrdinaryOpen();
    expect(h.fetchVerified).toHaveBeenCalledTimes(1);
    h.setWall(1000 + SIX_HOURS - 1); await h.cache.onOrdinaryOpen(); expect(h.fetchVerified).toHaveBeenCalledTimes(1);
    h.setWall(1000 + SIX_HOURS); await h.cache.onOrdinaryOpen(); expect(h.fetchVerified).toHaveBeenCalledTimes(2);
  });

  it("fences a genuinely started old fetch after invalidation and tears down a stopped fetch and listeners", async () => {
    const h = harness(), old = deferred<{ revision: number; projection: Projection }>();
    h.fetchVerified.mockImplementationOnce(() => old.promise);
    const first = h.cache.onOrdinaryOpen(); await vi.waitFor(() => expect(h.fetchVerified).toHaveBeenCalledTimes(1));
    h.cache.invalidate(); await first;
    h.fetchVerified.mockResolvedValueOnce({ revision: 2, projection: projection("synthetic-new") });
    await h.cache.onOrdinaryOpen(); old.resolve({ revision: 1, projection: projection("stale") });
    await Promise.resolve(); await Promise.resolve();
    expect(h.cache.current().revision).toBe(2); expect(h.commit).toHaveBeenCalledTimes(1);
    h.setWall(1000 + SIX_HOURS);
    const stopped = deferred<{ revision: number; projection: Projection }>();
    h.fetchVerified.mockImplementationOnce(() => stopped.promise);
    const changes = vi.fn(); h.cache.subscribe(changes);
    const pending = h.cache.onOrdinaryOpen(); await vi.waitFor(() => expect(h.fetchVerified).toHaveBeenCalledTimes(3));
    h.cache.stop(); await pending; changes.mockClear();
    stopped.resolve({ revision: 3, projection: projection("stopped") });
    await Promise.resolve(); await Promise.resolve();
    await h.cache.onOrdinaryOpen();
    expect(h.cache.current()).toMatchObject({ revision: 2, pending: false, stopped: true });
    expect(h.commit).toHaveBeenCalledTimes(1); expect(changes).not.toHaveBeenCalled();
  });

  it("loads a trusted persisted policy without renewing its original success time", async () => {
    const h = harness({ status: "loaded", record: { schema: 1, revision: 2, projection: projection(), lastSuccess: 1000, highWater: 1000 } });
    await h.cache.onOrdinaryOpen();
    expect(h.cache.current()).toMatchObject({ status: "loaded", revision: 2 });
    expect(h.fetchVerified).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled();
    const retained = h.stored(); h.setWall(1000 + SIX_HOURS);
    h.fetchVerified.mockResolvedValueOnce({ revision: 1, projection: projection() });
    await h.cache.onOrdinaryOpen();
    expect(h.cache.current().revision).toBe(2); expect(h.stored()).toEqual(retained);
    h.setWall(1000 + SIX_HOURS + FIFTEEN_MINUTES);
    h.fetchVerified.mockResolvedValueOnce({ revision: 2, projection: { nested: { choices: [1, 2] }, label: "synthetic-known" } });
    await h.cache.onOrdinaryOpen();
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.stored()).toMatchObject({ record: { revision: 2, lastSuccess: 1000 + SIX_HOURS + FIFTEEN_MINUTES } });
  });

  it("keeps failed reads and future metadata distinct from confirmed missing storage", async () => {
    const h = harness(); h.readTrusted.mockRejectedValueOnce(new Error("synthetic read failure"));
    await h.cache.onOrdinaryOpen();
    expect(h.cache.current().status).toBe("unreadable");
    expect(h.fetchVerified).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled();
    const future = { status: "loaded" as const, record: { schema: 2 as unknown as 1, revision: 2, projection: projection(), lastSuccess: 1000, highWater: 1000 } };
    const unreadable = harness(future); await unreadable.cache.onOrdinaryOpen();
    expect(unreadable.cache.current().status).toBe("unreadable");
    expect(unreadable.fetchVerified).not.toHaveBeenCalled(); expect(unreadable.commit).not.toHaveBeenCalled();
    expect(unreadable.stored()).toEqual(future);
  });

  it("bounds a genuinely pending fetch, aborts its port and releases deadline timers", async () => {
    vi.useFakeTimers(); const h = harness(), held = deferred<{ revision: number; projection: Projection }>();
    let signal: AbortSignal | undefined;
    h.fetchVerified.mockImplementationOnce(async received => { signal = received; return held.promise; });
    const pending = h.cache.onOrdinaryOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchVerified).toHaveBeenCalledTimes(1); expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); await pending;
    expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    expect(h.cache.current()).toMatchObject({ status: "missing", pending: false, revision: null });
    held.resolve({ revision: 1, projection: projection() }); await vi.advanceTimersByTimeAsync(0);
    expect(h.commit).not.toHaveBeenCalled(); expect(h.stored()).toEqual({ status: "missing" });
    h.setWall(1000 + FIFTEEN_MINUTES - 1); await h.cache.onOrdinaryOpen();
    expect(h.fetchVerified).toHaveBeenCalledTimes(1);
    h.cache.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it("fences an actually pending authoritative commit after stop without claiming rollback", async () => {
    const h = harness(), release = deferred<void>(), committing = deferred<void>();
    const original = h.commit.getMockImplementation()!;
    h.commit.mockImplementationOnce(async (record, context) => { committing.resolve(); await release.promise; return original(record, context); });
    const pending = h.cache.onOrdinaryOpen(); await committing.promise;
    h.cache.stop(); await pending; release.resolve();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.cache.current()).toMatchObject({ stopped: true, pending: false, revision: null });
    expect(h.stored()).toEqual({ status: "missing" });
  });
  it("an empty candidate cannot erase the last accepted policy or become a successful check", async () => {
    const h = harness(); await h.cache.onOrdinaryOpen(); const retained = h.stored();
    h.setWall(1000 + SIX_HOURS);
    h.fetchVerified.mockResolvedValueOnce({ revision: 2, projection: null as unknown as Projection });
    await h.cache.onOrdinaryOpen();
    expect(h.cache.current()).toMatchObject({ revision: 1, projection: projection() });
    expect(h.commit).toHaveBeenCalledTimes(1); expect(h.stored()).toEqual(retained);
  });
  it("a failed authoritative reread keeps learned policy and exact storage, with ordinary failure spacing", async () => {
    const h = harness(); await h.cache.onOrdinaryOpen(); const retained = h.stored();
    h.setWall(1000 + SIX_HOURS); h.readTrusted.mockRejectedValueOnce(new Error("synthetic unreadable"));
    await h.cache.onOrdinaryOpen();
    expect(h.cache.current()).toMatchObject({ status: "loaded", revision: 1, projection: projection() });
    expect(h.fetchVerified).toHaveBeenCalledTimes(1); expect(h.stored()).toEqual(retained);
    h.setWall(1000 + SIX_HOURS + FIFTEEN_MINUTES - 1); await h.cache.onOrdinaryOpen();
    expect(h.readTrusted).toHaveBeenCalledTimes(2);
    h.setWall(1000 + SIX_HOURS + FIFTEEN_MINUTES); await h.cache.onOrdinaryOpen();
    expect(h.fetchVerified).toHaveBeenCalledTimes(2); expect(h.cache.current().revision).toBe(1);
  });
});
