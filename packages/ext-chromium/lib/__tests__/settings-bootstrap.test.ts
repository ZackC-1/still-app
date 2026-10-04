import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  type SettingsV2,
} from "@still/shared-types";
import {
  boundary,
  KEY,
  start,
  retainedDnrRecord,
  dnrUpdate,
  expectDnr,
} from "./settings-bootstrap.fixtures.js";

describe("maintained background DNR settings gate", () => {
  it.each([
    { name: "global Off", globalOn: false, youtube: true, enabled: false },
    { name: "YouTube Off", globalOn: true, youtube: false, enabled: false },
    { name: "enabled", globalOn: true, youtube: true, enabled: true },
  ])(
    "ordinary $name wake follows retained modern choices without rewriting them",
    async ({ globalOn, youtube, enabled }) => {
      const retained = retainedDnrRecord(globalOn, youtube);
      const before = JSON.stringify(retained);
      const update = dnrUpdate();
      const h = await start({ [KEY]: retained }, update);
      expectDnr(update, enabled);
      expect(JSON.stringify(h.store[KEY])).toBe(before);
      expect(h.writes.filter((write) => Object.hasOwn(write, KEY))).toEqual([]);
      expect(boundary.installed).not.toHaveBeenCalled();
      expect(boundary.sessionDeps).toBeNull();
      expect(boundary.sdkStorage).toBeNull();
    },
  );

  it("readable legacy Off choices migrate with unknown ownership and disable DNR", async () => {
    const update = dnrUpdate();
    const h = await start(
      {
        [KEY]: {
          settings: {
            ...DEFAULT_SETTINGS,
            globalOn: false,
            services: {
              ...DEFAULT_SETTINGS.services,
              youtube: false,
              instagram: false,
            },
            updatedAt: 42,
            opaque: { retained: true },
          },
          syncMetadata: null,
          opaqueRoot: 17,
        },
      },
      update,
    );
    expectDnr(update, false);
    expect(h.store[KEY]).toMatchObject({
      settings: {
        schemaVersion: 2,
        globalOn: false,
        services: {
          youtube: false,
          instagram: false,
          tiktok: true,
          facebook: true,
        },
        opaque: { retained: true },
      },
      atomic: { ownership: "unknown" },
      opaqueRoot: 17,
    });
    expect(h.writes.filter((write) => Object.hasOwn(write, KEY))).toHaveLength(
      1,
    );
  });

  it("actual broker commits and storage notifications change DNR without erasing saved choices", async () => {
    const retained = retainedDnrRecord(true, true);
    const update = dnrUpdate();
    const h = await start({ [KEY]: retained }, update);
    expectDnr(update, true);
    const independent = {
      instagram: retained.settings.services.instagram,
      facebook: retained.settings.services.facebook,
      tiktok: retained.settings.services.tiktok,
      opaque: retained.settings.services.opaque,
    };
    for (const [index, [path, value, enabled]] of (
      [
        ["services.youtube", false, false],
        ["globalOn", false, false],
        ["services.youtube", true, false],
        ["globalOn", true, true],
      ] as const
    ).entries()) {
      update.mockClear();
      expect(
        await h.message({
          kind: "still:settings-intent",
          path,
          value,
          updatedAt: 50 + index,
        }),
      ).toMatchObject({
        status: "committed",
        record: { intentCommitted: true },
      });
      await h.settle();
      expectDnr(update, enabled);
      expect(h.store[KEY]).toMatchObject({
        settings: {
          services: independent,
          sites: retained.settings.sites,
          opaque: { retained: true },
        },
        atomic: { sequence: 8 + index, ownership: "unknown" },
        opaqueRoot: { retained: 17 },
      });
    }
    expect((h.store[KEY] as typeof retained).atomic.pending).toEqual(retained.atomic.pending);
    expect(h.store[KEY]).toMatchObject({
      settings: { globalOn: true, services: { youtube: true } },
      atomic: {
        pending: retained.atomic!.pending,
      },
    });
  });

  it.each(["startup", "committed edit"] as const)(
    "rejected DNR update on %s is caught as a held initialization",
    async (phase) => {
      const warning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const retained = retainedDnrRecord(true, true);
        const update = dnrUpdate();
        const rejection = new Error("DNR update unavailable");
        if (phase === "startup") update.mockRejectedValue(rejection);
        const h = await start({ [KEY]: retained }, update);
        if (phase === "committed edit") {
          update.mockClear();
          update.mockRejectedValue(rejection);
          expect(
            await h.message({
              kind: "still:settings-intent",
              path: "services.youtube",
              value: false,
              updatedAt: 50,
            }),
          ).toMatchObject({ status: "committed" });
          await h.settle();
          expectDnr(update, false);
          expect(h.store[KEY]).toMatchObject({
            settings: {
              globalOn: true,
              services: { youtube: false, instagram: false, facebook: false },
            },
            atomic: { sequence: 8, ownership: "unknown" },
          });
        } else {
          expectDnr(update, true);
          expect(JSON.stringify(h.store[KEY])).toBe(JSON.stringify(retained));
          expect(h.writes.filter((write) => Object.hasOwn(write, KEY))).toEqual(
            [],
          );
        }
        expect(warning).toHaveBeenCalled();
        for (const args of warning.mock.calls)
          expect(args).toEqual([
            "Still settings initialization held",
            "storage-unavailable",
          ]);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        warning.mockRestore();
      }
    },
  );
});

