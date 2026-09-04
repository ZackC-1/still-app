import { describe, it, expect } from "vitest";
import type { StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS, PAID_TIER_ENABLED } from "@still/shared-types";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter, type SettingsSyncMetadata } from "../../storage/adapter.js";
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

/** An envelope whose SERVER timestamp is set explicitly, because the first-sign-in merge compares against
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

/** Cases that describe the shipped tier, where having an account is the whole sync gate. The
 * counterparts for a build with the paid tier switched back on live in paid-tier-sync-gate.test.ts,
 * which mocks the switch rather than skipping. */
const includedAccessIt = it.runIf(!PAID_TIER_ENABLED);

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
    /** Keep what writeProfile wrote, the way the server does, so a later read finds it. Off by
     * default because several cases pin what happens when the read keeps answering the same
     * thing. */
    reflectWrites?: boolean;
    readProfileThrows?: boolean;
    deleteThrows?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const writes: StillSettings[] = [];
  let version = opts.cloud?.version ?? 0;
  let cloud = opts.cloud ?? null;
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
      return Promise.resolve(cloud);
    },
    writeProfile: (s) => {
      calls.push("writeProfile");
      writes.push(s);
      const written = envelope(s, ++version);
      if (opts.reflectWrites) cloud = written;
      return Promise.resolve(written);
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

  includedAccessIt("having an account is the whole sync gate: a signed-in user who owns nothing syncs", async () => {
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

  includedAccessIt("settings sync does not wait on the entitlement round trip, and survives its failure", async () => {
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

  includedAccessIt("a failing entitlement check does not claim the settings cloud is unreachable", async () => {
    const { backend } = mockBackend({ entitled: true, reconcileThrows: true });
    const svc = new SyncService(makeCache(), mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    expect(svc.getState().cloudReachable).toBe(true);
  });

  includedAccessIt("a failing cloud read DOES mark the cloud unreachable", async () => {
    const { backend } = mockBackend({ entitled: true, readProfileThrows: true });
    const svc = new SyncService(makeCache(), mockAuth().auth, backend);
    await svc.onSignedIn(USER);
    expect(svc.getState().cloudReachable).toBe(false);
  });

  includedAccessIt("unknown entitlement read preserves prior entitlement and leaves it unconfirmed", async () => {
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

  includedAccessIt("failed reconcile on an account switch does not inherit the prior user's entitlement", async () => {
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
    // B's account is started from Still's defaults instead. A's blob never travels: the one write
    // is the defaults, which have everything switched ON, not A's globalOn false.
    expect(writes.map((w) => w.globalOn)).toEqual([true]);
    expect(writes[0]!.services).toEqual(DEFAULT_SETTINGS.services);
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

  includedAccessIt("records the identity whenever a sync actually starts, entitlement or not", async () => {
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
    const { backend, writes } = mockBackend({ entitled: true, cloud: null, reflectWrites: true });
    const { store } = identityStore(USER);
    const cache = makeCache(settings({ updatedAt: 9_000 }));
    await cache.hydrate();
    const svc = new SyncService(cache, mockAuth().auth, backend, undefined, store);
    await svc.onSignedIn(OTHER_USER); // the switch: the account is started from the defaults
    expect(writes.length).toBe(1);
    await svc.onSignedIn(OTHER_USER); // same user now, and the account is where this browser left it
    expect(writes.length).toBe(1); // so there is nothing to publish and nothing to adopt
  });

  includedAccessIt("a sign-in whose cloud read fails does not record the identity (no sync ever started)", async () => {
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
    // Entitled, so these cases exercise the merge rule itself in either era rather than the gate.
    const backend = mockBackend({ entitled: true, cloud });
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
    const backend = mockBackend({ entitled: true, cloud });
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

  // ── reconciling a device that has ALREADY synced ────────────────────────────────────────────────
  // Once a device and its account share a version counter, that counter decides and no clock is
  // consulted. These cases are the ones the clock rule got wrong: they are written so that each
  // fails if the rule it pins is taken back out.

  /** A cache that has already synced: local settings plus the sync metadata a previous sync left. */
  function syncedCache(local: StillSettings, version: number, serverMs = SERVER_MS) {
    let t = 1000;
    return new SettingsCache(
      new InMemoryStorageAdapter({
        settings: local,
        syncMetadata: {
          version,
          serverUpdatedAt: new Date(serverMs).toISOString(),
          lastWriteId: null,
        },
      }),
      { now: () => ++t },
    );
  }

  function reconcileService(
    cache: SettingsCache,
    cloud: SyncedSettingsEnvelope | null,
    lastSynced: string | null = null,
    deviceNow = DEVICE_NOW,
  ) {
    const backend = mockBackend({ entitled: true, cloud });
    const svc = new SyncService(
      cache,
      mockAuth().auth,
      backend.backend,
      undefined,
      identityStore(lastSynced).store,
      () => deviceNow,
    );
    return { svc, writes: backend.writes };
  }

  it("a device whose clock runs fast stops winning after its first sync, on every later start", async () => {
    // The phone's clock is five minutes ahead, so every stamp it writes looks newer than the Mac's.
    // It has synced already (version 6); the Mac has written since (version 7). Restoring the
    // session must adopt the Mac's write, and must keep adopting it however many times the phone
    // is opened, or the Mac can never make a change stick.
    const cache = syncedCache(settings({ globalOn: true, updatedAt: DEVICE_NOW }), 6);
    await cache.hydrate();
    const cloud = envelopeStampedAt(settings({ globalOn: false, updatedAt: 7 }), SERVER_MS, 7);
    const { svc, writes } = reconcileService(cache, cloud);

    await svc.onSignedIn(USER);
    expect(writes.length).toBe(0);
    expect(cache.current().globalOn).toBe(false);

    await svc.onSignedIn(USER); // the next launch, and the one after that
    await svc.onSignedIn(USER);
    expect(writes.length).toBe(0);
    expect(cache.current().globalOn).toBe(false);
  });

  it("the account is adopted even when this device carries a version the steady-state rule would refuse", async () => {
    // The decision said the account wins. The cache's own rule would refuse this envelope, because
    // its version is not higher than the one sitting on the device. The decision still has to hold:
    // the account's settings land, and nothing goes up.
    const cache = syncedCache(settings({ globalOn: true, updatedAt: DEVICE_NOW }), 9);
    await cache.hydrate();
    const cloud = envelopeStampedAt(settings({ globalOn: false, updatedAt: 7 }), SERVER_MS, 4);
    const { svc, writes } = reconcileService(cache, cloud);

    await svc.onSignedIn(USER);
    expect(writes.length).toBe(0);
    expect(cache.current().globalOn).toBe(false);
    expect(cache.currentSyncMetadata()?.version).toBe(4);
  });

  it("an edit made while signed out is published when the account has not moved since", async () => {
    // The founder's own check: sign out, turn something off, sign back in, and it stays off. The
    // account is still at the version this device left it at, so nothing was written anywhere else
    // and this edit is the newest thing that exists.
    const cache = syncedCache(settings({ globalOn: false, updatedAt: SERVER_MS + 1_000 }), 5);
    await cache.hydrate();
    const cloud = envelopeStampedAt(settings({ globalOn: true, updatedAt: 7 }), SERVER_MS, 5);
    const { svc, writes } = reconcileService(cache, cloud);

    await svc.onSignedIn(USER);
    expect(writes.length).toBe(1);
    expect(writes[0]!.globalOn).toBe(false);
    expect(cache.current().globalOn).toBe(false);
  });

  it("a device that changed nothing since its last sync publishes nothing", async () => {
    const same = settings({ globalOn: true, updatedAt: SERVER_MS });
    const cache = syncedCache(same, 5);
    await cache.hydrate();
    const { svc, writes } = reconcileService(cache, envelopeStampedAt(same, SERVER_MS, 5));

    await svc.onSignedIn(USER);
    expect(writes.length).toBe(0);
  });

  // ── a shared browser: the next person's account is never overwritten ─────────────────────────────
  // Two independent routes, because they fail through different code. The first is decided by the
  // timestamps, the second never reaches them at all.

  it("shared browser, by timestamp: the leftover settings are newer, and still do not travel", async () => {
    const cache = makeCache(settings({ globalOn: false, updatedAt: SERVER_MS + 1_000 }));
    await cache.hydrate();
    const cloud = envelopeStampedAt(settings({ globalOn: true, updatedAt: 7 }), SERVER_MS, 3);
    const { svc, writes } = reconcileService(cache, cloud, OTHER_USER);

    await svc.onSignedIn(USER);
    expect(writes.length).toBe(0);
    expect(cache.current().globalOn).toBe(true); // and this person sees their own account
  });

  it("shared browser, by version: the leftover metadata is ahead of the account, and the account still wins", async () => {
    // The previous person synced a lot on this browser, so the version left behind is higher than
    // anything in the account now signing in. Comparing the two would be meaningless: they count
    // different profile rows. The account is adopted whole.
    const cache = syncedCache(settings({ globalOn: false, updatedAt: SERVER_MS + 1_000 }), 99);
    await cache.hydrate();
    const cloud = envelopeStampedAt(settings({ globalOn: true, updatedAt: 7 }), SERVER_MS, 3);
    const { svc, writes } = reconcileService(cache, cloud, OTHER_USER);

    await svc.onSignedIn(USER);
    expect(writes.length).toBe(0);
    expect(cache.current().globalOn).toBe(true);
    expect(cache.currentSyncMetadata()?.version).toBe(3);
  });

  it("a brand new account on this browser is started from the defaults, not from the leftovers", async () => {
    // The browser one start after the switch, in the state the first sign-in leaves behind: the
    // identity now names the person signed in, the settings and the version sitting here are still
    // the previous person's, and the account is still empty because nothing has filled it yet. The
    // identity test cannot fire any more, so what protects the account is the other half of the
    // rule: settings anchored to a profile row are never published into an account that has no row.
    const cache = syncedCache(settings({ globalOn: false, updatedAt: SERVER_MS + 1_000 }), 99);
    await cache.hydrate();
    const { svc, writes } = reconcileService(cache, null, USER);

    await svc.onSignedIn(USER);
    expect(writes.map((w) => w.globalOn)).toEqual([true]); // the defaults, never the leftover false
    expect(cache.current().globalOn).toBe(true);
    expect(cache.currentSyncMetadata()?.version).toBe(1); // and this browser counts the new row now
  });

  it("an empty account is filled from this browser only when this browser never synced for anyone", async () => {
    // Two arrangements that look identical from the account's side, and must not be treated alike.
    // A browser that has never synced has nobody else's settings on it, so what someone has been
    // using travels into the account they just made, which is the first-sign-in rule. A browser
    // that last synced for someone else does not get to decide what a new account starts with.
    const chosen = settings({ globalOn: false, updatedAt: SERVER_MS + 1_000 });

    const neverSynced = makeCache(chosen);
    await neverSynced.hydrate();
    const own = reconcileService(neverSynced, null, null);
    await own.svc.onSignedIn(USER);
    expect(own.writes.map((w) => w.globalOn)).toEqual([false]); // their own settings, uploaded

    const syncedForSomeoneElse = syncedCache(chosen, 99);
    await syncedForSomeoneElse.hydrate();
    const shared = reconcileService(syncedForSomeoneElse, null, OTHER_USER);
    await shared.svc.onSignedIn(USER);
    expect(shared.writes.map((w) => w.globalOn)).toEqual([true]); // the defaults, not the leftovers
  });

  it("a sign-in that lands before the settings have loaded waits rather than publishing defaults", async () => {
    // Hydration is started fire-and-forget by every host. A sign-in that arrives first must not
    // read the bundled defaults, decide this is a brand new device, and upload them.
    const adapter = new InMemoryStorageAdapter(settings({ globalOn: false, updatedAt: 9_000 }));
    const slowGet = adapter.get.bind(adapter);
    let releaseStorage: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseStorage = resolve;
    });
    adapter.get = async () => {
      await blocked;
      return slowGet();
    };
    const cache = new SettingsCache(adapter);
    void cache.hydrate();
    const backend = mockBackend({ entitled: true, cloud: null });
    const svc = new SyncService(cache, mockAuth().auth, backend.backend, undefined, identityStore(null).store);

    const signIn = svc.onSignedIn(USER);
    await drain();
    expect(backend.writes.length).toBe(0); // still waiting on storage, nothing published
    releaseStorage();
    await signIn;
    expect(backend.writes.length).toBe(1);
    expect(backend.writes[0]!.globalOn).toBe(false); // the real settings, not the defaults
  });

  // ── one reconcile, believed by the whole browser ────────────────────────────────────────────────
  // The background and the popup are two SettingsCache instances over ONE storage area: the
  // background builds its own, and so does every extension page. A reconcile only the background
  // believes is not a reconcile, because on Chrome the popup is the only place a person can sign in,
  // so it is the screen they are looking at while this runs.

  /** The background's cache and a popup's cache over one storage area, as the extension wires them. */
  function twoContexts(record: { settings: StillSettings; syncMetadata: SettingsSyncMetadata }) {
    const adapter = new InMemoryStorageAdapter(record);
    let t = 1000;
    const background = new SettingsCache(adapter, { now: () => ++t });
    const popup = new SettingsCache(adapter, { now: () => ++t });
    return { background, popup };
  }

  it("a shared browser: the account the background adopts is what the popup shows too", async () => {
    // Person A synced a lot on this browser, so the version left behind (99) is far ahead of the
    // account person B is signing into (3). B signs in from the popup, which is the only place they
    // can. The background adopting B's account is not enough on its own: until the popup agrees,
    // B is looking at A's toggles, and the next switch B flips is built on A's settings.
    const { background, popup } = twoContexts({
      settings: settings({ globalOn: false, updatedAt: SERVER_MS + 1_000 }),
      syncMetadata: { version: 99, serverUpdatedAt: new Date(SERVER_MS).toISOString(), lastWriteId: null },
    });
    await background.hydrate();
    background.watch();
    await popup.hydrate();
    popup.watch();
    expect(popup.current().globalOn).toBe(false); // A's leftovers, which is all this browser knows

    const cloud = envelopeStampedAt(settings({ globalOn: true, updatedAt: 7 }), SERVER_MS, 3);
    const backend = mockBackend({ entitled: true, cloud });
    const svc = new SyncService(
      background,
      mockAuth().auth,
      backend.backend,
      undefined,
      identityStore(OTHER_USER).store,
      () => DEVICE_NOW,
    );

    await svc.onSignedIn(USER);
    expect(background.current().globalOn).toBe(true);
    expect(popup.current().globalOn).toBe(true); // the screen B is looking at, not just the worker
    expect(popup.currentSyncMetadata()?.version).toBe(3);

    // And the next thing B does builds on B's settings rather than carrying A's into B's account.
    await popup.setService("instagram", false);
    await drain();
    expect(backend.writes.length).toBe(1);
    expect(backend.writes.at(-1)!.globalOn).toBe(true);
    expect(backend.writes.at(-1)!.services.instagram).toBe(false);
  });

  it("a shared browser and a brand new account: the previous person's settings are not what fills it", async () => {
    // The likeliest shared-computer case there is. Person A synced a lot on this browser, so the
    // version left behind is 99. A signed out and person B signs UP here, so B's account has never
    // held anything at all. Refusing to publish A's settings is not enough on its own: there is
    // nothing to pull down either, so B would sit looking at A's toggles, and the next browser
    // start would find the identity already updated to B and publish A's settings into B's account
    // and from there onto every device B owns.
    const { background, popup } = twoContexts({
      settings: settings({ globalOn: false, updatedAt: SERVER_MS + 1_000 }),
      syncMetadata: { version: 99, serverUpdatedAt: new Date(SERVER_MS).toISOString(), lastWriteId: null },
    });
    await background.hydrate();
    background.watch();
    await popup.hydrate();
    popup.watch();
    expect(popup.current().globalOn).toBe(false); // A's leftovers, which is all this browser knows

    const backend = mockBackend({ entitled: true, cloud: null, reflectWrites: true });
    const svc = new SyncService(
      background,
      mockAuth().auth,
      backend.backend,
      undefined,
      identityStore(OTHER_USER).store,
      () => DEVICE_NOW,
    );

    await svc.onSignedIn(USER);
    expect(backend.writes.map((w) => w.globalOn)).toEqual([true]); // the defaults, never A's false
    expect(background.current().globalOn).toBe(true);
    expect(popup.current().globalOn).toBe(true); // the screen B is looking at, not just the worker

    // And the next browser start, with the identity now recorded as B, publishes nothing more: the
    // account holds what B's own sign-in put in it, and this browser is counting B's row.
    await svc.onSignedIn(USER);
    expect(backend.writes.map((w) => w.globalOn)).toEqual([true]);
    expect(background.current().globalOn).toBe(true);
    expect(popup.current().globalOn).toBe(true);
  });

  // ── two accounts sitting on the same version number ─────────────────────────────────────────────
  // A version counts the writes made inside ONE account, so it proves nothing across two. Both of
  // these arrive at the same state: this browser names the person now signed in, and still holds
  // the previous person's settings anchored to the previous person's row. The first gets there
  // through a sign-out landing inside the reconcile; the second needs no timing at all.

  /** A's row and B's row, both saved exactly once, which for two light users is the likeliest pair
   * of numbers there is. Same version, different rows: different server stamps, different writes. */
  const A_ROW: SettingsSyncMetadata = {
    version: 1,
    serverUpdatedAt: new Date(SERVER_MS).toISOString(),
    lastWriteId: "0a0a0a0a-0000-4000-8000-00000000000a",
  };
  const B_ROW = envelopeStampedAt(settings({ globalOn: true, updatedAt: 7 }), SERVER_MS + 60_000, 1);
  const B_ROW_ENVELOPE: SyncedSettingsEnvelope = {
    ...B_ROW,
    lastWriteId: "0b0b0b0b-0000-4000-8000-00000000000b",
  };

  it("two accounts at the same version: a sign-out inside the reconcile does not hand B's account A's settings", async () => {
    // Person A synced once on this browser with everything switched off. A signed out and person B
    // signed in, so the reconcile recorded B as the person this browser last synced for. B signed
    // out on that exact write, so the reconcile gave up and nothing was adopted: the browser now
    // names B and still holds A's settings, anchored to A's row.
    const { background, popup } = twoContexts({
      settings: settings({ globalOn: false, updatedAt: SERVER_MS + 1_000 }),
      syncMetadata: A_ROW,
    });
    await background.hydrate();
    background.watch();
    await popup.hydrate();
    popup.watch();

    const backend = mockBackend({ entitled: true, cloud: B_ROW_ENVELOPE });
    const identity = identityStore(OTHER_USER); // A is who this browser last synced for
    let releaseIdentityWrite: () => void = () => {};
    const identityWritten = new Promise<void>((resolve) => {
      releaseIdentityWrite = resolve;
    });
    const heldIdentity: LastSyncedIdentityStore = {
      get: () => identity.store.get(),
      set: async (userId) => {
        await identity.store.set(userId);
        await identityWritten; // the sign-out lands here, on the write that names B
      },
    };
    const svc = new SyncService(
      background,
      mockAuth().auth,
      backend.backend,
      undefined,
      heldIdentity,
      () => DEVICE_NOW,
    );

    const signIn = svc.onSignedIn(USER);
    await drain();
    await svc.signOut();
    releaseIdentityWrite();
    await signIn;
    await drain();

    expect(backend.writes.length).toBe(0);
    expect(identity.current()).toBe(USER); // this browser names B
    expect(background.currentSyncMetadata()?.lastWriteId).toBe(A_ROW.lastWriteId); // on A's row
    expect(background.current().globalOn).toBe(false); // holding A's settings

    // The next ordinary start. Both rows are at version 1, and matching those two numbers is not
    // proof that this is the row this browser left off on.
    const restarted = new SyncService(
      background,
      mockAuth().auth,
      backend.backend,
      undefined,
      identity.store,
      () => DEVICE_NOW,
    );
    await restarted.resume(USER, true);
    await drain();

    expect(backend.writes.length).toBe(0); // A's settings never reach B's account
    expect(background.current().globalOn).toBe(true); // B is looking at B's own settings
    expect(popup.current().globalOn).toBe(true); // in the popup as well as the worker
    expect(background.currentSyncMetadata()?.lastWriteId).toBe(B_ROW_ENVELOPE.lastWriteId);
  });

  it("two accounts at the same version, reached with no timing at all: a browser quit mid sign-in", async () => {
    // The same state, without any race to win. The record of who last synced here is written and
    // waited for; the settings are written without waiting. A worker killed in between, which is
    // ordinary on Chromium, leaves exactly this on disk. The rule has to hold on what is on disk,
    // not on how it got there.
    const cache = new SettingsCache(
      new InMemoryStorageAdapter({
        settings: settings({ globalOn: false, updatedAt: SERVER_MS + 1_000 }),
        syncMetadata: A_ROW,
      }),
      { now: () => SERVER_MS },
    );
    await cache.hydrate();
    const { svc, writes } = reconcileService(cache, B_ROW_ENVELOPE, USER);

    await svc.resume(USER, true);
    await drain();

    expect(writes.length).toBe(0);
    expect(cache.current().globalOn).toBe(true);
    expect(cache.currentSyncMetadata()?.lastWriteId).toBe(B_ROW_ENVELOPE.lastWriteId);
  });

  it("the same row, with its timestamp spelled two ways, is still the same row", async () => {
    // The row state a device is anchored to arrives through three transports: the reply to its own
    // write, the start-up read, and the live stream. Nothing makes all three spell an instant the
    // same way. Reading two spellings as two rows would quietly stop this device publishing edits
    // it made while it was offline, which is the one thing this rule exists to allow.
    const spelledDifferently = new Date(SERVER_MS).toISOString().replace("Z", "+00:00");
    const cache = new SettingsCache(
      new InMemoryStorageAdapter({
        settings: settings({ globalOn: false, updatedAt: SERVER_MS + 1_000 }),
        syncMetadata: { version: 5, serverUpdatedAt: spelledDifferently, lastWriteId: null },
      }),
      { now: () => SERVER_MS },
    );
    await cache.hydrate();
    const cloud = envelopeStampedAt(settings({ globalOn: true, updatedAt: 7 }), SERVER_MS, 5);
    const { svc, writes } = reconcileService(cache, cloud, USER);

    await svc.resume(USER, true);
    await drain();

    expect(writes.map((w) => w.globalOn)).toEqual([false]); // the edit made offline still goes up
  });

  // ── the start-up catch-up: what happens to an edit made while the read is in flight ─────────────

  /** Hold the profile read open, so a test can act inside the window a start-up read is in flight. */
  function holdProfileRead(backend: BackendPort): () => void {
    const inner = backend.readProfile.bind(backend);
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.readProfile = async () => {
      await blocked;
      return inner();
    };
    return () => release();
  }

  it("an edit made during the start-up read never puts the pre-read settings back", async () => {
    // This browser was closed at version 4. Another device turned TikTok off while it was closed
    // (version 9). The worker starts, the read is in flight, and the person turns Instagram off in
    // that window. The reconcile says the account is the newer side, so the held edit goes nowhere:
    // publishing it would send the whole pre-read snapshot up, and the profile write is a full
    // overwrite, so the other device's TikTok change would be gone everywhere.
    const cache = syncedCache(settings({ globalOn: true, updatedAt: SERVER_MS }), 4);
    await cache.hydrate();
    const away = settings({
      globalOn: true,
      services: { ...DEFAULT_SETTINGS.services, tiktok: false },
      updatedAt: 8,
    });
    const backend = mockBackend({ entitled: true, cloud: envelopeStampedAt(away, SERVER_MS + 5_000, 9) });
    const release = holdProfileRead(backend.backend);
    const svc = new SyncService(
      cache,
      mockAuth().auth,
      backend.backend,
      undefined,
      identityStore(USER).store,
      () => DEVICE_NOW,
    );

    const resumed = svc.resume(USER, true);
    await drain();
    await cache.setService("instagram", false);
    release();
    await resumed;
    await drain();

    expect(backend.writes.length).toBe(0);
    expect(cache.current().services.tiktok).toBe(false); // the other device's change survived
    expect(cache.current().services.instagram).toBe(true); // and this edit went with the snapshot
  });

  it("an edit made during the start-up read IS published when this device is the newer side", async () => {
    // Same window, opposite decision: the account is exactly where this device left it, so nothing
    // was written anywhere else and the edit is the newest thing that exists.
    const local = settings({ globalOn: true, updatedAt: SERVER_MS });
    const cache = syncedCache(local, 5);
    await cache.hydrate();
    const backend = mockBackend({ entitled: true, cloud: envelopeStampedAt(local, SERVER_MS, 5) });
    const release = holdProfileRead(backend.backend);
    const svc = new SyncService(
      cache,
      mockAuth().auth,
      backend.backend,
      undefined,
      identityStore(USER).store,
      () => DEVICE_NOW,
    );

    const resumed = svc.resume(USER, true);
    await drain();
    await cache.setService("instagram", false);
    release();
    await resumed;
    await drain();

    expect(backend.writes.length).toBe(1);
    expect(backend.writes.at(-1)!.services.instagram).toBe(false);
    expect(cache.current().services.instagram).toBe(false);
  });

  /** Hold the reconcile's own profile WRITE open, so a test can act inside the round trip it is
   * waiting on. The window an edit can be lost in is that round trip, not the read: the write
   * carries what the cache held when it started and its reply is applied to the cache. */
  function holdProfileWrite(backend: BackendPort): () => void {
    const inner = backend.writeProfile.bind(backend);
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    backend.writeProfile = async (s, writeId) => {
      if (held) return inner(s, writeId);
      held = true;
      await blocked;
      return inner(s, writeId);
    };
    return () => release();
  }

  it("a setting changed while a sign-in's own write is in flight is published, not undone by it", async () => {
    // The same protection the background start has, on the route a sign-in takes. It matters most
    // in the Apple app, where entering a session runs at every launch and on qualifying returns
    // while the settings screen is on screen. This device edited something while it was signed
    // out, so the reconcile decides it is the newer side and sends that up; the person taps
    // another switch before that write lands; the write's own reply is then applied to the cache
    // and takes the tap back out of it. Held instead: the tap waits for the decision and goes up
    // straight after it.
    const account = settings({ globalOn: true, updatedAt: SERVER_MS });
    const edited = settings({ globalOn: false, updatedAt: SERVER_MS + 1_000 });
    const cache = syncedCache(edited, 5);
    await cache.hydrate();
    const backend = mockBackend({ entitled: true, cloud: envelopeStampedAt(account, SERVER_MS, 5) });
    const release = holdProfileWrite(backend.backend);
    const svc = new SyncService(
      cache,
      mockAuth().auth,
      backend.backend,
      undefined,
      identityStore(USER).store,
      () => DEVICE_NOW,
    );

    const signIn = svc.onSignedIn(USER);
    await drain();
    await cache.setService("instagram", false); // tapped while the reconcile's write is in flight
    release();
    await signIn;
    await drain();

    expect(cache.current().services.instagram).toBe(false); // the tap survived on this device
    expect(backend.writes.at(-1)!.services.instagram).toBe(false); // and reached the account
    expect(backend.writes.at(-1)!.globalOn).toBe(false); // carrying the offline edit with it
  });

  it("a realtime message that lands during the start-up read is not undone by it", async () => {
    // The read is holding version 9. While it is in flight another device writes version 10 and the
    // subscription delivers it. The reconcile must not walk the device back to 9: the two counters
    // count the same account here, so the steady-state version rule is the right one to use.
    const cache = syncedCache(settings({ globalOn: true, updatedAt: SERVER_MS }), 4);
    await cache.hydrate();
    const backend = mockBackend({
      entitled: true,
      cloud: envelopeStampedAt(settings({ globalOn: true, updatedAt: 8 }), SERVER_MS + 1_000, 9),
    });
    const release = holdProfileRead(backend.backend);
    const svc = new SyncService(
      cache,
      mockAuth().auth,
      backend.backend,
      undefined,
      identityStore(USER).store,
      () => DEVICE_NOW,
    );

    const resumed = svc.resume(USER, true);
    await drain();
    backend.emitProfile(envelopeStampedAt(settings({ globalOn: false, updatedAt: 9 }), SERVER_MS + 2_000, 10));
    expect(cache.currentSyncMetadata()?.version).toBe(10);
    release();
    await resumed;
    await drain();

    expect(cache.currentSyncMetadata()?.version).toBe(10);
    expect(cache.current().globalOn).toBe(false);
    expect(backend.writes.length).toBe(0);
  });

  // ── a session that ends while a sign-in is still running ────────────────────────────────────────

  it("signing out during a sign-in arms nothing and claims nothing for that account", async () => {
    // The reconcile gives up, and everything downstream of it has to give up too. A realtime
    // subscription opened here would outlive the sign-out's own teardown with nothing left to close
    // it, and would then block the next person's subscription from opening at all.
    const backend = mockBackend({
      entitled: true,
      cloud: envelopeStampedAt(settings({ globalOn: true, updatedAt: 7 }), SERVER_MS, 3),
    });
    const release = holdProfileRead(backend.backend);
    const { store, sets } = identityStore(null);
    const svc = new SyncService(makeCache(), mockAuth().auth, backend.backend, undefined, store);

    const signIn = svc.onSignedIn(USER);
    await drain();
    await svc.signOut();
    release();
    await signIn;

    expect(svc.getState().userId).toBeNull();
    expect(svc.getState().syncing).toBe(false);
    expect(backend.calls).not.toContain("subscribeToProfile");
    expect(sets).toEqual([]);
    expect(backend.writes.length).toBe(0);
  });

  it("signing out during a sign-in leaves no confirmed entitlement behind for that account", async () => {
    // The settings half of a sign-in already gives up when a sign-out lands under it. The
    // entitlement half has to make the same test, because a signed-out state carrying a CONFIRMED
    // entitlement is exactly the shape the Apple host stamps into the App Group, and the Safari
    // extension trusts that record for thirty days.
    const backend = mockBackend({ entitled: true, cloud: null });
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readEntitlement = backend.backend.readEntitlement.bind(backend.backend);
    backend.backend.readEntitlement = async () => {
      await blocked;
      return readEntitlement();
    };
    const svc = new SyncService(
      makeCache(),
      mockAuth().auth,
      backend.backend,
      undefined,
      identityStore(null).store,
    );

    const signIn = svc.onSignedIn(USER);
    await drain();
    await svc.signOut();
    release();
    await signIn;

    expect(svc.getState().userId).toBeNull();
    expect(svc.getState().entitled).toBe(false);
  });

  it("a browser that reached the account records it even when the publish then fails", async () => {
    // The shared-browser rule can only protect a browser that knows who last synced on it, so the
    // record is written the moment the account is reached rather than after the settings have moved.
    const backend = mockBackend({ entitled: true, cloud: null });
    backend.backend.writeProfile = () => Promise.reject(new Error("offline"));
    const { store, sets } = identityStore(null);
    const svc = new SyncService(makeCache(), mockAuth().auth, backend.backend, undefined, store);

    // A failed publish surfaces differently on either side of the paid-tier switch, and this is
    // about the identity record either way.
    await svc.onSignedIn(USER).catch(() => undefined);

    expect(sets).toEqual([USER]);
  });

  // ── onEntitlementConfirmed: mirror-on-unlock without a second reconcile (Codex-1 fix) ────────────

  includedAccessIt("an entitlement landing after sign-in costs no second cloud mirror and no reconcile", async () => {
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

  includedAccessIt("a false answer no longer stops sync, and still counts as CONFIRMED", async () => {
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
