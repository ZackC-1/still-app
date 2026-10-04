import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type SettingsV2 } from "@still/shared-types";
import {
  boundary,
  KEY,
  start,
  retainedDnrRecord,
} from "./settings-bootstrap.fixtures.js";

describe("finite privileged install-event recovery", () => {
  function peerOff(h: Awaited<ReturnType<typeof start>>) {
    const record = structuredClone(h.store[KEY]) as {
      settings: SettingsV2;
      atomic: { sequence: number };
    };
    record.settings = {
      ...record.settings,
      globalOn: false,
      updatedAt: 17,
      clocks: {
        ...record.settings.clocks,
        globalOn: {
          ...record.settings.clocks.globalOn,
          localStep: record.settings.clocks.globalOn.localStep + 1,
        },
      },
    };
    record.atomic.sequence += 1;
    h.store[KEY] = record;
  }
  it.each(["rawReads", "settingsWrites"] as const)(
    "recovers one transient %s and actual broker/DNR deliberate choices",
    async (operation) => {
      const dnr = vi.fn(async () => undefined);
      const h = await start({}, dnr);
      h.retryFaults({ [operation]: 1 });
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(h.store[KEY]).toMatchObject({
        atomic: {
          ownership: "never-linked",
          sequence: 0,
          pending: [],
          scope: { accountId: null, generation: 0 },
        },
      });
      expect(h.attempts.settingsWrites).toBe(
        operation === "settingsWrites" ? 2 : 1,
      );
      expect(h.attempts.rawReads).toBe(2);
      expect(
        await h.message({
          kind: "still:settings-intent",
          path: "globalOn",
          value: false,
          updatedAt: 18,
        }),
      ).toMatchObject({ status: "committed" });
      await h.settle();
      expect(h.store[KEY]).toMatchObject({
        settings: { globalOn: false },
        atomic: { sequence: 1 },
      });
      expect(dnr).toHaveBeenLastCalledWith({
        disableRulesetIds: ["youtube-shorts-redirect"],
      });
    },
  );
  it.each([false, true])(
    "lostACK reads retained current without another write (readback transient=%s)",
    async (readbackFailure) => {
      const dnr = vi.fn(async () => undefined);
      const h = await start({}, dnr);
      h.retryFaults({
        lostAck: true,
        notify: false,
        singleReads: readbackFailure ? 1 : 0,
        afterPersist: () => peerOff(h),
      });
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(h.attempts.settingsWrites).toBe(1);
      expect(h.store[KEY]).toMatchObject({
        settings: { globalOn: false },
        atomic: { sequence: 1, pending: [] },
      });
      expect(dnr).toHaveBeenLastCalledWith({
        disableRulesetIds: ["youtube-shorts-redirect"],
      });
      const before = JSON.stringify(h.store[KEY]);
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(JSON.stringify(h.store[KEY])).toBe(before);
      expect(h.attempts.settingsWrites).toBe(1);
    },
  );
  it("successful persist retries only pure readiness reads with no watcher", async () => {
    const dnr = vi.fn(async () => undefined);
    const h = await start({}, dnr);
    h.retryFaults({
      notify: false,
      singleReads: 1,
      afterPersist: () => peerOff(h),
    });
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(h.attempts.settingsWrites).toBe(1);
    expect(h.attempts.rawReads).toBe(1);
    expect(h.attempts.singleReads).toBe(2);
    expect(dnr).toHaveBeenLastCalledWith({
      disableRulesetIds: ["youtube-shorts-redirect"],
    });
  });
  it.each(["rawReads", "settingsWrites"] as const)(
    "exhausts %s once; duplicate callbacks cannot reset",
    async (operation) => {
      const h = await start();
      h.retryFaults({ [operation]: 99 });
      h.installed[0]!({ reason: "install" });
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(Object.hasOwn(h.store, KEY)).toBe(false);
      expect(h.attempts.rawReads).toBe(3);
      expect(h.attempts.settingsWrites).toBe(
        operation === "settingsWrites" ? 3 : 0,
      );
      expect(h.attempts.singleReads).toBe(3);
      const attempts = { ...h.attempts };
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(h.attempts).toEqual(attempts);
      expect(boundary.installed).toHaveBeenCalledTimes(3);
    },
  );
  it("ambiguous exhausted lostACK reads never retry a possible persisted write", async () => {
    const h = await start();
    h.retryFaults({ lostAck: true, notify: false, singleReads: 99 });
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(h.attempts.settingsWrites).toBe(1);
    expect(h.attempts.rawReads).toBe(1);
    expect(h.attempts.singleReads).toBe(3);
    expect(h.store[KEY]).toMatchObject({
      atomic: { sequence: 0, pending: [] },
    });
  });
  it("readiness exhaustion performs three reads and never restarts fresh persistence", async () => {
    const h = await start();
    h.retryFaults({ notify: false, singleReads: 99 });
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(h.attempts).toEqual({
      rawReads: 1,
      settingsWrites: 1,
      singleReads: 3,
    });
    const before = JSON.stringify(h.store[KEY]);
    h.installed[0]!({ reason: "install" });
    await h.settle();
    expect(JSON.stringify(h.store[KEY])).toBe(before);
    expect(h.attempts).toEqual({
      rawReads: 1,
      settingsWrites: 1,
      singleReads: 3,
    });
  });
  it.each([
    null,
    { damaged: true },
    { settings: { ...DEFAULT_SETTINGS, schemaVersion: 99 } },
  ])(
    "current raw conflict appearing after failed pristine read is preserved (%j)",
    async (value) => {
      const h = await start();
      h.retryFaults({
        rawReads: 1,
        afterRawFailure: () => {
          h.store[KEY] = structuredClone(value);
        },
      });
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(h.store[KEY]).toEqual(value);
      expect(h.attempts.settingsWrites).toBe(0);
      expect(h.attempts.rawReads).toBeLessThanOrEqual(2);
    },
  );
  it("failed queued SDK auth mutation during retry gap denies fresh admission", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "public-test-key");
    const h = await start();
    let auth: Promise<unknown> | undefined;
    h.failAuthWrite();
    h.retryFaults({
      rawReads: 1,
      afterRawFailure: () => {
        auth = Promise.resolve(
          boundary.sdkStorage!.setItem("still:auth", "attempted-session"),
        );
      },
    });
    h.installed[0]!({ reason: "install" });
    await h.settle();
    await auth;
    expect(Object.hasOwn(h.store, "still:auth")).toBe(false);
    expect(Object.hasOwn(h.store, KEY)).toBe(false);
    expect(h.attempts.settingsWrites).toBe(0);
  });
});

