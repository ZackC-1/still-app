import { describe, expect, it, vi } from "vitest";
import { AdminClient, httpTransport } from "./admin-client.js";

describe("httpTransport", () => {
  it("sends the user's own session JWT and the anon key, nothing else, uncached", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const send = httpTransport({
      functionUrl: "https://project.supabase.co/functions/v1/product-policy-admin",
      anonKey: "anon-key",
      accessToken: async () => "session-jwt",
      fetch,
    });
    expect(await send({ action: "read", namespace: "rating", environment: "sandbox" })).toEqual({ status: 200, body: { ok: true } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://project.supabase.co/functions/v1/product-policy-admin");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(init.headers).toEqual({ authorization: "Bearer session-jwt", apikey: "anon-key", "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ action: "read", namespace: "rating", environment: "sandbox" });
  });

  it("makes no request without a session", async () => {
    const fetch = vi.fn();
    const send = httpTransport({ functionUrl: "https://x.supabase.co/f", anonKey: "k", accessToken: async () => null, fetch });
    expect(await send({ action: "read" })).toEqual({ status: 401, body: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a network failure is status 0", async () => {
    const send = httpTransport({
      functionUrl: "https://x.supabase.co/f",
      anonKey: "k",
      accessToken: async () => "t",
      fetch: async () => { throw new TypeError("offline"); },
    });
    expect(await send({})).toEqual({ status: 0, body: null });
  });
});

describe("AdminClient response checks", () => {
  const client = (status: number, body: unknown) => new AdminClient(async () => ({ status, body }));
  const preview = {
    operationId: "6f1c2b8e-3f4a-4b5c-8d9e-0a1b2c3d4e5f",
    previewHash: "a".repeat(64),
    expectedRevision: 0,
    revision: 1,
    body: "{}",
  };

  it("treats a malformed or mismatched success as an error, never success", async () => {
    expect((await client(200, { status: "current", revision: 1, body: null, operationId: null, cutoff: false }).read("rating", "sandbox")).kind).toBe("error");
    expect((await client(200, { status: "applied", verified: false, ...preview }).apply("rating", "sandbox", preview)).kind).toBe("error");
    expect((await client(200, { status: "applied", verified: true, ...preview, revision: 2 }).apply("rating", "sandbox", preview)).kind).toBe("error");
    expect((await client(200, { status: "previewed", ...preview, previewHash: "nope" }).preview("rating", "sandbox", 0, {})).kind).toBe("error");
  });

  it("maps access and refusals", async () => {
    expect((await client(403, { error: "forbidden" }).read("rating", "sandbox")).kind).toBe("forbidden");
    expect((await client(401, { error: "unauthorized" }).read("rating", "sandbox")).kind).toBe("unauthorized");
    expect(await client(409, { status: "cutoff_required" }).apply("sales", "sandbox", preview)).toEqual({ kind: "refused", reason: "cutoff_required" });
    expect(await client(404, { status: "unknown_preview" }).apply("sales", "sandbox", preview)).toEqual({ kind: "refused", reason: "unknown_preview" });
    expect((await client(202, { status: "checking" }).apply("rating", "sandbox", preview)).kind).toBe("checking");
    expect((await client(500, { error: "internal" }).apply("rating", "sandbox", preview)).kind).toBe("error");
  });
});
