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
