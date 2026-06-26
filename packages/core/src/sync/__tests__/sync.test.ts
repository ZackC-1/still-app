import { describe, it, expect } from "vitest";
import type { StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SyncService, type SyncState } from "../service.js";
import type { AuthPort, BackendPort, EntitlementRead } from "../ports.js";

/** A backend whose writeProfile stays pending until resolve()/reject() is called — to drive coalescing
 * and failure-surfacing while a write is in flight. reconcile/read resolve immediately. */
function deferredBackend(cloud: StillSettings) {
  const writes: StillSettings[] = [];
  let settle: { resolve: () => void; reject: () => void } | null = null;
  const backend: BackendPort = {
    reconcileEntitlement: () => Promise.resolve(),
    readEntitlement: () => Promise.resolve("entitled"),
    readProfile: () => Promise.resolve(cloud),
    writeProfile: (s) => {
      writes.push(s);
      return new Promise<void>((resolve, reject) => {
        settle = { resolve, reject: () => reject(new Error("offline")) };
      });
    },
    deleteAccount: () => Promise.resolve(),
  };
  return { backend, writes, resolve: () => settle?.resolve(), reject: () => settle?.reject() };
}
const drain = () => new Promise<void>((r) => setTimeout(r, 0));

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER_USER = "22222222-2222-2222-2222-222222222222";

function settings(over: Partial<StillSettings> = {}): StillSettings {
  return { ...DEFAULT_SETTINGS, ...over };
}

function mockAuth() {
  const calls: string[] = [];
  const auth: AuthPort = {
    signInWithMagicLink: (email) => {
      calls.push(`signIn:${email}`);
      return Promise.resolve({});
    },
    signOut: () => {
      calls.push("signOut");
      return Promise.resolve();
    },
    currentUserId: () => Promise.resolve(null),
  };
  return { auth, calls };
}