describe("maintained background settings bootstrap", () => {
  it("a real first-install event publishes modern never-linked settings once", async () => {
    const h = await start();
    expect(h.installed).toHaveLength(1);
    expect(h.store[KEY]).toBeUndefined();
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(h.store[KEY]).toMatchObject({
      settings: {
        schemaVersion: 2,
        globalOn: true,
        services: {
          youtube: true,
          instagram: true,
          tiktok: true,
          facebook: true,
        },
      },
      atomic: {
        format: 1,
        sequence: 0,
        ownership: "never-linked",
        scope: { accountId: null, generation: 0 },
        pending: [],
        held: {},
        paused: null,
      },
    });
    const modern = (h.store[KEY] as { settings: SettingsV2 }).settings;
    for (const feature of FEATURE_REGISTRY)
      expect(modern.sites[feature.id]).toBe(feature.tier === "free");
    expect(
      Object.values(modern.clocks).every(
        (clock) => clock.baseRevision === 0 && clock.localStep === 0,
      ),
    ).toBe(true);
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(h.writes.filter((write) => Object.hasOwn(write, KEY))).toHaveLength(
      1,
    );
    expect(boundary.installed).toHaveBeenCalledTimes(2);
  });
  it.each(["update", "chrome_update"] as const)(
    "%s and ordinary wakes never seed absent settings",
    async (reason) => {
      const h = await start();
      h.installed[0]!({ reason });
      await h.settle();
      expect(Object.hasOwn(h.store, KEY)).toBe(false);
      expect(h.writes.filter((write) => Object.hasOwn(write, KEY))).toEqual([]);
      expect(boundary.installed).toHaveBeenCalledWith({ reason });
    },
  );
  it.each([
    [KEY, null],
    [KEY, { damaged: true }],
    [KEY, { settings: { ...DEFAULT_SETTINGS, schemaVersion: 99 } }],
    ["still:auth", null],
    ["still:auth", "retained-session"],
    ["still:auth-code-verifier", "verifier"],
    ["still:last-identity", null],
    ["still:last-identity", "old-account"],
    ["still:entitlement", { entitled: false }],
    ["still:pending-otp", null],
    ["still:checkout-pending", { damaged: true }],
    ["still:nudge-stamp", 0],
  ])(
    "raw retained slot %s denies fresh admission without rewriting it (%j)",
    async (key, value) => {
      const h = await start({ [key as string]: value });
      const before = JSON.stringify(h.store);
      const writes = h.writes.length;
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(JSON.stringify(h.store)).toBe(before);
      expect(h.writes).toHaveLength(writes);
    },
  );
  it("readable retained legacy Off/custom choices migrate with unknown ownership", async () => {
    const h = await start({
      [KEY]: {
        settings: {
          ...DEFAULT_SETTINGS,
          globalOn: false,
          services: {
            ...DEFAULT_SETTINGS.services,
            youtube: false,
            opaque: false,
          },
          updatedAt: 42,
          opaque: { retained: true },
        },
        syncMetadata: null,
        opaqueRoot: 17,
      },
    });
    expect(h.store[KEY]).toMatchObject({
      settings: {
        schemaVersion: 2,
        globalOn: false,
        services: { youtube: false, opaque: false },
        opaque: { retained: true },
      },
      atomic: { ownership: "unknown" },
      opaqueRoot: 17,
    });
    const before = JSON.stringify(h.store);
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(JSON.stringify(h.store)).toBe(before);
  });
  it.each(["read", "write"] as const)(
    "failed %s holds absent storage without success or an unhandled rejection",
    async (operation) => {
      const h = await start();
      if (operation === "read") h.failRead();
      else h.failSettingsWrite();
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(Object.hasOwn(h.store, KEY)).toBe(false);
      expect(h.writes.filter((write) => Object.hasOwn(write, KEY))).toEqual([]);
    },
  );
  it("runtime payloads cannot manufacture installation provenance", async () => {
    const h = await start();
    expect(
      await h.message({ kind: "still:settings-install", reason: "install" }),
    ).toBeUndefined();
    expect(
      await h.message(
        { kind: "still:settings-install", reason: "install" },
        "https://youtube.com/",
      ),
    ).toBeUndefined();
    expect(Object.hasOwn(h.store, KEY)).toBe(false);
  });
  it("actual broker edits after install preserve independent choices and allocate durable intent", async () => {
    const h = await start();
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(
      await h.message({
        kind: "still:settings-intent",
        path: "globalOn",
        value: false,
        updatedAt: 10,
      }),
    ).toMatchObject({ status: "committed" });
    expect(
      await h.message({
        kind: "still:settings-intent",
        path: "services.youtube",
        value: false,
        updatedAt: 11,
      }),
    ).toMatchObject({ status: "committed" });
    expect(h.store[KEY]).toMatchObject({
      settings: {
        globalOn: false,
        services: { youtube: false, instagram: true },
      },
      atomic: {
        sequence: 2,
        pending: [
          { operations: [{ path: "globalOn", value: false }] },
          { operations: [{ path: "services.youtube", value: false }] },
        ],
      },
    });
    const before = JSON.stringify(h.store[KEY]);
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(JSON.stringify(h.store[KEY])).toBe(before);
  });
  it.each([
    "auth",
    "identity",
    "pendingOtp",
    "checkoutPending",
    "nudgeStamp",
    "entitlement",
  ] as const)(
    "queued maintained %s persistence is observed before fresh admission",
    async (port) => {
      vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
      vi.stubEnv("VITE_SUPABASE_ANON_KEY", "public-test-key");
      const h = await start();
      const deps = boundary.sessionDeps!;
      const key = {
        auth: "still:auth",
        identity: "still:last-identity",
        pendingOtp: "still:pending-otp",
        checkoutPending: "still:checkout-pending",
        nudgeStamp: "still:nudge-stamp",
        entitlement: "still:entitlement",
      }[port];
      const held = h.gateWrite(key);
      const mutation =
        port === "auth"
          ? boundary.sdkStorage!.setItem(key, "session")
          : port === "identity"
            ? deps.identity!.set("old-account")
            : port === "entitlement"
              ? deps.records.setRecord({ entitled: false, updatedAt: 42 })
              : deps.stores[port].set({ retained: true } as never);
      let publishedWhileHeld: boolean;
      try {
        await held.started;
        h.installed[0]!({ reason: "install" });
        await h.settle();
        publishedWhileHeld = Object.hasOwn(h.store, KEY);
      } finally {
        held.release();
      }
      await mutation;
      expect(publishedWhileHeld).toBe(false);
      await h.settle();
      expect(Object.hasOwn(h.store, key)).toBe(true);
      expect(Object.hasOwn(h.store, KEY)).toBe(false);
    },
  );

  it.each(["removed", "failed"] as const)(
    "%s SDK account writes retain an admission hold in the live install owner",
    async (operation) => {
      vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
      vi.stubEnv("VITE_SUPABASE_ANON_KEY", "public-test-key");
      const h = await start();
      if (operation === "removed")
        await boundary.sdkStorage!.removeItem("still:auth");
      else {
        h.failAuthWrite();
        await boundary.sdkStorage!.setItem("still:auth", "attempted-session");
      }
      expect(Object.hasOwn(h.store, "still:auth")).toBe(false);
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(Object.hasOwn(h.store, KEY)).toBe(false);
    },
  );
  it("legacy entitlement runtime writes are fenced before fresh initialization", async () => {
    const h = await start();
    const held = h.gateWrite("still:entitlement");
    const mutation = h.message({
      kind: "setEntitlementRecord",
      record: { entitled: false, updatedAt: 42 },
    });
    await held.started;
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(Object.hasOwn(h.store, KEY)).toBe(false);
    held.release();
    await mutation;
    await h.settle();
    expect(h.store["still:entitlement"]).toBeDefined();
    expect(Object.hasOwn(h.store, KEY)).toBe(false);
  });
});

