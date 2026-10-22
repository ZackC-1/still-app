import { describe, expect, it, vi } from "vitest";
import type { ExtensionSession } from "@still/core/sync";
import {
  createAccountEmailWatch,
  dataKindForRequest,
  gateAccountAnalytics,
  guardFirefoxDataFetch,
  requireEmailGrant,
  watchFirefoxAccountEmail,
  withAccountEmailWatch,
} from "../firefox-data-guard.js";
import { EMAIL_GRANT_ACCOUNT_KEY, EMAIL_PERMISSION_WITHDRAWN_KEY } from "../data-permission.js";
import type { DataPermissionKind } from "@still/core/ui/data-permission";

// The Firefox background's guard: whatever path asks, a request that sends the email address as
// personal data (a code request, or attaching it to analytics) or sends purchase data (starting a
// checkout, purchase analytics, an Apple receipt) leaves only while Firefox lists that permission as
// granted. Requests that only receive the account's Still Pro status send no purchase data and are
// never held back, so Still Pro cannot lock for want of a grant.

const SUPABASE = "https://project.supabase.co";

describe("which requests carry what", () => {
  it.each([
    ["/auth/v1/otp", "email"],
    ["/auth/v1/otp?redirect_to=x", "email"],
    ["/auth/v1/verify", "email"],
    ["/functions/v1/review-signin", "email"],
    // The server attaches the account's email to the analytics person or subject.
    ["/functions/v1/analytics-identify", "email"],
    ["/functions/v1/create-web-checkout", "purchase"],
    ["/functions/v1/qa-sandbox-create-web-checkout", "purchase"],
    // Sends the checkout's operation id, a transaction reference.
    ["/functions/v1/complete-web-checkout", "purchase"],
    ["/functions/v1/qa-sandbox-complete-web-checkout", "purchase"],
    ["/functions/v1/analytics-purchase", "purchase"],
    ["/functions/v1/verify-apple-access", "purchase"],
    ["/functions/v1/link-apple-access", "purchase"],
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
    // Receiving the account's Still Pro status sends no purchase data: never held back.
    "/functions/v1/reconcile-entitlement",
    "/functions/v1/qa-sandbox-reconcile-entitlement",
    "/rest/v1/entitlements?select=still_sync",
  ])("%s sends neither (settings sync, the session, Still Pro status reads)", (path) => {
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

  it("without the email permission, analytics-identify never leaves, in either body shape", async () => {
    const h = setup({ purchase: true });
    // The account-level identify (body {}) and the per-device subject request.
    for (const body of ["{}", '{"originProof":"proof","projectKeySha256":"digest"}'])
      await expect(h.guarded(`${SUPABASE}/functions/v1/analytics-identify`, { method: "POST", body })).rejects.toBeInstanceOf(TypeError);
    expect(h.base).not.toHaveBeenCalled();
  });

  it("without the purchase permission, no checkout starts and no purchase analytics leave", async () => {
    const h = setup({ email: true });
    await expect(h.guarded(new Request(`${SUPABASE}/functions/v1/create-web-checkout`))).rejects.toBeInstanceOf(TypeError);
    await expect(h.guarded(new URL(`${SUPABASE}/functions/v1/analytics-purchase`))).rejects.toBeInstanceOf(TypeError);
    expect(h.base).not.toHaveBeenCalled();
  });

  it("without the purchase permission, a stored checkout is not completed (its operation id stays on the device)", async () => {
    const h = setup({ email: true });
    const body = JSON.stringify({ access_schema: 1, surface: "firefox_desktop", build: "3.0.0", operation_id: "11111111-1111-4111-8111-111111111111" });
    await expect(h.guarded(`${SUPABASE}/functions/v1/complete-web-checkout`, { method: "POST", body })).rejects.toBeInstanceOf(TypeError);
    expect(h.base).not.toHaveBeenCalled();
  });

  it("without the purchase permission, Still Pro status is still received (it never locks for want of a grant)", async () => {
    const h = setup({});
    await h.guarded(`${SUPABASE}/functions/v1/reconcile-entitlement`, { method: "POST", body: '{"access_schema":1}' });
    await h.guarded(`${SUPABASE}/rest/v1/entitlements?select=still_sync`);
    expect(h.base).toHaveBeenCalledTimes(2);
    expect(h.granted).not.toHaveBeenCalled();
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
    await h.guarded(`${SUPABASE}/functions/v1/create-web-checkout`);
    h.grants.purchase = false;
    await expect(h.guarded(`${SUPABASE}/functions/v1/create-web-checkout`)).rejects.toBeInstanceOf(TypeError);
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
    let userId = options.userId;
    const signOut = vi.fn(async () => {
      userId = null;
      return "signed-out";
    });
    let granted = options.granted;
    const timers: (() => void)[] = [];
    const watch = createAccountEmailWatch({
      granted: async () => granted,
      currentUserId: async () => userId,
      signedInWithGrant: { get: async () => values.account, set: async (v) => void (values.account = v) },
      withdrawn: { get: async () => values.withdrawn, set: async (v) => void (values.withdrawn = v) },
      signOut,
      retryLater: (run) => void timers.push(run),
    });
    return { watch, signOut, values, timers, grant: (next: boolean) => void (granted = next) };
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

  it("a sign-out that fails is retried, never taken as kept", async () => {
    const h = setup({ userId: "u1", recorded: "u1", granted: false });
    h.signOut.mockRejectedValueOnce(new Error("storage busy"));
    expect(await h.watch.check()).toBe("retrying");
    expect(h.values.withdrawn).toBeNull();
    expect(h.timers).toHaveLength(1);
    h.timers.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.signOut).toHaveBeenCalledTimes(2);
    expect(h.values).toEqual({ account: null, withdrawn: true });
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
      onNudge: vi.fn(async () => (calls.push("onNudge"), "no-op" as const)),
    };
    return s as unknown as ExtensionSession & { calls: string[] };
  }

  it("checks before the account reads, the start-up resume and the supported-site nudge; records a verified sign-in", async () => {
    const inner = session();
    const order: string[] = inner.calls;
    const watch = {
      check: vi.fn(async () => (order.push("check"), "kept" as const)),
      signedIn: vi.fn(async () => {}),
      granted: vi.fn(async () => {}),
    };
    const wrapped = withAccountEmailWatch(inner, watch);
    await wrapped.resume();
    await wrapped.getState();
    await wrapped.getSyncStatus();
    expect(order).toEqual(["check", "resume", "check", "getState", "check", "getSyncStatus"]);
    await wrapped.verifyCode("me@example.com", "123456");
    expect(watch.signedIn).toHaveBeenCalledWith("u1");
    // The content-script nudge (a supported site opened) checks too. The content script never
    // waits for it: the background answers the nudge without a reply.
    order.length = 0;
    await wrapped.onNudge();
    expect(order).toEqual(["check", "onNudge"]);
  });
});

describe("account analytics on Firefox: the email is attached only with the email grant", () => {
  it("a legacy signed-in account with usage sharing on and no grant: no identify, no subject", async () => {
    // Signed in before this change (no recorded grant), usage sharing on, email not granted.
    let granted = false;
    const identifyOnServer = vi.fn(async (_signal?: AbortSignal) => {});
    const issueSubject = vi.fn(async (_body: unknown, _signal: AbortSignal, _account: string) => ({ subject: "s" }));
    const gatedIdentify = requireEmailGrant(identifyOnServer, async () => granted);
    const gatedIssue = requireEmailGrant(issueSubject, async () => granted);
    // Both refuse (the analytics host retries later; nothing is marked as done).
    await expect(gatedIdentify()).rejects.toThrow();
    await expect(gatedIssue({ originProof: "p" }, new AbortController().signal, "u1")).rejects.toThrow();
    expect(identifyOnServer).not.toHaveBeenCalled();
    expect(issueSubject).not.toHaveBeenCalled();
    // And the background's fetch refuses the request itself, whoever calls it.
    const base = vi.fn(async () => new Response("{}"));
    const guarded = guardFirefoxDataFetch(base as unknown as typeof fetch, { supabaseUrl: SUPABASE, granted: async () => granted });
    await expect(guarded(`${SUPABASE}/functions/v1/analytics-identify`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(TypeError);
    expect(base).not.toHaveBeenCalled();
    // With the grant (a sign-in on Firefox asked for it), both go through.
    granted = true;
    await gatedIdentify();
    const signal = new AbortController().signal;
    await gatedIssue({ originProof: "p" }, signal, "u1");
    expect(identifyOnServer).toHaveBeenCalledOnce();
    expect(issueSubject).toHaveBeenCalledWith({ originProof: "p" }, signal, "u1");
  });
});

describe("the background wiring (watchFirefoxAccountEmail)", () => {
  function fakeChrome(initial: { granted: string[]; items?: Record<string, unknown> }) {
    const items: Record<string, unknown> = { ...(initial.items ?? {}) };
    const held = new Set(initial.granted);
    let removed: ((p: { data_collection?: string[] }) => void) | null = null;
    let added: ((p: { data_collection?: string[] }) => void) | null = null;
    return {
      items,
      held,
      api: {
        permissions: {
          getAll: async () => ({ data_collection: [...held] }),
          onRemoved: { addListener: (l: (p: { data_collection?: string[] }) => void) => void (removed = l) },
          onAdded: { addListener: (l: (p: { data_collection?: string[] }) => void) => void (added = l) },
        },
        storage: {
          get: async (key: string) => (key in items ? { [key]: items[key] } : {}),
          set: async (values: Record<string, unknown>) => void Object.assign(items, values),
          remove: async (key: string) => void delete items[key],
        },
      },
      remove(types: string[]) {
        for (const type of types) held.delete(type);
        removed?.({ data_collection: types });
      },
      add(types: string[]) {
        for (const type of types) held.add(type);
        added?.({ data_collection: types });
      },
      get listening() {
        return removed !== null && added !== null;
      },
    };
  }
  function innerSession() {
    let userId: string | null = "u1";
    const s = {
      getState: vi.fn(async () => ({ userId, entitled: false, checkoutPending: null, pendingOtp: null })),
      getSyncStatus: vi.fn(async () => null),
      resume: vi.fn(async () => "resumed-free" as const),
      onNudge: vi.fn(async () => "no-op" as const),
      verifyCode: vi.fn(async () => ({ kind: "verified", userId: "u1" }) as const),
      signOut: vi.fn(async () => {
        userId = null;
        return "signed-out" as const;
      }),
    };
    return { s, currentUserId: async () => userId };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("registers Firefox's permission events and records a sign-in under its storage key", async () => {
    const chromeLike = fakeChrome({ granted: ["authenticationInfo", "personallyIdentifyingInfo"] });
    const { s, currentUserId } = innerSession();
    const session = watchFirefoxAccountEmail(s as unknown as ExtensionSession, currentUserId, chromeLike.api);
    expect(chromeLike.listening).toBe(true);
    await session.verifyCode("me@example.com", "123456");
    expect(chromeLike.items[EMAIL_GRANT_ACCOUNT_KEY]).toBe("u1");
  });

  it("a withdrawal reported by Firefox signs the account out of sync and flags the line", async () => {
    const chromeLike = fakeChrome({ granted: ["personallyIdentifyingInfo"], items: { [EMAIL_GRANT_ACCOUNT_KEY]: "u1" } });
    const { s, currentUserId } = innerSession();
    watchFirefoxAccountEmail(s as unknown as ExtensionSession, currentUserId, chromeLike.api);
    chromeLike.remove(["technicalAndInteraction"]);
    await settle();
    expect(s.signOut).not.toHaveBeenCalled();
    chromeLike.remove(["personallyIdentifyingInfo"]);
    await settle();
    expect(s.signOut).toHaveBeenCalledOnce();
    expect(chromeLike.items).toEqual({ [EMAIL_PERMISSION_WITHDRAWN_KEY]: true });
  });

  it("the account reads run the check (a withdrawal while the background slept)", async () => {
    const chromeLike = fakeChrome({ granted: [], items: { [EMAIL_GRANT_ACCOUNT_KEY]: "u1" } });
    const { s, currentUserId } = innerSession();
    const session = watchFirefoxAccountEmail(s as unknown as ExtensionSession, currentUserId, chromeLike.api);
    const state = await session.getState();
    expect(s.signOut).toHaveBeenCalledOnce();
    expect(state.userId).toBeNull();
  });

  it("granted again: the withdrawn flag is cleared even before the next sign-in", async () => {
    const chromeLike = fakeChrome({ granted: [], items: { [EMAIL_PERMISSION_WITHDRAWN_KEY]: true } });
    const { s, currentUserId } = innerSession();
    watchFirefoxAccountEmail(s as unknown as ExtensionSession, currentUserId, chromeLike.api);
    chromeLike.add(["personallyIdentifyingInfo"]);
    await settle();
    expect(chromeLike.items[EMAIL_PERMISSION_WITHDRAWN_KEY]).toBeUndefined();
  });
});

describe("gateAccountAnalytics: the Firefox background's account analytics calls", () => {
  it("wraps both identifyOnServer and issueSubject with the email gate", async () => {
    const identifyOnServer = vi.fn(async (_signal?: AbortSignal) => {});
    const issueSubject = vi.fn(async (_body: unknown, _signal: AbortSignal, _account: string) => ({}));
    let granted = false;
    const gated = gateAccountAnalytics({ identifyOnServer, issueSubject }, async () => granted);
    await expect(gated.identifyOnServer!()).rejects.toThrow();
    await expect(gated.issueSubject!({}, new AbortController().signal, "u1")).rejects.toThrow();
    expect(identifyOnServer).not.toHaveBeenCalled();
    expect(issueSubject).not.toHaveBeenCalled();
    granted = true;
    await gated.identifyOnServer!();
    await gated.issueSubject!({}, new AbortController().signal, "u1");
    expect(identifyOnServer).toHaveBeenCalledOnce();
    expect(issueSubject).toHaveBeenCalledOnce();
  });

  it("keeps an absent call absent (2.x builds pass no issueSubject; signed-out builds no identify)", () => {
    const gated = gateAccountAnalytics({ identifyOnServer: undefined }, async () => true);
    expect(gated.identifyOnServer).toBeUndefined();
    expect("issueSubject" in gated).toBe(false);
  });
});

describe("background.ts hands both account analytics calls through the gate on Firefox", () => {
  it("defines them in one object that reaches the analytics factory only through gateAccountAnalytics", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("../../entrypoints/background.ts", import.meta.url)), "utf8");
    const start = source.indexOf("const accountAnalytics = {");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("\n  };\n", start));
    expect(block).toContain("identifyOnServer:");
    expect(block).toContain("issueSubject:");
    // Nowhere else does the background name either call.
    const outside = source.slice(0, start) + source.slice(start + block.length);
    expect(outside).not.toMatch(/identifyOnServer:|issueSubject:/);
    expect(source).toMatch(/\.\.\.\(import\.meta\.env\.FIREFOX\s*\?\s*gateAccountAnalytics\(accountAnalytics,/);
    expect(source.match(/accountAnalytics\b/g)).toHaveLength(3); // declared, gated, or passed as is
  });
});