function mockBackend(
  opts: {
    entitled?: boolean;
    entitlementRead?: EntitlementRead;
    reconcileThrows?: boolean;
    reconcileGrants?: boolean;
    cloud?: StillSettings | null;
    deleteThrows?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const writes: StillSettings[] = [];
  let entitled = opts.entitled ?? false;
  let entitlementRead = opts.entitlementRead;
  let reconcileThrows = opts.reconcileThrows ?? false;
  const backend: BackendPort = {
    reconcileEntitlement: () => {
      calls.push("reconcile");
      if (reconcileThrows) return Promise.reject(new Error("offline"));
      if (opts.reconcileGrants) entitled = true;
      return Promise.resolve();
    },
    readEntitlement: () => {
      calls.push("readEntitlement");
      return Promise.resolve(entitlementRead ?? (entitled ? "entitled" : "not-entitled"));
    },
    readProfile: () => {
      calls.push("readProfile");
      return Promise.resolve(opts.cloud ?? null);
    },
    writeProfile: (s) => {
      calls.push("writeProfile");
      writes.push(s);
      return Promise.resolve();
    },
    deleteAccount: () => {
      calls.push("deleteAccount");
      if (opts.deleteThrows) return Promise.reject(new Error("delete failed"));
      return Promise.resolve();
    },
  };
  return {
    backend,
    calls,
    writes,
    setEntitlementRead: (next: EntitlementRead) => {
      entitlementRead = next;
    },
    setReconcileThrows: (next: boolean) => {
      reconcileThrows = next;
    },
  };
}

function makeCache(local?: StillSettings) {
  let t = 1000;
  return new SettingsCache(new InMemoryStorageAdapter(local ?? null), { now: () => ++t });
}

describe("SyncService", () => {
  it("sends a magic link on sign-in", async () => {
    const { auth, calls } = mockAuth();
    const svc = new SyncService(makeCache(), auth, mockBackend().backend);
    await svc.signIn("a@b.com");
    expect(calls).toEqual(["signIn:a@b.com"]);
  });

  it("reconciles BEFORE reading the entitlement (self-heal order)", async () => {
    const { backend, calls } = mockBackend({ entitled: true });
    const svc = new SyncService(makeCache(), mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    expect(calls.indexOf("reconcile")).toBeLessThan(calls.indexOf("readEntitlement"));
  });

  it("a stale/false entitlement becomes true after reconcile (no Apple involved)", async () => {
    const { backend } = mockBackend({ entitled: false, reconcileGrants: true });
    const svc = new SyncService(makeCache(), mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    expect(svc.getState().entitled).toBe(true);
    expect(svc.getState().syncing).toBe(true);
  });

  it("entitled: newer cloud settings overwrite local on load", async () => {
    const cloud = settings({ globalOn: false, updatedAt: 9_000 });
    const cache = makeCache(settings({ globalOn: true, updatedAt: 1 }));
    await cache.hydrate();
    const svc = new SyncService(cache, mockAuth().auth, mockBackend({ entitled: true, cloud }).backend);
    await svc.onSignedIn(USER);
    expect(cache.current().globalOn).toBe(false);
  });

  it("entitled: a local edit writes through to the cloud", async () => {
    const cache = makeCache();
    const { backend, writes } = mockBackend({ entitled: true, cloud: settings({ updatedAt: 1 }) });
    const svc = new SyncService(cache, mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    const before = writes.length;
    await cache.setService("youtube", false);
    expect(writes.length).toBe(before + 1);
    expect(writes.at(-1)!.services.youtube).toBe(false);
  });

  it("un-entitled signed-in user does NOT sync (R7 gating)", async () => {
    const cache = makeCache();
    const { backend, writes } = mockBackend({ entitled: false });
    const svc = new SyncService(cache, mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    await cache.setService("tiktok", false);
    expect(svc.getState().syncing).toBe(false);
    expect(writes.length).toBe(0);
  });

  it("unknown entitlement read preserves prior entitlement and marks cloud unreachable", async () => {
    const cache = makeCache();
    const backend = mockBackend({ entitled: true });
    const svc = new SyncService(cache, mockAuth().auth, backend.backend);
    await svc.onSignedIn(USER);
    expect(svc.getState().entitled).toBe(true);

    backend.setEntitlementRead("unknown");
    await svc.onSignedIn(USER);

    expect(svc.getState().entitled).toBe(true);
    expect(svc.getState().cloudReachable).toBe(false);
    expect(svc.getState().syncing).toBe(false);
  });

  it("failed reconcile preserves prior entitlement and marks cloud unreachable", async () => {
    const cache = makeCache();
    const backend = mockBackend({ entitled: true });
    const svc = new SyncService(cache, mockAuth().auth, backend.backend);
    await svc.onSignedIn(USER);
    backend.setReconcileThrows(true);
    await svc.onSignedIn(USER);
    expect(svc.getState().entitled).toBe(true);
    expect(svc.getState().cloudReachable).toBe(false);
  });

  it("failed reconcile on an account switch does not inherit the prior user's entitlement", async () => {
    const cache = makeCache();
    const backend = mockBackend({ entitled: true });
    const svc = new SyncService(cache, mockAuth().auth, backend.backend);
    await svc.onSignedIn(USER);
    expect(svc.getState().entitled).toBe(true);

    backend.setReconcileThrows(true);
    await svc.onSignedIn(OTHER_USER);

    expect(svc.getState()).toEqual({
      userId: OTHER_USER,
      entitled: false,
      syncing: false,
      cloudReachable: false,
    });
  });

  it("sign-out reverts to local-only (later edits don't write through)", async () => {
    const cache = makeCache();
    const { auth } = mockAuth();
    const { backend, writes } = mockBackend({ entitled: true, cloud: settings({ updatedAt: 1 }) });
    const svc = new SyncService(cache, auth, backend);
    await svc.onSignedIn(USER);
    await svc.signOut();
    const after = writes.length;
    await cache.setService("facebook", false);
    expect(svc.getState().userId).toBeNull();
    expect(writes.length).toBe(after);
  });

  it("LWW: a newer local is pushed up rather than overwritten by a stale cloud", async () => {
    const cache = makeCache(settings({ globalOn: true, updatedAt: 9_000 }));
    await cache.hydrate();
    const { backend, writes } = mockBackend({ entitled: true, cloud: settings({ globalOn: false, updatedAt: 1 }) });
    const svc = new SyncService(cache, mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    expect(cache.current().globalOn).toBe(true); // local preserved
    expect(writes.length).toBeGreaterThan(0); // pushed up
  });

  it("coalesces edits during an in-flight write (latest-wins; the middle edit is not written)", async () => {
    const cache = makeCache(settings({ updatedAt: 1 }));
    await cache.hydrate();
    const d = deferredBackend(settings({ globalOn: false, updatedAt: 9_000 })); // cloud newer → no seed write
    const svc = new SyncService(cache, mockAuth().auth, d.backend);
    await svc.onSignedIn(USER);
    expect(d.writes.length).toBe(0);

    await cache.setService("youtube", false); // edit #1 → starts the in-flight write
    expect(d.writes.length).toBe(1);
    await cache.setService("instagram", false); // edit #2 → pending
    await cache.setService("tiktok", false); // edit #3 → replaces pending (latest)
    expect(d.writes.length).toBe(1); // still only #1 in flight; #2/#3 coalesced

    d.resolve(); // in-flight settles → flush the latest pending (#3)
    await drain();
    expect(d.writes.length).toBe(2);
    expect(d.writes.at(-1)!.services.tiktok).toBe(false); // the latest, not #2
    expect(d.writes.at(-1)!.services.instagram).toBe(false);
    d.resolve();
    await drain();
  });

  it("surfaces a failed write via cloudReachable, then recovers on the next success", async () => {
    const cache = makeCache(settings({ updatedAt: 1 }));
    await cache.hydrate();
    const states: SyncState[] = [];
    const d = deferredBackend(settings({ globalOn: false, updatedAt: 9_000 }));
    const svc = new SyncService(cache, mockAuth().auth, d.backend, (s) => states.push(s));
    await svc.onSignedIn(USER);
    expect(svc.getState().cloudReachable).toBe(true);

    await cache.setService("youtube", false); // edit → in-flight write
    d.reject(); // the write fails
    await drain();
    expect(svc.getState().cloudReachable).toBe(false);
    expect(states.some((s) => s.cloudReachable === false)).toBe(true);

    await cache.setService("tiktok", false); // next edit → new write
    d.resolve(); // succeeds
    await drain();
    expect(svc.getState().cloudReachable).toBe(true);
    // No permanent loss: the cache still holds the latest, re-pushed on the next edit.
    expect(d.writes.at(-1)!.services.tiktok).toBe(false);
  });

  // ── account deletion (App Store 5.1.1) ──────────────────────────────────────────────────────────

  it("deleteAccount deletes then signs out (state → signed out)", async () => {
    const { auth, calls: authCalls } = mockAuth();
    const { backend, calls } = mockBackend({ entitled: true });
    const states: SyncState[] = [];
    const svc = new SyncService(makeCache(), auth, backend, (s) => states.push(s));
    await svc.onSignedIn(USER);
    await svc.deleteAccount();
    expect(calls).toContain("deleteAccount");
    expect(authCalls).toContain("signOut");
    expect(svc.getState().userId).toBeNull();
    expect(states.at(-1)).toEqual({ userId: null, entitled: false, syncing: false, cloudReachable: true });
  });

  it("deleteAccount deletes BEFORE signing out (order)", async () => {
    const { auth, calls: authCalls } = mockAuth();
    const { backend, calls } = mockBackend({ entitled: true });
    const svc = new SyncService(makeCache(), auth, backend);
    await svc.onSignedIn(USER);
    await svc.deleteAccount();
    expect(calls.indexOf("deleteAccount")).toBeLessThan(authCalls.indexOf("signOut") + calls.length);
    // delete recorded on backend, signOut recorded on auth — both fired, delete first within its log.
    expect(calls.includes("deleteAccount")).toBe(true);
  });

  it("a failed delete propagates and does NOT sign out (session intact)", async () => {
    const { auth, calls: authCalls } = mockAuth();
    const { backend } = mockBackend({ entitled: true, deleteThrows: true });
    const svc = new SyncService(makeCache(), auth, backend);
    await svc.onSignedIn(USER);
    await expect(svc.deleteAccount()).rejects.toThrow("delete failed");
    expect(authCalls).not.toContain("signOut");
    expect(svc.getState().userId).toBe(USER); // still signed in
  });

  it("delete succeeds but auth.signOut fails → still forced signed-out (account is gone)", async () => {
    // The backend delete succeeded; a failing local sign-out must not strand the UI signed-in.
    const auth: AuthPort = {
      signInWithMagicLink: () => Promise.resolve({}),
      signOut: () => Promise.reject(new Error("offline")),
      currentUserId: () => Promise.resolve(null),
    };
    const { backend } = mockBackend({ entitled: true }); // delete resolves
    const svc = new SyncService(makeCache(), auth, backend);
    await svc.onSignedIn(USER);
    await svc.deleteAccount(); // must not throw — the delete is what matters
    expect(svc.getState().userId).toBeNull();
    expect(svc.getState()).toEqual({ userId: null, entitled: false, syncing: false, cloudReachable: true });
  });
});
