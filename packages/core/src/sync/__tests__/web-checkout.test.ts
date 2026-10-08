import { describe, it, expect, vi } from "vitest";
import { FunctionsFetchError, FunctionsHttpError } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseBackendPort } from "../profile.js";

// SupabaseBackendPort.createWebCheckout (plan U4/R3/R5): the create-web-checkout Edge Function
// maps to a structured outcome by HTTP status ONLY — 200 → checkout-url, 409 → already-entitled,
// 401 → auth-required, everything else → unavailable. `functions.invoke` buries the status inside
// FunctionsHttpError.context (the raw Response), so these tests drive exactly that seam and pin
// that no branch ever matches error text (docs/solutions: structured-outcome-over-string).

function portWith(result: { data?: unknown; error?: unknown }) {
  const invoke = vi.fn(() =>
    Promise.resolve({ data: result.data ?? null, error: result.error ?? null }),
  );
  const client = { functions: { invoke } } as unknown as SupabaseClient;
  return { port: new SupabaseBackendPort(client), invoke };
}

describe("SupabaseBackendPort.createWebCheckout (plan U4)", () => {
  it("200 with an https checkout_url → checkout-url, with a client-side timeout signal (F5)", async () => {
    const url = "https://pay.rev.cat/token/user-uuid";
    const { port, invoke } = portWith({ data: { checkout_url: url } });
    await expect(port.createWebCheckout()).resolves.toEqual({ kind: "checkout-url", url });
    // The invoke carries a body AND an AbortSignal deadline so a hung fetch can't strand the popup.
    expect(invoke).toHaveBeenCalledWith(
      "create-web-checkout",
      expect.objectContaining({ body: {}, signal: expect.any(AbortSignal) }),
    );
  });

  it("a 200 with a non-https checkout_url → unavailable (scheme gate before opening a tab, F3)", async () => {
    for (const url of ["http://pay.rev.cat/t/u", "javascript:alert(1)", "not a url"]) {
      const { port } = portWith({ data: { checkout_url: url } });
      await expect(port.createWebCheckout()).resolves.toEqual({ kind: "unavailable" });
    }
  });

  it("409 → already-entitled (the cross-device restore case, R5/AE4)", async () => {
    const { port } = portWith({ error: new FunctionsHttpError({ status: 409 }) });
    await expect(port.createWebCheckout()).resolves.toEqual({ kind: "already-entitled" });
  });

  it("401 → auth-required (session death is re-sign-in, never teardown)", async () => {
    const { port } = portWith({ error: new FunctionsHttpError({ status: 401 }) });
    await expect(port.createWebCheckout()).resolves.toEqual({ kind: "auth-required" });
  });

  it("502 → unavailable (checkout not configured / RC down — calm retry)", async () => {
    const { port } = portWith({ error: new FunctionsHttpError({ status: 502 }) });
    await expect(port.createWebCheckout()).resolves.toEqual({ kind: "unavailable" });
  });

  it("a network failure (FunctionsFetchError, no status at all) → unavailable", async () => {
    const { port } = portWith({ error: new FunctionsFetchError(new TypeError("fetch failed")) });
    await expect(port.createWebCheckout()).resolves.toEqual({ kind: "unavailable" });
  });

  it("reads the status from a real Response context too (what invoke actually attaches)", async () => {
    const { port } = portWith({
      error: new FunctionsHttpError(new Response('{"error":"already_entitled"}', { status: 409 })),
    });
    await expect(port.createWebCheckout()).resolves.toEqual({ kind: "already-entitled" });
  });

  it("a 200 without a usable URL is unavailable — never opens a garbage tab", async () => {
    for (const data of [null, {}, { checkout_url: "" }, { checkout_url: 42 }]) {
      const { port } = portWith({ data });
      await expect(port.createWebCheckout()).resolves.toEqual({ kind: "unavailable" });
    }
  });

  it("mapping is mechanical: '409'/'already_entitled' in error TEXT never maps to a status branch", async () => {
    // A non-HTTP error whose message happens to contain the magic words must stay unavailable —
    // the repo rule is status-mapped outcomes, never string-matched errors (plan KTD).
    const { port } = portWith({ error: new Error("409 already_entitled unauthorized 401") });
    await expect(port.createWebCheckout()).resolves.toEqual({ kind: "unavailable" });
  });

  it("a FunctionsHttpError with a garbage context (no numeric status) → unavailable", async () => {
    const { port } = portWith({ error: new FunctionsHttpError({ status: "teapot" }) });
    await expect(port.createWebCheckout()).resolves.toEqual({ kind: "unavailable" });
  });
});

