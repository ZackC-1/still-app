import { describe, expect, it, vi } from "vitest";
import { FunctionsHttpError, type SupabaseClient } from "@supabase/supabase-js";
import { createExtensionSession, type CheckoutOperationRecord, type ExtensionSessionSync, type PersistedSlot } from "../extension-session.js";
import { SupabaseBackendPort } from "../profile.js";

const accountA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const accountB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const operationId = "11111111-1111-4111-8111-111111111111";
const url = "https://checkout.stripe.com/c/pay/cs_test_synthetic";
const created = () => ({ operation_id: operationId, status: "session_bound", checkout_url: url });
function slot<T>(initial: unknown = null) {
  const storage = { value: initial, get: vi.fn(async () => storage.value),
    set: vi.fn(async (value: T | null) => { storage.value = value; }) };
  return storage satisfies PersistedSlot<T> & { value: unknown };
}
function harness(initial: unknown = null) {
  let identity: { userId: string; sessionId: string } | null = { userId: accountA, sessionId: "session-a" };
  const operation = slot<CheckoutOperationRecord>(initial);
  const invoke = vi.fn(async (name: string) => ({ data: name === "qa-sandbox-create-web-checkout" ? created()
    : name === "qa-sandbox-complete-web-checkout" ? { operation_id: operationId, status: "imported" } : {}, error: null as unknown }));
  const backend = new SupabaseBackendPort({ functions: { invoke } } as unknown as SupabaseClient,
    { routeProfile: "shared-hosted-sandbox" });
  const records = { getRecord: vi.fn(async () => null), setRecord: vi.fn(async () => {}) };
  const auth = {
    signInWithMagicLink: vi.fn(async () => ({})), signOut: vi.fn(async () => {}),
    currentUserId: vi.fn(async () => identity?.userId ?? null),
    currentSettingsSession: vi.fn(async () => identity), requestCode: vi.fn(async () => ({ kind: "sent" as const })),
    verifyCode: vi.fn(async () => ({ kind: "verified" as const, userId: identity!.userId })),
  };
  const sync = { onSignedIn: vi.fn(async () => {}), onEntitlementConfirmed: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}), deleteAccount: vi.fn(async () => {}), resume: vi.fn(async () => {}),
    getState: vi.fn() } as unknown as ExtensionSessionSync;
  const stores = { pendingOtp: slot(null), checkoutPending: slot(null), nudgeStamp: slot<number>(), checkoutOperation: operation };
  const canCreateCheckout = vi.fn(async () => true);
  const closeTab = vi.fn(async (_tabId: number) => {});
  const makeSession = () => createExtensionSession({ auth, backend, records, sync, stores,
    canCreateCheckout,
    identity: { get: async () => accountA, set: async () => {} }, closeTab,
    clearAuthStorage: async () => { identity = null; } });
  return { makeSession, session: makeSession(), backend, invoke, records, stores, operation, canCreateCheckout, closeTab, auth,
    replaceSession: (next: typeof identity) => { identity = next; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("durable sandbox checkout recovery", () => {
  it("holds checkout before code verification settles and releases after authentication failure", async () => {
    const h = harness();
    const gate = deferred<{ kind: "verified"; userId: string }>();
    const entered = deferred<void>();
    h.auth.verifyCode.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const verification = h.session.verifyCode("synthetic@example.invalid", "000000");
    await entered.promise;
    expect(await h.session.createCheckout()).toEqual({ kind: "unavailable" });
    expect(h.invoke).not.toHaveBeenCalled();
    h.auth.verifyCode.mockRejectedValueOnce(new Error("auth unavailable"));
    gate.resolve({ kind: "verified", userId: accountA });
    await verification;
    await expect(h.session.verifyCode("synthetic@example.invalid", "000000")).rejects.toThrow("auth unavailable");
    expect(await h.session.createCheckout()).toMatchObject({ kind: "checkout-url", operationId });
  });
  it("holds purchase and recovery throughout identity-switch cleanup", async () => {
    const h = harness({ accountId: accountA, operationId });
    h.stores.checkoutPending.value = { startedAt: 1, tabId: 999 };
    const gate = deferred<void>();
    const entered = deferred<void>();
    h.closeTab.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
    h.replaceSession({ userId: accountB, sessionId: "session-b" });
    const verification = h.session.verifyCode("synthetic@example.invalid", "000000");
    await entered.promise;
    const purchase = await h.session.createCheckout();
    const recovery = await h.session.restore();
    const callsBeforeRelease = h.invoke.mock.calls.length;
    gate.resolve();
    await verification;
    expect(purchase).toEqual({ kind: "unavailable" });
    expect(recovery).toBe("unknown");
    expect(callsBeforeRelease).toBe(0);
    expect(await h.session.createCheckout()).toMatchObject({ kind: "checkout-url", operationId });
    expect(h.operation.value).toEqual({ accountId: accountB, operationId });
  });
  it("a queued purchase retains its original session boundary", async () => {
    const h = harness({ accountId: accountA, operationId });
    const gate = deferred<{ data: { operation_id: string; status: string }; error: null }>();
    const entered = deferred<void>();
    h.invoke.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const recovery = h.session.restore();
    await entered.promise;
    const purchase = h.session.createCheckout();
    await new Promise(resolve => setTimeout(resolve, 0));
    h.replaceSession({ userId: accountA, sessionId: "replacement-session" });
    gate.resolve({ data: { operation_id: operationId, status: "closed_unpaid" }, error: null });
    expect(await recovery).toBe("unknown");
    expect(await purchase).toEqual({ kind: "unavailable" });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.operation.value).toEqual({ accountId: accountA, operationId });
  });
  it("a failed durable write releases the checkout queue for a retry", async () => {
    const h = harness();
    h.operation.set.mockRejectedValueOnce(new Error("disk unavailable"));
    expect(await h.session.createCheckout()).toEqual({ kind: "unavailable" });
    expect(await h.session.createCheckout()).toEqual({ kind: "checkout-url", url, operationId });
    expect(h.operation.value).toEqual({ accountId: accountA, operationId });
  });
  it("already-entitled reconciliation runs after releasing the checkout queue", async () => {
    const h = harness();
    h.invoke.mockResolvedValueOnce({ data: {}, error: new FunctionsHttpError({ status: 409 }) });
    expect(await h.session.createCheckout()).toEqual({ kind: "already-entitled" });
    expect(h.invoke.mock.calls.map(call => call[0])).toEqual([
      "qa-sandbox-create-web-checkout", "qa-sandbox-reconcile-entitlement",
    ]);
    expect(h.records.setRecord).not.toHaveBeenCalled();
  });
  it("concurrent Restore and new checkout cannot let an old completion erase the new operation", async () => {
    const h = harness({ accountId: accountA, operationId });
    const operation2 = "22222222-2222-4222-8222-222222222222";
    const gate = deferred<{ data: { operation_id: string; status: string }; error: null }>();
    const entered = deferred<void>();
    let completions = 0;
    let creations = 0;
    h.invoke.mockImplementation(async name => {
      if (name === "qa-sandbox-complete-web-checkout") {
        completions++;
        entered.resolve();
        return gate.promise;
      }
      if (name === "qa-sandbox-create-web-checkout") {
        creations++;
        return { data: { ...created(), operation_id: operation2 }, error: null };
      }
      return { data: {}, error: null };
    });
    const first = h.session.reconcile();
    await entered.promise;
    const second = h.session.restore();
    const create = h.session.createCheckout();
    await new Promise(resolve => setTimeout(resolve, 0));
    const beforeRelease = { completions, creations };
    gate.resolve({ data: { operation_id: operationId, status: "closed_unpaid" }, error: null });
    await Promise.all([first, second]);
    expect(await create).toMatchObject({ kind: "checkout-url", operationId: operation2 });
    expect(beforeRelease).toEqual({ completions: 1, creations: 0 });
    expect(h.operation.value).toEqual({ accountId: accountA, operationId: operation2 });
  });
  it("a missing fresh sales allowance blocks checkout without blocking completion or Restore", async () => {
    const h = harness({ accountId: accountA, operationId });
    h.canCreateCheckout.mockResolvedValue(false);
    expect(await h.session.createCheckout()).toEqual({ kind: "unavailable" });
    expect(h.invoke).not.toHaveBeenCalled();
    await h.session.restore();
    expect(h.invoke.mock.calls.map(call => call[0])).toEqual(["qa-sandbox-complete-web-checkout", "qa-sandbox-reconcile-entitlement"]);
    expect(h.canCreateCheckout).toHaveBeenCalledTimes(1);
  });
  it("persists the server-issued operation before returning a test payment URL", async () => {
    const h = harness();
    expect(await h.session.createCheckout()).toEqual({ kind: "checkout-url", url, operationId });
    expect(h.operation.value).toEqual({ accountId: accountA, operationId });
    expect(h.records.setRecord).not.toHaveBeenCalled();
  });
  it("storage failure cannot open checkout or fabricate a replacement operation", async () => {
    const h = harness();
    h.operation.set.mockRejectedValue(new Error("disk unavailable"));
    expect(await h.session.createCheckout()).toEqual({ kind: "unavailable" });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.operation.value).toBeNull();
    expect(h.records.setRecord).not.toHaveBeenCalled();
  });
  it("a restarted worker resumes the same operation instead of creating a client identity", async () => {
    const h = harness();
    await h.session.createCheckout();
    const restarted = h.makeSession();
    await restarted.createCheckout();
    expect(h.invoke).toHaveBeenLastCalledWith("qa-sandbox-create-web-checkout", expect.objectContaining({
      body: { access_schema: 1, operation_id: operationId },
    }));
  });
  it("a restarted worker completes the owned operation before scoped reconcile, never granting from the import ACK", async () => {
    const h = harness({ accountId: accountA, operationId });
    expect(await h.makeSession().reconcile()).toBe("unknown");
    expect(h.invoke.mock.calls.map(call => call[0])).toEqual([
      "qa-sandbox-complete-web-checkout", "qa-sandbox-reconcile-entitlement",
    ]);
    expect(h.operation.value).toEqual({ accountId: accountA, operationId });
    expect(h.records.setRecord).not.toHaveBeenCalled();
  });
  it("account B never sends account A's operation to completion or checkout creation", async () => {
    const h = harness({ accountId: accountA, operationId });
    h.replaceSession({ userId: accountB, sessionId: "session-b" });
    await h.session.reconcile();
    expect(h.invoke.mock.calls.map(call => call[0])).toEqual(["qa-sandbox-reconcile-entitlement"]);
    await h.session.createCheckout();
    expect(h.invoke).toHaveBeenLastCalledWith("qa-sandbox-create-web-checkout", expect.objectContaining({ body: { access_schema: 1 } }));
    expect(h.operation.value).toEqual({ accountId: accountB, operationId });
  });
  it("same-account sign-out/sign-in while creation waits cannot persist or open the old response", async () => {
    const h = harness();
    const gate = deferred<{ data: ReturnType<typeof created>; error: null }>();
    const entered = deferred<void>();
    h.invoke.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const pending = h.session.createCheckout();
    await entered.promise;
    h.replaceSession({ userId: accountA, sessionId: "replacement-session" });
    gate.resolve({ data: created(), error: null });
    expect(await pending).toEqual({ kind: "unavailable" });
    expect(h.operation.value).toBeNull();
  });
  it("a session replacement while the durable write waits still prevents opening the old URL", async () => {
    const h = harness();
    const gate = deferred<void>();
    const entered = deferred<void>();
    h.operation.set.mockImplementationOnce(async value => { entered.resolve(); await gate.promise; h.operation.value = value; });
    const pending = h.session.createCheckout();
    await entered.promise;
    h.replaceSession({ userId: accountB, sessionId: "session-b" });
    gate.resolve();
    expect(await pending).toEqual({ kind: "unavailable" });
    expect(h.records.setRecord).not.toHaveBeenCalled();
  });
  it("completion uncertainty preserves the operation and never falls back to another route", async () => {
    for (const status of [401, 502]) {
      const h = harness({ accountId: accountA, operationId });
      h.invoke.mockResolvedValueOnce({ data: {}, error: new FunctionsHttpError({ status }) });
      expect(await h.session.reconcile()).toBe(status === 401 ? "auth-required" : "unknown");
      expect(h.invoke).toHaveBeenCalledTimes(1);
      expect(h.operation.value).toEqual({ accountId: accountA, operationId });
      expect(h.records.setRecord).not.toHaveBeenCalled();
    }
  });
  it("same-account session replacement during completion cannot consume its acknowledgement", async () => {
    const h = harness({ accountId: accountA, operationId });
    const gate = deferred<{ data: { operation_id: string; status: string }; error: null }>();
    const entered = deferred<void>();
    h.invoke.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const pending = h.session.reconcile();
    await entered.promise;
    h.replaceSession({ userId: accountA, sessionId: "replacement-session" });
    gate.resolve({ data: { operation_id: operationId, status: "access_observed" }, error: null });
    expect(await pending).toBe("unknown");
    expect(h.operation.value).toEqual({ accountId: accountA, operationId });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.records.setRecord).not.toHaveBeenCalled();
  });
  it("terminal refund clears recovery only after the matching authenticated completion", async () => {
    const h = harness({ accountId: accountA, operationId });
    h.invoke.mockResolvedValueOnce({ data: { operation_id: operationId, status: "refunded" }, error: null });
    await h.session.reconcile();
    expect(h.operation.value).toBeNull();
    expect(h.records.setRecord).not.toHaveBeenCalled();
  });
  it("voluntary sign-out purges the operation with the other account-owned state", async () => {
    const h = harness({ accountId: accountA, operationId });
    await h.session.signOut();
    expect(h.operation.value).toBeNull();
  });
  it("corrupt stored identities are never submitted as server operation IDs", async () => {
    for (const initial of ["bad", { accountId: accountA, operationId: "bad" }, { accountId: accountA, operationId, redirect: "live" }]) {
      const h = harness(initial);
      await h.session.createCheckout();
      expect(h.invoke).toHaveBeenLastCalledWith("qa-sandbox-create-web-checkout", expect.objectContaining({ body: { access_schema: 1 } }));
    }
  });
});
