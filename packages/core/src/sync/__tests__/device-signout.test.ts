import { describe, expect, it } from "vitest";
import { createClient, type Session } from "@supabase/supabase-js";
import { SupabaseAuthPort } from "../auth.js";

// Exercise the real SDK logout/refresh requests against a synthetic auth server.
// A global logout revokes the peer's refresh token; its current access token can
// keep working until expiry, making the broken sync appear later on that device.
function devices() {
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    aud: "authenticated",
    role: "authenticated",
    email: "synthetic@example.test",
    app_metadata: {}, user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  };
  const active = new Set(["chrome", "mac"]);
  const scopes: string[] = [];
  const sessions = new Map<string, Session>();
  for (const device of active) {
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    sessions.set(device, {
      access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, exp, session_id: device })}.synthetic`,
      refresh_token: `synthetic-refresh-${device}`,
      token_type: "bearer", expires_in: 3_600, expires_at: exp, user,
    });
  }
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/auth/v1/logout") {
      const scope = url.searchParams.get("scope") ?? "global";
      scopes.push(scope);
      const authorization = new Headers(init?.headers).get("authorization");
      const device = [...sessions].find(([, session]) =>
        authorization === `Bearer ${session.access_token}`)?.[0];
      if (!device) throw new Error("Unknown synthetic session");
      if (scope === "global") active.clear();
      else if (scope === "local") active.delete(device);
      else throw new Error("Unexpected logout scope");
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      const device = [...sessions].find(([, session]) =>
        session.refresh_token === body.refresh_token)?.[0];
      return device && active.has(device)
        ? Response.json(sessions.get(device))
        : Response.json({ error_code: "refresh_token_not_found", msg: "Synthetic session revoked" }, { status: 400 });
    }
    throw new Error(`Unexpected synthetic auth route: ${url.pathname}`);
  };
  const client = (device: string) => {
    const key = `synthetic-auth-${device}-${crypto.randomUUID()}`;
    const storage = new Map([[key, JSON.stringify(sessions.get(device))]]);
    return createClient("https://synthetic.invalid", "synthetic-anon-key", {
      global: { fetch: fetcher },
      auth: {
        storageKey: key, persistSession: true, autoRefreshToken: false,
        detectSessionInUrl: false,
        storage: {
          getItem: (name) => storage.get(name) ?? null,
          setItem: (name, value) => { storage.set(name, value); },
          removeItem: (name) => { storage.delete(name); },
        },
      },
    });
  };
  return { chrome: client("chrome"), mac: client("mac"), scopes };
}

describe("sign-out across devices", () => {
  it("keeps the Mac session renewable after signing out of Still in Chrome", async () => {
    const { chrome, mac, scopes } = devices();
    expect((await mac.auth.refreshSession()).error).toBeNull();
    await new SupabaseAuthPort(chrome).signOut();
    expect((await chrome.auth.getSession()).data.session).toBeNull();
    const renewed = await mac.auth.refreshSession();
    expect(renewed.error).toBeNull();
    expect(renewed.data.session?.user.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(scopes).toEqual(["local"]);
  });

  it("detects the delayed peer-session failure caused by global logout", async () => {
    const { chrome, mac } = devices();
    expect((await mac.auth.refreshSession()).error).toBeNull();
    await chrome.auth.signOut({ scope: "global" });
    expect((await mac.auth.getSession()).data.session).not.toBeNull();
    expect((await mac.auth.refreshSession()).error?.code).toBe("refresh_token_not_found");
  });
});
