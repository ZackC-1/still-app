import { describe, it, expect, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { SupabaseAuthPort, preserveAuthErrorCodes } from "../auth.js";

// ISS-0060 root cause, reproduced with the real supabase-js client: GoTrue answers a 2024-01-01
// request with `{code, message}` only. supabase-js reads that `code` only when it can read the
// `X-Supabase-Api-Version` RESPONSE header; a cross-origin reader (the Apple app's file://
// WKWebView) sees only CORS-exposed headers, so the code vanishes and the refusal used to render
// as the generic failure. The stub below returns exactly what such a reader can see.

const URL_BASE = "https://project.invalid";
const frequencyBody = {
  code: "over_email_send_rate_limit",
  message: "For security purposes, you can only request this after 23 seconds.",
};

/** A fetch whose responses carry no readable API-version header (the cross-origin view). */
function crossOriginFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

function client(fetchImpl: typeof fetch) {
  return createClient(URL_BASE, "public-anon-placeholder", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl },
  });
}

describe("Auth error codes across a cross-origin read (ISS-0060)", () => {
  it("without the version header supabase-js loses the code (the defect's mechanism)", async () => {
    const { error } = await client(crossOriginFetch(429, frequencyBody)).auth.signInWithOtp({ email: "a@b.c" });
    expect(error?.status).toBe(429);
    expect(error?.code).toBeUndefined();
  });

  it("preserveAuthErrorCodes keeps the code readable, so every Auth outcome classifies correctly", async () => {
    const sent = client(preserveAuthErrorCodes(crossOriginFetch(429, frequencyBody)));
    const { error } = await sent.auth.signInWithOtp({ email: "a@b.c" });
    expect(error?.code).toBe("over_email_send_rate_limit");
    expect(await new SupabaseAuthPort(sent).requestCode("a@b.c")).toEqual({
      kind: "send-rate-limited",
      retryAfterSeconds: 24,
    });

    // A wrong code is the same mechanism: without the code it would read as "couldn't sign you in".
    const wrong = client(
      preserveAuthErrorCodes(crossOriginFetch(403, { code: "otp_expired", message: "Token has expired or is invalid" })),
    );
    expect(await new SupabaseAuthPort(wrong).verifyCode("a@b.c", "000000")).toEqual({ kind: "invalid-code" });
  });

  it("a genuine provider failure keeps the generic outcome", async () => {
    const failing = client(
      preserveAuthErrorCodes(crossOriginFetch(400, { code: "validation_failed", message: "bad" })),
    );
    expect(await new SupabaseAuthPort(failing).requestCode("a@b.c")).toEqual({ kind: "send-failed" });
  });

  it("passes successes, non-Auth routes, non-JSON and already-coded bodies through untouched", async () => {
    const ok = new Response("{}", { status: 200 });
    expect(await preserveAuthErrorCodes(vi.fn(async () => ok))(`${URL_BASE}/auth/v1/otp`)).toBe(ok);

    const fn = new Response(JSON.stringify({ code: "x" }), { status: 429 });
    expect(await preserveAuthErrorCodes(vi.fn(async () => fn))(`${URL_BASE}/functions/v1/sync`)).toBe(fn);

    const html = new Response("<html>gateway</html>", { status: 502 });
    expect(await preserveAuthErrorCodes(vi.fn(async () => html))(`${URL_BASE}/auth/v1/otp`)).toBe(html);

    const legacy = new Response(JSON.stringify({ code: 429, error_code: "over_email_send_rate_limit" }), { status: 429 });
    expect(await preserveAuthErrorCodes(vi.fn(async () => legacy))(`${URL_BASE}/auth/v1/otp`)).toBe(legacy);
  });

  it("keeps status, headers and every original field on a rewritten body", async () => {
    const res = await preserveAuthErrorCodes(
      vi.fn(async () =>
        new Response(JSON.stringify(frequencyBody), { status: 429, headers: { "x-request-id": "r1" } }),
      ),
    )(new URL(`${URL_BASE}/auth/v1/otp`));
    expect(res.status).toBe(429);
    expect(res.headers.get("x-request-id")).toBe("r1");
    expect(await res.json()).toEqual({ ...frequencyBody, error_code: "over_email_send_rate_limit" });
  });
});
