import { describe, expect, it, vi } from "vitest";
import type { ExtensionSession } from "@still/core/sync";
import {
  createAccountEmailWatch,
  dataKindForRequest,
  guardFirefoxDataFetch,
  withAccountEmailWatch,
} from "../firefox-data-guard.js";
import type { DataPermissionKind } from "@still/core/ui/data-permission";

// The Firefox background's guard: whatever path asks, a request carrying the email address or the
// Still Pro purchase status leaves only while Firefox lists that permission as granted.

const SUPABASE = "https://project.supabase.co";

describe("which requests carry what", () => {
  it.each([
    ["/auth/v1/otp", "email"],
    ["/auth/v1/otp?redirect_to=x", "email"],
    ["/auth/v1/verify", "email"],
    ["/functions/v1/review-signin", "email"],
    ["/functions/v1/reconcile-entitlement", "purchase"],
    ["/functions/v1/create-web-checkout", "purchase"],
    ["/functions/v1/complete-web-checkout", "purchase"],
    ["/functions/v1/qa-sandbox-reconcile-entitlement", "purchase"],
    ["/functions/v1/qa-sandbox-create-web-checkout", "purchase"],
    ["/functions/v1/analytics-purchase", "purchase"],
    ["/rest/v1/entitlements?select=still_sync", "purchase"],
  ] as const)("%s needs %s", (path, kind) => {
    expect(dataKindForRequest(`${SUPABASE}${path}`, SUPABASE)).toBe(kind);
  });

  it.each([
    "/auth/v1/token?grant_type=refresh_token",
    "/auth/v1/user",
    "/auth/v1/logout",
    "/functions/v1/sync-settings",
    "/functions/v1/product-policy",
    "/functions/v1/delete-user",
    "/rest/v1/profiles",
    "/rest/v1/rpc/write_settings",
  ])("%s carries neither (settings sync and the session itself)", (path) => {
    expect(dataKindForRequest(`${SUPABASE}${path}`, SUPABASE)).toBeNull();
  });

  it("other origins are not Still's backend", () => {
    expect(dataKindForRequest("https://elsewhere.example/auth/v1/otp", SUPABASE)).toBeNull();
    expect(dataKindForRequest("not a url", SUPABASE)).toBeNull();
  });
});

