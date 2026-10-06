import { beforeEach, describe, expect, it, vi } from "vitest";

// A stub Supabase client: records how the owner page creates it and what it asks of auth.
const auth = {
  signInWithOtp: vi.fn(async (_args: unknown) => ({ error: null as null | { code?: string } })),
  verifyOtp: vi.fn(async (_args: unknown) => ({ data: { session: { access_token: "t" } as unknown }, error: null as null | { code?: string } })),
  getSession: vi.fn(async () => ({ data: { session: { access_token: "session-jwt" } as { access_token: string } | null } })),
  signOut: vi.fn(async (_args: unknown) => ({ error: null })),
};
const createClient = vi.fn((_url: string, _key: string, _options: unknown) => ({ auth }));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

const { supabaseOwnerAuth } = await import("./auth.js");

describe("supabaseOwnerAuth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the session in memory only and never reads a session from the URL", () => {
    supabaseOwnerAuth("https://project.supabase.co", "anon-key");
    expect(createClient).toHaveBeenCalledTimes(1);
    const [url, key, options] = createClient.mock.calls[0]!;
    expect(url).toBe("https://project.supabase.co");
    expect(key).toBe("anon-key");
    expect(options).toMatchObject({ auth: { persistSession: false, detectSessionInUrl: false } });
  });

  it("asks for a code without ever creating an account", async () => {
    const owner = supabaseOwnerAuth("https://project.supabase.co", "anon-key");
    expect(await owner.requestCode("person@example.com")).toBe("sent");
    expect(auth.signInWithOtp).toHaveBeenCalledWith({ email: "person@example.com", options: { shouldCreateUser: false } });
    auth.signInWithOtp.mockResolvedValueOnce({ error: { code: "otp_disabled" } });
    expect(await owner.requestCode("person@example.com")).toBe("failed");
  });

  it("verifies an email code and maps GoTrue's wrong-or-expired error", async () => {
    const owner = supabaseOwnerAuth("https://project.supabase.co", "anon-key");
    expect(await owner.verifyCode("person@example.com", "123456")).toBe("verified");
    expect(auth.verifyOtp).toHaveBeenCalledWith({ email: "person@example.com", token: "123456", type: "email" });
    auth.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error: { code: "otp_expired" } });
    expect(await owner.verifyCode("person@example.com", "000000")).toBe("wrong-code");
    auth.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error: { code: "over_request_rate_limit" } });
    expect(await owner.verifyCode("person@example.com", "000000")).toBe("failed");
  });

  it("hands out the session token and signs out of this tab only", async () => {
    const owner = supabaseOwnerAuth("https://project.supabase.co", "anon-key");
    expect(await owner.accessToken()).toBe("session-jwt");
    auth.getSession.mockResolvedValueOnce({ data: { session: null } });
    expect(await owner.accessToken()).toBeNull();
    await owner.signOut();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
