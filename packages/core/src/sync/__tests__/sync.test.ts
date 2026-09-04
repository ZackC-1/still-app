import { describe, it, expect } from "vitest";
import type { StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SyncService, type LastSyncedIdentityStore, type SyncState } from "../service.js";
import type { AuthPort, BackendPort, EntitlementRead, SyncedSettingsEnvelope } from "../ports.js";

/** A backend whose writeProfile stays pending until resolve()/reject() is called — to drive coalescing
 * and failure-surfacing while a write is in flight. reconcile/read resolve immediately. */
function envelope(settingsValue: StillSettings, version = settingsValue.updatedAt): SyncedSettingsEnvelope {
  return {
    settings: settingsValue,
    version,
    serverUpdatedAt: new Date(1_800_000_000_000 + version).toISOString(),
    lastWriteId: null,
  };
}

/** An envelope whose SERVER timestamp is set explicitly — the first-sign-in merge compares against
 * that stamp, so the four merge directions need to state it rather than derive it from a version. */
function envelopeStampedAt(
  settingsValue: StillSettings,
  serverMs: number,
  version = 1,
): SyncedSettingsEnvelope {
  return {
    settings: settingsValue,
    version,
    serverUpdatedAt: new Date(serverMs).toISOString(),
    lastWriteId: null,
  };
}