// The real background/cache consumes persisted feature choices; the DNR browser port is observed.
describe("maintained background DNR free-core choice", () => {
  it.each([
    { globalOn: true, youtube: true, shorts: false, enabled: false },
    { globalOn: true, youtube: true, shorts: true, enabled: true },
    { globalOn: false, youtube: true, shorts: true, enabled: false },
    { globalOn: true, youtube: false, shorts: true, enabled: false },
    { globalOn: false, youtube: false, shorts: true, enabled: false },
    { globalOn: false, youtube: true, shorts: false, enabled: false },
    { globalOn: true, youtube: false, shorts: false, enabled: false },
    { globalOn: false, youtube: false, shorts: false, enabled: false },
  ])(
    "retained master=$globalOn service=$youtube core=$shorts produces DNR=$enabled",
    async ({ globalOn, youtube, shorts, enabled }) => {
      const original = retainedDnrRecord(globalOn, youtube);
      const retained = {
        ...original,
        settings: {
          ...original.settings,
          sites: {
            ...original.settings.sites,
            "youtube.shorts": shorts,
            "youtube.comments": true,
            "unknown.core": true,
          },
        },
      };
      const before = JSON.stringify(retained);
      const update = dnrUpdate();
      const h = await start({ [KEY]: retained }, update);
      expectDnr(update, enabled);
      expect(JSON.stringify(h.store[KEY])).toBe(before);
      expect(h.writes.filter((write) => Object.hasOwn(write, KEY))).toEqual([]);
      expect(boundary.sessionDeps).toBeNull();
    },
  );

  it("broker commits and storage events disable then enable DNR with core Off then On", async () => {
    const retained = retainedDnrRecord(true, true);
    const update = dnrUpdate();
    const h = await start({ [KEY]: retained }, update);
    expectDnr(update, true);
    for (const [index, value] of [false, true].entries()) {
      update.mockClear();
      expect(
        await h.message({
          kind: "still:settings-intent",
          path: "sites.youtube.shorts",
          value,
          updatedAt: 50 + index,
        }),
      ).toMatchObject({
        status: "committed",
        record: { intentCommitted: true },
      });
      await h.settle();
      expectDnr(update, value);
      expect(h.store[KEY]).toMatchObject({
        settings: {
          globalOn: true,
          services: retained.settings.services,
          sites: { ...retained.settings.sites, "youtube.shorts": value },
          opaque: { retained: true },
        },
        atomic: { sequence: 8 + index, ownership: "unknown" },
        opaqueRoot: { retained: 17 },
      });
    }
    expect(h.store[KEY]).toMatchObject({
      // Retained local-only edits preserve the existing journal; they mint no cloud requests.
      atomic: { pending: retained.atomic.pending },
    });
  });
});