describe("finite install retry preserves newly observed history", () => {
  it.each([
    ["still:auth", null],
    ["still:auth-code-verifier", "verifier"],
    ["still:last-identity", null],
    ["still:entitlement", { entitled: false }],
    ["still:pending-otp", null],
    ["still:checkout-pending", { damaged: true }],
    ["still:nudge-stamp", 0],
  ])(
    "raw %s appearing during failed read still denies defaults",
    async (key, value) => {
      const h = await start();
      h.retryFaults({
        rawReads: 1,
        afterRawFailure: () => {
          h.store[key as string] = structuredClone(value);
        },
      });
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(h.store[key as string]).toEqual(value);
      expect(Object.hasOwn(h.store, KEY)).toBe(false);
      expect(h.attempts.settingsWrites).toBe(0);
      expect(h.attempts.rawReads).toBe(2);
    },
  );
  it.each(["legacy", "unknown", "paused"] as const)(
    "readable peer %s during read failure is never freshly rewritten",
    async (kind) => {
      const peer =
        kind === "legacy"
          ? {
              settings: {
                ...DEFAULT_SETTINGS,
                globalOn: false,
                opaque: { kept: true },
              },
              syncMetadata: null,
              opaqueRoot: 37,
            }
          : {
              ...retainedDnrRecord(false, false),
              opaqueRoot: 37,
              atomic: {
                ...retainedDnrRecord(false, false).atomic,
                paused: kind === "paused" ? "ownership-unconfirmed" : null,
              },
            };
      const h = await start();
      h.retryFaults({
        rawReads: 1,
        afterRawFailure: () => {
          h.store[KEY] = structuredClone(peer);
        },
      });
      h.installed[0]!({ reason: "install" });
      await h.settle();
      expect(JSON.stringify(h.store[KEY])).toBe(JSON.stringify(peer));
      expect(h.attempts.settingsWrites).toBe(0);
      expect(h.attempts.rawReads).toBe(1);
    },
  );
  it("queued removed SDK history during retry gap is still remembered", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "public-test-key");
    const h = await start();
    let mutation: Promise<unknown> | undefined;
    h.retryFaults({
      rawReads: 1,
      afterRawFailure: () => {
        mutation = Promise.resolve(
          boundary.sdkStorage!.removeItem("still:auth"),
        );
      },
    });
    h.installed[0]!({ reason: "install" });
    await h.settle();
    await mutation;
    expect(Object.hasOwn(h.store, "still:auth")).toBe(false);
    expect(Object.hasOwn(h.store, KEY)).toBe(false);
    expect(h.attempts.settingsWrites).toBe(0);
  });
  it("queued pending SDK write in retry gap is serialized without deadlock", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "public-test-key");
    const h = await start();
    const gate = h.gateWrite("still:auth");
    let mutation: Promise<unknown> | undefined;
    h.retryFaults({
      rawReads: 1,
      afterRawFailure: () => {
        mutation = Promise.resolve(
          boundary.sdkStorage!.setItem("still:auth", "retained-session"),
        );
      },
    });
    h.installed[0]!({ reason: "install" });
    try {
      await gate.started;
      await h.settle();
      expect(Object.hasOwn(h.store, KEY)).toBe(false);
    } finally {
      gate.release();
    }
    await mutation;
    await h.settle();
    expect(h.store["still:auth"]).toBe("retained-session");
    expect(Object.hasOwn(h.store, KEY)).toBe(false);
    expect(h.attempts.settingsWrites).toBe(0);
  });
});