describe("guardFirefoxDataFetch", () => {
  function setup(grants: Partial<Record<DataPermissionKind, boolean>>) {
    const base = vi.fn(async () => new Response("{}"));
    const granted = vi.fn(async (kind: DataPermissionKind) => grants[kind] === true);
    const guarded = guardFirefoxDataFetch(base as unknown as typeof fetch, { supabaseUrl: SUPABASE, granted });
    return { base, granted, guarded, grants };
  }

  it("without the email permission, the code send never leaves (a network-style failure)", async () => {
    const h = setup({});
    await expect(h.guarded(`${SUPABASE}/auth/v1/otp`, { method: "POST", body: '{"email":"me@example.com"}' })).rejects.toBeInstanceOf(TypeError);
    expect(h.base).not.toHaveBeenCalled();
  });

  it("without the purchase permission, no purchase status is read or recorded", async () => {
    const h = setup({ email: true });
    await expect(h.guarded(new Request(`${SUPABASE}/functions/v1/reconcile-entitlement`))).rejects.toBeInstanceOf(TypeError);
    await expect(h.guarded(new URL(`${SUPABASE}/rest/v1/entitlements`))).rejects.toBeInstanceOf(TypeError);
    expect(h.base).not.toHaveBeenCalled();
  });

  it("with the permission, the request goes out unchanged", async () => {
    const h = setup({ email: true, purchase: true });
    const init = { method: "POST" };
    await h.guarded(`${SUPABASE}/auth/v1/otp`, init);
    await h.guarded(`${SUPABASE}/functions/v1/create-web-checkout`, init);
    expect(h.base).toHaveBeenCalledTimes(2);
    expect(h.base).toHaveBeenCalledWith(`${SUPABASE}/auth/v1/otp`, init);
  });

  it("reads the grant again for every request: a withdrawal stops the next one", async () => {
    const h = setup({ purchase: true });
    await h.guarded(`${SUPABASE}/functions/v1/reconcile-entitlement`);
    h.grants.purchase = false;
    await expect(h.guarded(`${SUPABASE}/functions/v1/reconcile-entitlement`)).rejects.toBeInstanceOf(TypeError);
    expect(h.granted).toHaveBeenCalledTimes(2);
  });

  it("settings sync and token refresh never wait on a permission", async () => {
    const h = setup({});
    await h.guarded(`${SUPABASE}/functions/v1/sync-settings`);
    await h.guarded(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`);
    expect(h.granted).not.toHaveBeenCalled();
    expect(h.base).toHaveBeenCalledTimes(2);
  });
});

describe("a withdrawn email permission", () => {
  function setup(options: { userId: string | null; recorded: string | null; granted: boolean }) {
    const values: { account: string | null; withdrawn: true | null } = { account: options.recorded, withdrawn: null };
    const signOut = vi.fn(async () => "signed-out");
    let granted = options.granted;
    const watch = createAccountEmailWatch({
      granted: async () => granted,
      currentUserId: async () => options.userId,
      signedInWithGrant: { get: async () => values.account, set: async (v) => void (values.account = v) },
      withdrawn: { get: async () => values.withdrawn, set: async (v) => void (values.withdrawn = v) },
      signOut,
    });
    return { watch, signOut, values, grant: (next: boolean) => void (granted = next) };
  }

  it("signs an account that signed in with it out of sync, and flags the line for the pages", async () => {
    const h = setup({ userId: "u1", recorded: "u1", granted: false });
    expect(await h.watch.check()).toBe("signed-out");
    expect(h.signOut).toHaveBeenCalledOnce();
    expect(h.values).toEqual({ account: null, withdrawn: true });
  });

  it("keeps an account whose permission is still granted", async () => {
    const h = setup({ userId: "u1", recorded: "u1", granted: true });
    expect(await h.watch.check()).toBe("kept");
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it("leaves an account that signed in before the permission existed as it was", async () => {
    const h = setup({ userId: "u1", recorded: null, granted: false });
    expect(await h.watch.check()).toBe("kept");
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it("does nothing while signed out", async () => {
    const h = setup({ userId: null, recorded: "u1", granted: false });
    expect(await h.watch.check()).toBe("kept");
  });

  it("checks once at a time", async () => {
    const h = setup({ userId: "u1", recorded: "u1", granted: false });
    await Promise.all([h.watch.check(), h.watch.check()]);
    expect(h.signOut).toHaveBeenCalledOnce();
  });

  it("a new sign-in records the account and clears the line", async () => {
    const h = setup({ userId: "u1", recorded: null, granted: true });
    h.values.withdrawn = true;
    await h.watch.signedIn("u1");
    expect(h.values).toEqual({ account: "u1", withdrawn: null });
  });
});

describe("the watched session", () => {
  function session(): ExtensionSession & { calls: string[] } {
    const calls: string[] = [];
    const s = {
      calls,
      getState: vi.fn(async () => (calls.push("getState"), { userId: "u1", entitled: false, checkoutPending: null, pendingOtp: null })),
      getSyncStatus: vi.fn(async () => (calls.push("getSyncStatus"), null)),
      resume: vi.fn(async () => (calls.push("resume"), "resumed-free" as const)),
      verifyCode: vi.fn(async () => ({ kind: "verified", userId: "u1" }) as const),
      onNudge: vi.fn(async () => "no-op" as const),
    };
    return s as unknown as ExtensionSession & { calls: string[] };
  }

  it("checks before the account reads and the start-up resume; records a verified sign-in", async () => {
    const inner = session();
    const order: string[] = inner.calls;
    const watch = {
      check: vi.fn(async () => (order.push("check"), "kept" as const)),
      signedIn: vi.fn(async () => {}),
    };
    const wrapped = withAccountEmailWatch(inner, watch);
    await wrapped.resume();
    await wrapped.getState();
    await wrapped.getSyncStatus();
    expect(order).toEqual(["check", "resume", "check", "getState", "check", "getSyncStatus"]);
    await wrapped.verifyCode("me@example.com", "123456");
    expect(watch.signedIn).toHaveBeenCalledWith("u1");
    // The content-script nudge is untouched: no permission read on that path.
    await wrapped.onNudge();
    expect(watch.check).toHaveBeenCalledTimes(3);
  });
});