describe("fixed QA checkout transport", () => {
  it("cannot access legacy settings tables, RPCs or realtime in the QA profile", async () => {
    const from = vi.fn(() => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }));
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const channel = vi.fn(() => ({ on: () => ({ subscribe: () => ({ unsubscribe: async () => {} }) }) }));
    const client = { from, rpc, channel } as unknown as SupabaseClient;
    for (const modernSettings of [false, true]) {
      const port = new SupabaseBackendPort(client, { routeProfile: "shared-hosted-sandbox", modernSettings });
      await expect(port.readProfile()).rejects.toThrow("rollout-held");
      await expect(port.writeProfile(null as unknown as Parameters<typeof port.writeProfile>[0], "synthetic"))
        .rejects.toThrow("rollout-held");
      port.subscribeToProfile("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", () => {})();
    }
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(channel).not.toHaveBeenCalled();
  });
  const operationId = "11111111-1111-4111-8111-111111111111";
  const url = "https://checkout.stripe.com/c/pay/cs_test_synthetic#fragment";
  const success = () => ({ operation_id: operationId, status: "session_bound", checkout_url: url });
  function qa(result: { data?: unknown; error?: unknown }) {
    const invoke = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
    const client = { functions: { invoke }, from: vi.fn() } as unknown as SupabaseClient;
    return { port: new SupabaseBackendPort(client, { routeProfile: "shared-hosted-sandbox", modernSettings: true }), invoke, client };
  }
  it("uses only the QA create schema and retains the server operation before opening a test URL", async () => {
    const { port, invoke } = qa({ data: success() });
    expect(await port.createWebCheckout()).toEqual({ kind: "checkout-url", url, operationId });
    expect(invoke).toHaveBeenCalledWith("qa-sandbox-create-web-checkout",
      expect.objectContaining({ body: { access_schema: 1 }, signal: expect.any(AbortSignal) }));
    await port.createWebCheckout(operationId);
    expect(invoke).toHaveBeenLastCalledWith("qa-sandbox-create-web-checkout",
      expect.objectContaining({ body: { access_schema: 1, operation_id: operationId } }));
  });
  it("holds live/provider lookalike URLs, malformed identities and unknown response shapes", async () => {
    for (const data of [
      { ...success(), checkout_url: "https://pay.rev.cat/live" },
      { ...success(), checkout_url: "https://checkout.stripe.com/c/pay/cs_live_real" },
      { ...success(), checkout_url: "https://checkout.stripe.com.evil.test/c/pay/cs_test_fake" },
      { ...success(), checkout_url: `${url}?destination=live` },
      { ...success(), checkout_url: "http://checkout.stripe.com/c/pay/cs_test_fake" },
      { ...success(), status: "refunded" }, { ...success(), operation_id: "not-an-operation" },
      { ...success(), entitled: true }, { ...success(), status: "unknown" }, null,
    ]) expect(await qa({ data }).port.createWebCheckout()).toEqual({ kind: "unavailable" });
    const { port, invoke } = qa({ data: success() });
    expect(await port.createWebCheckout("bad-id")).toEqual({ kind: "unavailable" });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("holds a mismatched resumed operation and never falls back after a QA error", async () => {
    expect(await qa({ data: success() }).port.createWebCheckout("22222222-2222-4222-8222-222222222222"))
      .toEqual({ kind: "unavailable" });
    const { port, invoke } = qa({ error: new FunctionsHttpError({ status: 404 }) });
    expect(await port.createWebCheckout()).toEqual({ kind: "unavailable" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe("qa-sandbox-create-web-checkout");
  });
  it("retains recovery identity without treating a paid/imported status or access text as a grant", async () => {
    for (const status of ["recovery_required", "paid_verified", "import_pending", "imported", "access_observed"]) {
      const { port } = qa({ data: { operation_id: operationId, status, access: { still_sync: true } } });
      expect(await port.createWebCheckout()).toEqual({ kind: "unavailable", operationId });
      expect(await port.readEntitlement()).toBe("unknown");
    }
  });
  it("completes only the matching server operation through the QA endpoint", async () => {
    const { port, invoke } = qa({ data: { operation_id: operationId, status: "import_pending" } });
    expect(await port.completeWebCheckout(operationId)).toEqual({ kind: "observed", operationId, terminal: false });
    expect(invoke).toHaveBeenCalledWith("qa-sandbox-complete-web-checkout",
      expect.objectContaining({ body: { access_schema: 1, operation_id: operationId }, signal: expect.any(AbortSignal) }));
    for (const status of ["access_observed", "refunded", "closed_unpaid"]) {
      invoke.mockResolvedValue({ data: { operation_id: operationId, status }, error: null });
      expect(await port.completeWebCheckout(operationId)).toEqual({ kind: "observed", operationId, terminal: true });
    }
    invoke.mockResolvedValue({ data: { ...success(), operation_id: "22222222-2222-4222-8222-222222222222" }, error: null });
    expect(await port.completeWebCheckout(operationId)).toEqual({ kind: "unavailable" });
  });
  it("completion failure retains uncertainty and production has no QA completion capability", async () => {
    for (const status of [401, 403, 404, 502]) {
      const { port, invoke } = qa({ error: new FunctionsHttpError({ status }) });
      expect(await port.completeWebCheckout(operationId)).toEqual({ kind: status === 401 ? "auth-required" : "unavailable" });
      expect(invoke).toHaveBeenCalledTimes(1);
    }
    const { port, invoke } = portWith({ data: success() });
    expect(await port.completeWebCheckout(operationId)).toEqual({ kind: "unavailable" });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("routes QA reconcile and settings through the same namespace without reading live entitlements", async () => {
    const { port, invoke, client } = qa({ data: null });
    await port.reconcileEntitlement();
    expect(invoke).toHaveBeenLastCalledWith("qa-sandbox-reconcile-entitlement", expect.objectContaining({ body: { access_schema: 1 } }));
    await expect(port.readCanonicalSettings()).rejects.toThrow();
    expect(invoke).toHaveBeenLastCalledWith("qa-sandbox-sync-settings", expect.objectContaining({ body: { protocol: 2, action: "read" } }));
    expect(await port.readEntitlement()).toBe("unknown");
    expect(client.from).not.toHaveBeenCalled();
  });
});