function deferredBackend(cloud: SyncedSettingsEnvelope) {
  const writes: StillSettings[] = [];
  let version = cloud.version;
  let settle: { resolve: () => void; reject: () => void } | null = null;
  let onEnvelope: ((envelope: SyncedSettingsEnvelope) => void) | null = null;
  let onStatus: ((status: "subscribed" | "disconnected" | "error") => void) | null = null;
  let unsubscribed = false;
  const backend: BackendPort = {
    reconcileEntitlement: () => Promise.resolve(),
    readEntitlement: () => Promise.resolve("entitled"),
    readProfile: () => Promise.resolve(cloud),
    writeProfile: (s) => {
      writes.push(s);
      return new Promise<SyncedSettingsEnvelope>((resolve, reject) => {
        settle = {
          resolve: () => resolve(envelope(s, ++version)),
          reject: () => reject(new Error("offline")),
        };
      });
    },
    subscribeToProfile: (_userId, listener, status) => {
      onEnvelope = listener;
      onStatus = status ?? null;
      return () => {
        unsubscribed = true;
      };
    },
    deleteAccount: () => Promise.resolve(),
  };
  return {
    backend,
    writes,
    resolve: () => settle?.resolve(),
    reject: () => settle?.reject(),
    emit: (env: SyncedSettingsEnvelope) => onEnvelope?.(env),
    status: (s: "subscribed" | "disconnected" | "error") => onStatus?.(s),
    unsubscribed: () => unsubscribed,
  };
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
    cloud?: SyncedSettingsEnvelope | null;
    readProfileThrows?: boolean;
    deleteThrows?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const writes: StillSettings[] = [];
  let version = opts.cloud?.version ?? 0;
  let profileReads = 0;
  let onEnvelope: ((envelope: SyncedSettingsEnvelope) => void) | null = null;
  let onStatus: ((status: "subscribed" | "disconnected" | "error") => void) | null = null;
  let unsubscribed = false;
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
      profileReads += 1;
      if (opts.readProfileThrows) return Promise.reject(new Error("offline"));
      return Promise.resolve(opts.cloud ?? null);
    },
    writeProfile: (s) => {
      calls.push("writeProfile");
      writes.push(s);
      return Promise.resolve(envelope(s, ++version));
    },
    subscribeToProfile: (_userId, listener, status) => {
      calls.push("subscribeToProfile");
      onEnvelope = listener;
      onStatus = status ?? null;
      return () => {
        calls.push("unsubscribeProfile");
        unsubscribed = true;
      };
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
    emitProfile: (env: SyncedSettingsEnvelope) => onEnvelope?.(env),
    profileStatus: (status: "subscribed" | "disconnected" | "error") => onStatus?.(status),
    profileReads: () => profileReads,
    unsubscribed: () => unsubscribed,
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

/** In-memory LastSyncedIdentityStore — the storage-backed seam's test double. */
function identityStore(initial: string | null = null) {
  let last = initial;
  const sets: string[] = [];
  const store: LastSyncedIdentityStore = {
    get: () => Promise.resolve(last),
    set: (userId) => {
      sets.push(userId);
      last = userId;
      return Promise.resolve();
    },
  };
  return { store, sets, current: () => last };
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
    const cloud = envelope(settings({ globalOn: false, updatedAt: 9_000 }), 1);
    const cache = makeCache(settings({ globalOn: true, updatedAt: 1 }));
    await cache.hydrate();
    const svc = new SyncService(cache, mockAuth().auth, mockBackend({ entitled: true, cloud }).backend);
    await svc.onSignedIn(USER);
    expect(cache.current().globalOn).toBe(false);
  });

  it("entitled: a local edit writes through to the cloud", async () => {
    const cache = makeCache();
    const { backend, writes } = mockBackend({ entitled: true, cloud: envelope(settings({ updatedAt: 1 }), 1) });
    const svc = new SyncService(cache, mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    const before = writes.length;
    await cache.setService("youtube", false);
    expect(writes.length).toBe(before + 1);
    expect(writes.at(-1)!.services.youtube).toBe(false);
    await drain();
    expect(cache.currentSyncMetadata()?.version).toBe(2);
  });

  it("remote realtime higher version updates local settings", async () => {
    const cache = makeCache();
    const d = mockBackend({ entitled: true, cloud: envelope(settings({ globalOn: true, updatedAt: 1 }), 1) });
    const svc = new SyncService(cache, mockAuth().auth, d.backend);
    await svc.onSignedIn(USER);
    d.emitProfile(envelope(settings({ globalOn: false, updatedAt: 2 }), 2));
    expect(cache.current().globalOn).toBe(false);
    expect(cache.currentSyncMetadata()?.version).toBe(2);
  });

  it("remote realtime lower version is ignored", async () => {
    const cache = makeCache();
    const d = mockBackend({ entitled: true, cloud: envelope(settings({ globalOn: true, updatedAt: 1 }), 3) });
    const svc = new SyncService(cache, mockAuth().auth, d.backend);
    await svc.onSignedIn(USER);
    d.emitProfile(envelope(settings({ globalOn: false, updatedAt: 9_999 }), 2));
    expect(cache.current().globalOn).toBe(true);
    expect(cache.currentSyncMetadata()?.version).toBe(3);
  });

  it("remote higher version during an in-flight local write wins over a stale ack", async () => {
    const cache = makeCache(settings({ updatedAt: 1 }));
    await cache.hydrate();
    const d = deferredBackend(envelope(settings({ globalOn: true, updatedAt: 1 }), 1));
    const svc = new SyncService(cache, mockAuth().auth, d.backend);
    await svc.onSignedIn(USER);

    await cache.setGlobalOn(false);
    d.emit(envelope(settings({ globalOn: true, updatedAt: 3 }), 3));
    d.resolve(); // resolves the local write as version 2, which must not beat remote v3
    await drain();
    expect(cache.current().globalOn).toBe(true);
    expect(cache.currentSyncMetadata()?.version).toBe(3);
  });

  it("reconnect reads profile before trusting the stream as current", async () => {
    const cache = makeCache();
    const d = mockBackend({ entitled: true, cloud: envelope(settings({ globalOn: true, updatedAt: 1 }), 1) });
    const svc = new SyncService(cache, mockAuth().auth, d.backend);
    await svc.onSignedIn(USER);
    const before = d.profileReads();
    d.profileStatus("disconnected");
    d.profileStatus("subscribed");
    await drain();
    expect(d.profileReads()).toBe(before + 1);
  });

  it("teardown unsubscribes realtime", async () => {
    const cache = makeCache();
    const { auth } = mockAuth();
    const d = mockBackend({ entitled: true, cloud: envelope(settings({ updatedAt: 1 }), 1) });
    const svc = new SyncService(cache, auth, d.backend);
    await svc.onSignedIn(USER);
    await svc.signOut();
    expect(d.unsubscribed()).toBe(true);
  });

  it("having an account is the whole sync gate: a signed-in user who owns nothing syncs", async () => {
    const cache = makeCache();
    const { backend, writes } = mockBackend({ entitled: false });
    const svc = new SyncService(cache, mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    await cache.setService("tiktok", false);
    expect(svc.getState().syncing).toBe(true);
    expect(writes.at(-1)!.services.tiktok).toBe(false);
    // The entitlement is still reported truthfully; it just no longer decides anything here.
    expect(svc.getState().entitled).toBe(false);
  });

  it("settings sync does not wait on the entitlement round trip, and survives its failure", async () => {
    const cache = makeCache();
    const { backend, writes, calls } = mockBackend({ entitled: true, reconcileThrows: true });
    const svc = new SyncService(cache, mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    // The cloud read happened even though the entitlement check never returned an answer.
    expect(calls).toContain("readProfile");
    expect(svc.getState().syncing).toBe(true);
    expect(svc.getState().confirmed).toBe(false); // an unchecked entitlement is never confirmed
    await cache.setService("tiktok", false);
    expect(writes.length).toBeGreaterThan(0);
  });

  it("a failing entitlement check does not claim the settings cloud is unreachable", async () => {
    const { backend } = mockBackend({ entitled: true, reconcileThrows: true });
    const svc = new SyncService(makeCache(), mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    expect(svc.getState().cloudReachable).toBe(true);
  });

  it("a failing cloud read DOES mark the cloud unreachable", async () => {
    const { backend } = mockBackend({ entitled: true, readProfileThrows: true });
    const svc = new SyncService(makeCache(), mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    expect(svc.getState().cloudReachable).toBe(false);
  });

  it("unknown entitlement read preserves prior entitlement and leaves it unconfirmed", async () => {
    const cache = makeCache();
    const backend = mockBackend({ entitled: true });
    const svc = new SyncService(cache, mockAuth().auth, backend.backend);
    await svc.onSignedIn(USER);
    expect(svc.getState().entitled).toBe(true);

    backend.setEntitlementRead("unknown");
    await svc.onSignedIn(USER);

    expect(svc.getState().entitled).toBe(true);
    expect(svc.getState().confirmed).toBe(false);
    expect(svc.getState().syncing).toBe(true); // settings sync is unaffected by the missing answer
  });

  it("failed reconcile preserves prior entitlement and leaves it unconfirmed", async () => {
    const cache = makeCache();
    const backend = mockBackend({ entitled: true });
    const svc = new SyncService(cache, mockAuth().auth, backend.backend);
    await svc.onSignedIn(USER);
    backend.setReconcileThrows(true);
    await svc.onSignedIn(USER);
    expect(svc.getState().entitled).toBe(true);
    expect(svc.getState().confirmed).toBe(false);
  });

  it("emits an UNCONFIRMED provisional state before reconcile, confirmed only after the read settles", async () => {
    const cache = makeCache();
    const backend = mockBackend({ entitled: true });
    const states: SyncState[] = [];
    const svc = new SyncService(cache, mockAuth().auth, backend.backend, (s) => states.push(s));
    await svc.onSignedIn(USER);
    // First emit is the pre-reconcile provisional (cold guess entitled:false, cloudReachable:true):
    // it must carry confirmed:false so hosts don't stamp it into the App-Group entitlement record.
    expect(states[0]).toMatchObject({ userId: USER, entitled: false, cloudReachable: true, confirmed: false });
    expect(svc.getState()).toMatchObject({ entitled: true, confirmed: true });

    // An offline re-sign-in never reaches a confirmed state.
    backend.setReconcileThrows(true);
    states.length = 0;
    await svc.onSignedIn(USER);
    expect(states.every((s) => !s.confirmed)).toBe(true);

    // resume() trusts a cached answer — also never confirmed.
    svc.resume(USER, true);
    expect(svc.getState().confirmed).toBe(false);
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
      syncing: true, // the new user still syncs; only their entitlement went unanswered
      cloudReachable: true,
      confirmed: false,
    });
  });

  it("sign-out reverts to local-only (later edits don't write through)", async () => {
    const cache = makeCache();
    const { auth } = mockAuth();
    const { backend, writes } = mockBackend({ entitled: true, cloud: envelope(settings({ updatedAt: 1 }), 1) });
    const svc = new SyncService(cache, auth, backend);
    await svc.onSignedIn(USER);
    await svc.signOut();
    const after = writes.length;
    await cache.setService("facebook", false);
    expect(svc.getState().userId).toBeNull();
    expect(writes.length).toBe(after);
  });

  it("server version beats a future-skewed local updatedAt on sign-in", async () => {
    const cache = makeCache(settings({ globalOn: true, updatedAt: 9_000 }));
    await cache.hydrate();
    const { backend, writes } = mockBackend({ entitled: true, cloud: envelope(settings({ globalOn: false, updatedAt: 1 }), 1) });
    const svc = new SyncService(cache, mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    expect(cache.current().globalOn).toBe(false);
    expect(writes.length).toBe(0);
  });

  it("coalesces edits during an in-flight write (latest-wins; the middle edit is not written)", async () => {
    const cache = makeCache(settings({ updatedAt: 1 }));
    await cache.hydrate();
    const d = deferredBackend(envelope(settings({ globalOn: false, updatedAt: 9_000 }), 1)); // cloud exists → no seed write
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
    const d = deferredBackend(envelope(settings({ globalOn: false, updatedAt: 9_000 }), 1));
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

  // ── identity switch (R8/AE5): never seed a new user's cloud from the previous user's local ─────

  it("a DIFFERENT user signing in with an empty cloud does NOT seed it from local settings", async () => {
    const cache = makeCache(settings({ globalOn: false, updatedAt: 9_000 })); // user A's leftovers
    await cache.hydrate();
    const { backend, writes } = mockBackend({ entitled: true, cloud: null });
    const { store } = identityStore(USER); // last synced: user A
    const svc = new SyncService(cache, mockAuth().auth, backend, undefined, store);
    await svc.onSignedIn(OTHER_USER);
    expect(writes.length).toBe(0); // cloud wins — B's profile never written from A's blob
    expect(svc.getState().syncing).toBe(true); // sync still starts; write-through covers B's own edits
  });

  it("the SAME user re-signing in keeps today's empty-cloud seed behavior", async () => {
    const cache = makeCache(settings({ globalOn: false, updatedAt: 9_000 }));
    await cache.hydrate();
    const { backend, writes } = mockBackend({ entitled: true, cloud: null });
    const { store } = identityStore(USER);
    const svc = new SyncService(cache, mockAuth().auth, backend, undefined, store);
    await svc.onSignedIn(USER);
    expect(writes.length).toBe(1); // seed preserved for the returning user
    expect(writes[0]!.globalOn).toBe(false);
  });

  it("no identity ever recorded → this device is the signer's own: the empty account is seeded", async () => {
    // The shared-machine guard exists to stop ONE person's settings landing in ANOTHER person's
    // account. A device that has never recorded an identity has no other person to protect, and
    // it is the ordinary case for a first-ever sign-in, so the settings someone has been using
    // travel into their new account instead of being replaced by an empty account's defaults.
    const cache = makeCache(settings({ globalOn: false, updatedAt: 9_000 }));
    await cache.hydrate();
    const { backend, writes } = mockBackend({ entitled: true, cloud: null });
    const { store } = identityStore(null);
    const svc = new SyncService(cache, mockAuth().auth, backend, undefined, store);
    await svc.onSignedIn(USER);
    expect(writes.length).toBe(1);
    expect(writes[0]!.globalOn).toBe(false);
  });

  it("identity seam absent (existing callers) → behavior identical to today: empty cloud is seeded", async () => {
    const cache = makeCache(settings({ globalOn: false, updatedAt: 9_000 }));
    await cache.hydrate();
    const { backend, writes } = mockBackend({ entitled: true, cloud: null });
    const svc = new SyncService(cache, mockAuth().auth, backend); // no seam — regression pin
    await svc.onSignedIn(USER);
    expect(writes.length).toBe(1);
  });

  it("identity switch with an existing cloud: a newer local is NOT pushed up over the new user's cloud", async () => {
    const cache = makeCache(settings({ globalOn: true, updatedAt: 9_000 })); // A's local, newer
    await cache.hydrate();
    const { backend, writes } = mockBackend({
      entitled: true,
      cloud: envelope(settings({ globalOn: false, updatedAt: 1 }), 1), // B's cloud
    });
    const { store } = identityStore(USER);
    const svc = new SyncService(cache, mockAuth().auth, backend, undefined, store);
    await svc.onSignedIn(OTHER_USER);
    expect(writes.length).toBe(0); // AE5: B's cloud profile never written from A's local settings
  });

  it("records the identity whenever a sync actually starts, entitlement or not", async () => {
    // The record is what lets the NEXT sign-in on this device recognise a different person, so it
    // has to be written for every account that syncs here, not only for one that owns something.
    const free = identityStore(null);
    const freeSvc = new SyncService(makeCache(), mockAuth().auth, mockBackend({ entitled: false }).backend, undefined, free.store);
    await freeSvc.onSignedIn(OTHER_USER);
    expect(free.sets).toEqual([OTHER_USER]);

    const paid = identityStore(null);
    const paidSvc = new SyncService(makeCache(), mockAuth().auth, mockBackend({ entitled: true }).backend, undefined, paid.store);
    await paidSvc.onSignedIn(USER);
    expect(paid.sets).toEqual([USER]);
    expect(paid.current()).toBe(USER);
  });

  it("after the switch is recorded, the new user's next re-sign-in behaves as same-user again", async () => {
    const { backend, writes } = mockBackend({ entitled: true, cloud: null });
    const { store } = identityStore(USER);
    const cache = makeCache(settings({ updatedAt: 9_000 }));
    await cache.hydrate();
    const svc = new SyncService(cache, mockAuth().auth, backend, undefined, store);
    await svc.onSignedIn(OTHER_USER); // switch: no seed, identity recorded
    expect(writes.length).toBe(0);
    await svc.onSignedIn(OTHER_USER); // same user now — seed allowed again
    expect(writes.length).toBe(1);
  });

  it("a sign-in whose cloud read fails does not record the identity (no sync ever started)", async () => {
    const { store, sets } = identityStore(null);
    const { backend } = mockBackend({ entitled: true, readProfileThrows: true });
    const svc = new SyncService(makeCache(), mockAuth().auth, backend, undefined, store);
    await svc.onSignedIn(USER);
    expect(sets).toEqual([]);
  });

  // ── first sign-in merge: the more recently changed side wins ────────────────────────────────────
  // Four directions, plus the cases where the account wins because the local timestamp cannot be
  // believed. The clock is injected so the comparison is exercised rather than accidentally decided
  // by whatever today's date happens to be.

  const SERVER_MS = 1_700_000_000_000; // the account's last write, on the server clock
  const DEVICE_NOW = SERVER_MS + 60_000; // this device believes it is a minute later

  function mergeService(
    local: StillSettings | null,
    cloud: SyncedSettingsEnvelope | null,
    deviceNow = DEVICE_NOW,
  ) {
    const cache = makeCache(local ?? undefined);
    const backend = mockBackend({ entitled: false, cloud });
    const svc = new SyncService(
      cache,
      mockAuth().auth,
      backend.backend,
      undefined,
      identityStore(null).store,
      () => deviceNow,
    );
    return { cache, svc, writes: backend.writes };
  }

  it("merge, local only: an empty account is filled from this device", async () => {
    const { cache, svc, writes } = mergeService(
      settings({ globalOn: false, updatedAt: SERVER_MS + 1_000 }),
      null,
    );
    await cache.hydrate();
    await svc.onSignedIn(USER);
    expect(writes.length).toBe(1);
    expect(writes[0]!.globalOn).toBe(false);
    expect(cache.current().globalOn).toBe(false);
  });

  it("merge, cloud only: a device that never changed anything adopts the account", async () => {
    const cloud = envelopeStampedAt(settings({ globalOn: false, updatedAt: 7 }), SERVER_MS);
    const { cache, svc, writes } = mergeService(null, cloud); // nothing stored locally
    await cache.hydrate();
    await svc.onSignedIn(USER);
    expect(cache.current().globalOn).toBe(false);
    expect(writes.length).toBe(0);
  });

  it("merge, both with the device newer: the device wins and publishes", async () => {
    const cloud = envelopeStampedAt(settings({ globalOn: false, updatedAt: 7 }), SERVER_MS);
    const { cache, svc, writes } = mergeService(
      settings({ globalOn: true, updatedAt: SERVER_MS + 1_000 }),
      cloud,
    );
    await cache.hydrate();
    await svc.onSignedIn(USER);
    expect(cache.current().globalOn).toBe(true); // the local change survived signing in
    expect(writes.length).toBe(1);
    expect(writes[0]!.globalOn).toBe(true); // …and went up to the account
  });

  it("merge, both with the account newer: the account wins and nothing is pushed up", async () => {
    const cloud = envelopeStampedAt(settings({ globalOn: false, updatedAt: 7 }), SERVER_MS);
    const { cache, svc, writes } = mergeService(
      settings({ globalOn: true, updatedAt: SERVER_MS - 1_000 }),
      cloud,
    );
    await cache.hydrate();
    await svc.onSignedIn(USER);
    expect(cache.current().globalOn).toBe(false);
    expect(writes.length).toBe(0);
  });

  it("merge, an exact tie: the account wins", async () => {
    const cloud = envelopeStampedAt(settings({ globalOn: false, updatedAt: 7 }), SERVER_MS);
    const { cache, svc, writes } = mergeService(
      settings({ globalOn: true, updatedAt: SERVER_MS }),
      cloud,
    );
    await cache.hydrate();
    await svc.onSignedIn(USER);
    expect(cache.current().globalOn).toBe(false);
    expect(writes.length).toBe(0);
  });

  it("merge, a local stamp the device's own clock puts in the future: the account wins", async () => {
    // A stored timestamp later than "now" on the same clock that wrote it is not a real edit time:
    // the record is corrupt, or the clock has since been corrected. Either way it cannot outrank
    // the account.
    const cloud = envelopeStampedAt(settings({ globalOn: false, updatedAt: 7 }), SERVER_MS);
    const { cache, svc, writes } = mergeService(
      settings({ globalOn: true, updatedAt: DEVICE_NOW + 5_000 }),
      cloud,
    );
    await cache.hydrate();
    await svc.onSignedIn(USER);
    expect(cache.current().globalOn).toBe(false);
    expect(writes.length).toBe(0);
  });

  it("merge, an unreadable server stamp: the account wins", async () => {
    const cloud: SyncedSettingsEnvelope = {
      settings: settings({ globalOn: false, updatedAt: 7 }),
      version: 1,
      serverUpdatedAt: "not a date",
      lastWriteId: null,
    };
    const { cache, svc, writes } = mergeService(
      settings({ globalOn: true, updatedAt: SERVER_MS + 1_000 }),
      cloud,
    );
    await cache.hydrate();
    await svc.onSignedIn(USER);
    expect(cache.current().globalOn).toBe(false);
    expect(writes.length).toBe(0);
  });

  it("merge, a newer local edit belonging to a DIFFERENT person: the account still wins", async () => {
    // The shared-machine rule outranks the merge rule. These settings may be the previous user's,
    // so they never travel into this account no matter how recent they are.
    const cloud = envelopeStampedAt(settings({ globalOn: false, updatedAt: 7 }), SERVER_MS);
    const cache = makeCache(settings({ globalOn: true, updatedAt: SERVER_MS + 1_000 }));
    await cache.hydrate();
    const backend = mockBackend({ entitled: false, cloud });
    const svc = new SyncService(
      cache,
      mockAuth().auth,
      backend.backend,
      undefined,
      identityStore(OTHER_USER).store,
      () => DEVICE_NOW,
    );
    await svc.onSignedIn(USER);
    expect(cache.current().globalOn).toBe(false);
    expect(backend.writes.length).toBe(0);
  });

  // ── onEntitlementConfirmed: mirror-on-unlock without a second reconcile (Codex-1 fix) ────────────

  it("an entitlement landing after sign-in costs no second cloud mirror and no reconcile", async () => {
    // The mirror now runs at sign-in for everyone, so by the time an entitlement is confirmed the
    // settings are already syncing. What still matters is that confirming it re-arms rather than
    // repeating work, and that it never spends a second purchase-service query.
    const cache = makeCache(settings({ globalOn: false, updatedAt: 9_000 }));
    await cache.hydrate();
    const d = mockBackend({ entitled: false }); // signed in owning nothing
    const svc = new SyncService(cache, mockAuth().auth, d.backend);
    await svc.onSignedIn(USER);
    expect(svc.getState()).toMatchObject({ entitled: false, syncing: true });
    d.calls.length = 0; // watch only what the unlock does

    await svc.onEntitlementConfirmed(USER, true); // the web purchase lands
    expect(d.calls).not.toContain("readProfile"); // already mirrored at sign-in
    expect(d.calls).not.toContain("reconcile"); // and never a second purchase-service query
    expect(svc.getState()).toMatchObject({ entitled: true, syncing: true });
  });

  it("an entitled buyer's later local edit reaches the cloud after the unlock mirror", async () => {
    const cache = makeCache();
    await cache.hydrate();
    const d = mockBackend({ entitled: false, cloud: null });
    const svc = new SyncService(cache, mockAuth().auth, d.backend);
    await svc.onSignedIn(USER); // free
    await svc.onEntitlementConfirmed(USER, true); // buys → write-through armed
    d.calls.length = 0;
    await cache.setGlobalOn(false); // a settings edit
    await Promise.resolve();
    expect(d.calls).toContain("writeProfile");
  });

  it("already syncing for the same user → re-arm only, no redundant mirror-down", async () => {
    const cache = makeCache();
    await cache.hydrate();
    const d = mockBackend({ entitled: true });
    const svc = new SyncService(cache, mockAuth().auth, d.backend);
    await svc.onSignedIn(USER); // already entitled + syncing
    d.calls.length = 0;
    await svc.onEntitlementConfirmed(USER, true);
    expect(d.calls).not.toContain("readProfile"); // steady state: no per-reconcile mirror
    expect(svc.getState().syncing).toBe(true);
  });

  it("a false answer no longer stops sync, and still counts as CONFIRMED", async () => {
    const cache = makeCache();
    await cache.hydrate();
    const d = mockBackend({ entitled: true });
    const svc = new SyncService(cache, mockAuth().auth, d.backend);
    await svc.onSignedIn(USER);
    await svc.onEntitlementConfirmed(USER, false);
    // confirmed:true is load-bearing: the caller's reconcile settled the answer, so hosts may
    // stamp the entitled:false into native records (a plain resume() would be confirmed:false).
    // syncing stays true because losing an entitlement no longer costs anyone their settings sync.
    expect(svc.getState()).toMatchObject({ entitled: false, syncing: true, confirmed: true });
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
    expect(states.at(-1)).toEqual({ userId: null, entitled: false, syncing: false, cloudReachable: true, confirmed: true });
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
    expect(svc.getState()).toEqual({ userId: null, entitled: false, syncing: false, cloudReachable: true, confirmed: true });
  });
});
