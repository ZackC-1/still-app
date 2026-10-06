import { TEST_PERMISSION, TEST_PRIVACY, TEST_SUBJECTS, testSubjectFor } from "./privacy-fixture.js";
import type { SubjectDeps } from "../extension-host.js";
import { createStoredConsent, type AnalyticsPermission } from "../consent.js";
import { describe, it, expect, vi } from "vitest";
import { createAppAnalytics, type AppAnalyticsBridge } from "../apple-app.js";
import { QUEUE_KEY, STATE_KEY } from "../client.js";
import type { AnalyticsKeyValue } from "../identity.js";
import type { AnalyticsContextReply } from "../../native/bridge.js";

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const CONTEXT: AnalyticsContextReply = {
  platform: "macos",
  appVersion: "2.1.0",
  installId: "11111111-1111-4111-8111-111111111111",
  anchorId: "22222222-2222-4222-8222-222222222222",
  created: true,
  returning: false,
  previousVersion: null,
  consent: true,
  noticeSeen: false,
  extensionEnabled: false,
  device: "desktop",
};

function memory(): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k) => structuredClone(data[k]),
    set: async (k, v) => void (data[k] = structuredClone(v)),
  };
}

function setup(
  context: Partial<AnalyticsContextReply> | null = {},
  over: {
    identifyOnServer?: () => Promise<void>;
    /** Per-device subjects; the synthetic subject server unless a test supplies its own. */
    subjects?: SubjectDeps;
    /** A build without per-device subjects at all. */
    noSubjects?: boolean;
    holdAccount?: boolean;
    fetch?: typeof globalThis.fetch;
    /** The native context read waits for this (a first launch can wait up to 5 s for iCloud). */
    gate?: Promise<void>;
    permission?: () => Promise<AnalyticsPermission | null>;
    store?: ReturnType<typeof memory>;
  } = {},
) {
  const store = over.store ?? memory();
  let current = context === null ? null : { ...CONTEXT, ...context };
  const bridge: AppAnalyticsBridge & {
    setAnalyticsConsent: ReturnType<typeof vi.fn>;
  } = {
    analyticsContext: vi.fn(async () => {
      await over.gate;
      return current;
    }),
    setAnalyticsConsent: vi.fn(async (enabled: boolean) => enabled),
    acknowledgeAnalyticsNotice: vi.fn(async () => {}),
  };
  const fetch =
    over.fetch ??
    vi.fn(async () => {
      throw new TypeError("offline in tests");
    });
  let n = 0;
  const app = createAppAnalytics({
    ...TEST_PRIVACY,
    ...(over.permission ? { permission: over.permission } : {}),
    bridge,
    config: { key: "phc_test", host: "https://us.i.posthog.com" },
    store,
    fetch: fetch as unknown as typeof globalThis.fetch,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    identifyOnServer: over.identifyOnServer,
    subjects: over.noSubjects ? undefined : (over.subjects ?? TEST_SUBJECTS),
  });
  // The real launch always reports what it found: here, nobody signed in.
  if (!over.holdAccount) void app.accountAbsent();
  const events = () =>
    (store.data[QUEUE_KEY] as { event: string; properties: Record<string, unknown> }[] | undefined) ?? [];
  return {
    app,
    bridge,
    events,
    store,
    setContext: (c: Partial<AnalyticsContextReply>) => void (current = { ...current!, ...c }),
  };
}

describe("Apple app analytics", () => {
  it("a new Mac install reports installed, the app opening and one active day", async () => {
    const { app, events } = setup();
    await app.start();
    expect(
      events().map((e) => [
        e.event,
        e.properties.step ?? e.properties.where ?? e.properties.returning,
      ]),
    ).toEqual([
      ["installed", false],
      ["setup_step", "app_opened"],
      ["opened", "app"],
      ["active", undefined],
    ]);
    expect(events()[0]!.properties).toMatchObject({
      surface: "app-macos",
      store: "macos",
      distinct_id: CONTEXT.anchorId,
    });
  });

  it("an update from 2.0 reports updated, not installed", async () => {
    const { app, events } = setup({ previousVersion: "2.0.0" });
    await app.start();
    expect(events()[0]).toMatchObject({
      event: "updated",
      properties: { from: "2.0.0", to: "2.1.0" },
    });
    expect(events().some((e) => e.event === "installed")).toBe(false);
  });

  it("reports the Safari extension being switched on once, when the person comes back", async () => {
    const { app, events, setContext } = setup();
    await app.start();
    setContext({ extensionEnabled: true });
    await app.recheckSetup();
    await app.recheckSetup();
    expect(
      events().filter((e) => e.event === "extension_enabled"),
    ).toHaveLength(1);
  });

  it("follows the app's switch and turning it off drops the queue", async () => {
    const { app, events, bridge } = setup();
    await app.start();
    expect(await app.ui.sharing!()).toEqual({
      enabled: true,
      noticeNeeded: true,
    });
    expect(await app.ui.setSharing!(false)).toBe(false);
    expect(bridge.setAnalyticsConsent).toHaveBeenCalledWith(false);
    expect(events()).toEqual([]);
    app.ui.track("opened", { where: "app" });
    await app.recheckSetup();
    expect(events()).toEqual([]);
  });

  it("sends nothing when the person already turned sharing off", async () => {
    const { app, events } = setup({ consent: false });
    await app.start();
    expect(events()).toEqual([]);
    expect(await app.ui.sharing!()).toEqual({
      enabled: false,
      noticeNeeded: true,
    });
  });

  it("outside the app there is no switch and nothing happens", async () => {
    const { app, events } = setup(null);
    await app.start();
    expect(await app.ui.sharing!()).toBeNull();
    expect(events()).toEqual([]);
  });

  it("identifies a signed-in account under its issued subject, asking the server once", async () => {
    // Per-device subjects (U5-W2): the server issues the identity and attaches the email with it,
    // so the separate email attach never runs and the account id is never the person.
    const identifyOnServer = vi.fn(async () => {});
    const issue = vi.fn(TEST_SUBJECTS.issue);
    const { app, events } = setup({}, { identifyOnServer, subjects: { issue, onStopped: async () => {} } });
    await app.identifyAccount(U1);
    await new Promise((r) => setTimeout(r, 10));
    await app.identifyAccount(U1);
    await new Promise((r) => setTimeout(r, 10));
    expect(issue).toHaveBeenCalledTimes(1);
    expect(identifyOnServer).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
    app.ui.track("signed_in", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(
      events().find((e) => e.event === "signed_in")?.properties.distinct_id,
    ).toBe(testSubjectFor(U1));
    expect(JSON.stringify(events())).not.toContain(U1);
    expect(JSON.stringify(events())).not.toContain("$anon_distinct_id");
  });

  it.each(["no subject issued", "no per-device subjects"] as const)(
    "with %s a signed-in account is never confirmed under its account id",
    async (variant) => {
      const issueless = { issue: vi.fn(async () => null), onStopped: async () => {} };
      const identifyOnServer = vi.fn(async () => {});
      const { app, events, store } = setup(
        {},
        variant === "no subject issued"
          ? { subjects: issueless, holdAccount: true }
          : { noSubjects: true, holdAccount: true, identifyOnServer },
      );
      await app.identifyAccount(U1);
      app.ui.track("signed_in", {});
      await new Promise((r) => setTimeout(r, 10));
      expect(JSON.stringify(events())).not.toContain(U1);
      expect(JSON.stringify(store.data[STATE_KEY] ?? {})).not.toContain(U1);
      expect(identifyOnServer).not.toHaveBeenCalled();
    },
  );

  it("NEGATIVE CONTROL: an earlier account's subject arriving after a switch never takes the new account's use", async () => {
    const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let resolveU1!: (value: unknown) => void;
    let resolveU2!: (value: unknown) => void;
    const lateU1 = new Promise((resolve) => (resolveU1 = resolve));
    const lateU2 = new Promise((resolve) => (resolveU2 = resolve));
    const asked: string[] = [];
    const subjects: SubjectDeps = {
      issue: async (_body, _signal, account) => (asked.push(account), account === U1 ? lateU1 : lateU2),
      onStopped: async () => {},
    };
    const { app, events, store } = setup({}, { subjects }); // the launch confirmed nobody
    await app.start();
    const first = app.identifyAccount(U1); // U1's subject request is in flight
    await vi.waitFor(() => expect(asked).toEqual([U1]));
    const second = app.identifyAccount(U2); // U2 signs in before U1's reply
    await vi.waitFor(() => expect(asked).toEqual([U1, U2]));
    app.ui.track("signed_in", {}); // U2's use, waiting
    await new Promise((r) => setTimeout(r, 10));
    resolveU1({ state: "active", subject: testSubjectFor(U1) }); // U1's reply lands first, late
    await first;
    resolveU2({ state: "active", subject: testSubjectFor(U2) });
    await second;
    await new Promise((r) => setTimeout(r, 10));
    expect((store.data[STATE_KEY] as { userId?: string }).userId).toBe(testSubjectFor(U2));
    expect(JSON.stringify(events())).not.toContain(testSubjectFor(U1));
    expect(events().find((e) => e.event === "signed_in")?.properties.distinct_id).toBe(testSubjectFor(U2));
  });

  it("NEGATIVE CONTROL: two sign-ins back to back, the earlier reply first: only the later account reports", async () => {
    const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let resolveU1!: (value: unknown) => void;
    let resolveU2!: (value: unknown) => void;
    const lateU1 = new Promise((resolve) => (resolveU1 = resolve));
    const lateU2 = new Promise((resolve) => (resolveU2 = resolve));
    const subjects: SubjectDeps = {
      issue: async (_body, _signal, account) => (account === U1 ? lateU1 : lateU2),
      onStopped: async () => {},
    };
    const { app, events, store } = setup({}, { subjects });
    await app.start();
    const first = app.identifyAccount(U1);
    const second = app.identifyAccount(U2); // no wait between
    app.ui.track("signed_in", {});
    resolveU1({ state: "active", subject: testSubjectFor(U1) });
    await first;
    resolveU2({ state: "active", subject: testSubjectFor(U2) });
    await second;
    await new Promise((r) => setTimeout(r, 10));
    expect((store.data[STATE_KEY] as { userId?: string }).userId).toBe(testSubjectFor(U2));
    expect(JSON.stringify(events())).not.toContain(testSubjectFor(U1));
  });
});

describe("Apple app account and identity reconciliation", () => {
  it("a launch with no session lets go of an account left from before, and its waiting events", async () => {
    const { app, events } = setup();
    await app.identifyAccount(U1);
    await app.accountAbsent();
    await app.start();
    expect(JSON.stringify(events())).not.toContain(U1);
    expect(events().every((e) => e.properties.signed_in !== true)).toBe(true);
  });

  it("any use in the app counts toward the day", async () => {
    const { app, events } = setup();
    app.ui.track("service_toggled", {
      service: "youtube",
      enabled: false,
      where: "popup",
    });
    await app.start();
    expect(events().filter((e) => e.event === "active")).toHaveLength(1);
  });
});

describe("Apple app installs counted after sharing is turned on", () => {
  it("an old sharing toggle cannot grant fresh permission or replay a prior install", async () => {
    const { app, events } = setup({ consent: false });
    await app.start();
    expect(events()).toEqual([]);
    expect(await app.ui.setSharing!(true)).toBe(false);
    await app.recheckSetup();
    expect(events().filter((e) => e.event === "installed")).toHaveLength(0);
  });

  it("turning sharing off clears the backlog without a farewell event", async () => {
    const { app, events } = setup();
    await app.start();
    await app.ui.setSharing!(false);
    expect(events()).toEqual([]); // discarded after the last send attempt
  });
});

describe("Apple app follows a choice committed natively elsewhere", () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  /** A later, separately granted permission: a new origin with its own provider ids. */
  const NEWER_PERMISSION: AnalyticsPermission = {
    ...TEST_PERMISSION,
    origin: "88888888-8888-4888-8888-888888888888",
    generation: TEST_PERMISSION.generation + 1,
    provider: {
      anonymousId: "77777777-7777-4777-8777-777777777777",
      deviceId: "66666666-6666-4666-8666-666666666666",
    },
  };

  it("adopting Don't share drops the queue and stops sending, with no write and no event", async () => {
    const { app, events, bridge } = setup();
    await app.start();
    expect(events().length).toBeGreaterThan(0);
    app.adoptCommittedConsent(false);
    await vi.waitFor(() => expect(events()).toEqual([]));
    app.ui.track("opened", { where: "app" });
    await app.recheckSetup();
    expect(events()).toEqual([]);
    expect(bridge.setAnalyticsConsent).not.toHaveBeenCalled();
    expect(await app.ui.sharing!()).toMatchObject({ enabled: false });
  });

  it("adopting Share resumes reporting and records the existing choice event once, with no second write", async () => {
    const { app, events, bridge } = setup({ consent: false });
    await app.start();
    expect(events()).toEqual([]);
    app.adoptCommittedConsent(true);
    app.ui.track("opened", { where: "app" });
    await vi.waitFor(() =>
      expect(events().some((e) => e.event === "opened")).toBe(true),
    );
    await vi.waitFor(() =>
      expect(
        events().filter((e) => e.event === "analytics_choice_made"),
      ).toHaveLength(1),
    );
    expect(
      events().find((e) => e.event === "analytics_choice_made")!.properties,
    ).toMatchObject({ choice: "share" });
    expect(bridge.setAnalyticsConsent).not.toHaveBeenCalled();
  });

  it("Don't share is off at the tap, records no choice event, and matches setSharing(false)", async () => {
    const { app, events } = setup();
    await app.start();
    app.adoptCommittedConsent(false);
    // Synchronously off: the very next read already reports sharing stopped.
    expect(await app.ui.sharing!()).toMatchObject({ enabled: false });
    await vi.waitFor(() => expect(events()).toEqual([]));
    expect(events().some((e) => e.event === "analytics_choice_made")).toBe(false);
  });

  it("stays off after Don't share even when native could not record it and still reads on", async () => {
    // Native keeps reading consent: true. The tap lands before the launch's client exists, and by the
    // time the client is built the permission is a newer one, so retiring the tapped permission does
    // not touch it: only the Don't share hold keeps reporting off, until an explicit Share.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let permission: AnalyticsPermission = TEST_PERMISSION;
    const { app, events } = setup({}, { gate, permission: async () => permission });
    void app.start();
    app.adoptCommittedConsent(false);
    await settle(); // the stop made at the tap has ended the tapped permission
    permission = NEWER_PERMISSION;
    release();
    await settle(); // the launch's client is now built, under the newer permission
    app.ui.track("opened", { where: "app" });
    await app.recheckSetup();
    await app.identifyAccount(U1);
    await settle();
    expect(events()).toEqual([]);
    // The hold is not a block: an explicit Share on the newer permission reports again.
    app.adoptCommittedConsent(true);
    await vi.waitFor(() =>
      expect(events().map((e) => e.event)).toContain("analytics_choice_made"),
    );
  });

  it("Don't share tapped before the launch read finishes ends that permission exactly as after it", async () => {
    type Arm = "after-read" | "share-while-pending" | "share-after-read" | "control";
    const run = async (arm: Arm) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { app, events } = setup({}, { gate }); // the launch's account check is already waiting
      if (arm === "after-read") {
        release();
        await app.start();
      } else void app.start();
      if (arm !== "control") app.adoptCommittedConsent(false);
      if (arm === "share-while-pending" || arm === "control")
        app.adoptCommittedConsent(true);
      release();
      await settle();
      if (arm === "after-read" || arm === "share-after-read")
        app.adoptCommittedConsent(true);
      app.ui.track("opened", { where: "app" });
      await app.recheckSetup();
      await settle();
      return events().map((e) => e.event);
    };
    expect(await run("after-read")).toEqual([]);
    expect(await run("share-while-pending")).toEqual([]);
    expect(await run("share-after-read")).toEqual([]);
    // Control: the same launch with Share alone reports, choice event included.
    expect(await run("control")).toEqual(
      expect.arrayContaining(["analytics_choice_made", "opened"]),
    );
  });

  it("a Share right after a Don't share, before any launch read began, still needs a fresh permission", async () => {
    // The launch's client is built while the stop is still being saved; slow first writes (device
    // storage can be slower than a read) would let the two overwrite each other's state.
    const store = memory();
    const set = store.set;
    let writes = 0;
    store.set = async (k, v) => {
      if (++writes <= 2) await new Promise((r) => setTimeout(r, 5));
      await set(k, v);
    };
    const { app, events } = setup({}, { holdAccount: true, store });
    app.adoptCommittedConsent(false);
    app.adoptCommittedConsent(true);
    app.ui.track("opened", { where: "app" });
    await settle();
    await settle();
    app.ui.track("opened", { where: "app" });
    await app.accountAbsent();
    await app.recheckSetup();
    await settle();
    expect(events()).toEqual([]);
    expect(store.data[STATE_KEY]).toMatchObject({ stoppedOrigin: TEST_PERMISSION.origin });
  });

  it("a Don't share tapped before the launch read is durable, and a fresh permission later reports", async () => {
    const store = memory();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = setup({}, { gate, store });
    first.app.adoptCommittedConsent(false);
    release();
    first.app.ui.track("opened", { where: "app" }); // builds the client, which ends the permission
    await settle();
    expect(first.events()).toEqual([]);
    expect(store.data[STATE_KEY]).toMatchObject({ stoppedOrigin: TEST_PERMISSION.origin });
    // Relaunch under the same permission: a Share still needs a fresh one.
    const same = setup({}, { store });
    same.app.adoptCommittedConsent(true);
    same.app.ui.track("opened", { where: "app" });
    await settle();
    expect(same.events()).toEqual([]);
    // Relaunch after a fresh grant: Share reports again.
    const fresh = setup({}, { store, permission: async () => NEWER_PERMISSION });
    fresh.app.adoptCommittedConsent(true);
    fresh.app.ui.track("opened", { where: "app" });
    await vi.waitFor(() =>
      expect(fresh.events().map((e) => e.event)).toEqual(
        expect.arrayContaining(["analytics_choice_made", "opened"]),
      ),
    );
  });

  it("after a withdrawal, a later Share needs a fresh permission exactly like setSharing", async () => {
    const viaAdopt = setup();
    await viaAdopt.app.start();
    viaAdopt.app.adoptCommittedConsent(false);
    viaAdopt.app.adoptCommittedConsent(true);
    viaAdopt.app.ui.track("opened", { where: "app" });
    await viaAdopt.app.recheckSetup();
    const viaSwitch = setup();
    await viaSwitch.app.start();
    await viaSwitch.app.ui.setSharing!(false);
    await viaSwitch.app.ui.setSharing!(true);
    viaSwitch.app.ui.track("opened", { where: "app" });
    await viaSwitch.app.recheckSetup();
    await vi.waitFor(() => expect(viaAdopt.events()).toEqual(viaSwitch.events()));
    expect(viaAdopt.events()).toEqual([]);
  });

  it("adopting Share keeps a launch that was already in flight under the on-by-default value", async () => {
    const { app, events } = setup();
    const starting = app.start(); // first-launch start still in flight
    app.adoptCommittedConsent(true);
    await starting;
    await vi.waitFor(() =>
      expect(events().map((e) => e.event)).toEqual(
        expect.arrayContaining(["installed", "opened"]),
      ),
    );
  });

  it("Don't share during an in-flight launch keeps that launch from reporting", async () => {
    const { app, events } = setup();
    const starting = app.start();
    app.adoptCommittedConsent(false);
    await starting;
    await app.recheckSetup();
    expect(events()).toEqual([]);
  });
});

describe("Apple app sends wait for the launch's account check", () => {
  it("a session-less launch never sends the previous account's events", async () => {
    const posted: string[] = [];
    const fetch = (async (_u: string, init: RequestInit) => {
      posted.push(String(init.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const { app, store } = setup({}, { holdAccount: true, fetch });
    store.data[STATE_KEY] = {
      userId: U1,
      identifiedAs: U1,
      daily: {},
      anonId: null,
    }; // from an earlier launch
    void app.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(posted).toEqual([]); // held
    await app.accountAbsent();
    await new Promise((r) => setTimeout(r, 50));
    await app.recheckSetup();
    await new Promise((r) => setTimeout(r, 50));
    expect(posted.join("")).not.toContain(U1);
  });

  it("an install and updates observed while sharing is held are never backfilled", async () => {
    const store = (() => {
      const data: Record<string, unknown> = {};
      return {
        data,
        get: async (k: string) => structuredClone(data[k]),
        set: async (k: string, v: unknown) => void (data[k] = structuredClone(v)),
      };
    })();
    const authority = memory();
    const permission = createStoredConsent(authority, false);
    const make = (ctx: Partial<AnalyticsContextReply>) => {
      const current = { ...CONTEXT, ...ctx };
      const a = createAppAnalytics({
        ...TEST_PRIVACY,
        permission: () => permission.read(),
        commitPermission: async (enabled) =>
          enabled
            ? permission.grant(TEST_PRIVACY.privacyPolicy.permissionVersion)
            : permission.set(false),
        bridge: {
          analyticsContext: async () => ({
            ...current,
            consent: await permission.get(),
          }),
          setAnalyticsConsent: async (e) => e,
          acknowledgeAnalyticsNotice: async () => {},
        },
        config: { key: "phc_test", host: "https://us.i.posthog.com" },
        store,
        fetch: (async () => {
          throw new TypeError("offline");
        }) as unknown as typeof fetch,
        uuid: (() => {
          let n = 0;
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        })(),
      });
      void a.accountAbsent();
      return a;
    };
    await make({ consent: false, created: true }).start();
    await make({
      consent: false,
      created: false,
      previousVersion: "2.1.0",
      appVersion: "2.1.1",
    }).start();
    const third = make({ consent: false, created: false, appVersion: "2.1.1" });
    await third.start();
    expect(await third.ui.setSharing!(true)).toBe(true);
    const events = ((store.data[QUEUE_KEY] as { event: string }[]) ?? []).map(
      (e) => e.event,
    );
    expect(events).not.toContain("installed");
    expect(events).not.toContain("updated");
    expect(events).toContain("analytics_choice_made");
  });
});

describe("Apple launch attribution comes first", () => {
  it("a launch that finds the earlier account gone drops what waited, never giving it to nobody", async () => {
    const { app, events, store } = setup(
      { previousVersion: "2.0.0", created: false },
      { holdAccount: true },
    );
    store.data[STATE_KEY] = {
      userId: U1,
      identifiedAs: U1,
      daily: {},
      anonId: null,
    }; // saved by an earlier launch
    await app.start(); // records the update with no person yet
    expect(events().filter((e) => e.event === "updated")).toHaveLength(1); // waiting, no person
    await app.accountAbsent(); // the launch finds no session
    await new Promise((r) => setTimeout(r, 20));
    // Someone was signed in here and this launch's use waited with no person: it may be theirs, so
    // it is dropped with them rather than given a fresh anonymous id (U5-W2).
    expect(events().filter((e) => e.event === "updated")).toEqual([]);
    expect(JSON.stringify(events())).not.toContain(U1);
    app.ui.track("opened", { where: "app" }); // use after the launch knows: signed out
    await new Promise((r) => setTimeout(r, 10));
    expect(events().find((e) => e.event === "opened")?.properties.signed_in).toBe(false);
  });
});

describe("Apple app server identification recovery", () => {
  it("a launch completes a confirmation that storage refused, without asking the server again", async () => {
    vi.useFakeTimers();
    try {
      // The state read that fails is the first one after the subject arrives: the confirmation's own
      // (the hold made before the request has already been recorded).
      let fail = false;
      const identifyOnServer = vi.fn(async (...args: Parameters<typeof TEST_SUBJECTS.issue>) => {
        const reply = await TEST_SUBJECTS.issue(...args);
        fail = true;
        return reply;
      });
      const { app, store } = setup({}, {
        holdAccount: true,
        subjects: { issue: identifyOnServer, onStopped: async () => {} },
      });
      const get = store.get;
      store.get = async (key) => {
        if (key === STATE_KEY && fail) {
          fail = false;
          throw new Error("account read once");
        }
        return get(key);
      };
      await app.identifyAccount(U1);
      await vi.advanceTimersByTimeAsync(0);
      expect(identifyOnServer).toHaveBeenCalledTimes(1);
      expect((store.data[STATE_KEY] as { userId?: string } | undefined)?.userId).not.toBe(testSubjectFor(U1));
      await app.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(identifyOnServer).toHaveBeenCalledTimes(1);
      expect((store.data[STATE_KEY] as { userId?: string }).userId).toBe(testSubjectFor(U1));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["track", "foreground"] as const)(
    "%s retries a failed subject request, and a success stays once per account",
    async (use) => {
      vi.useFakeTimers();
      try {
        const identifyOnServer = vi.fn(TEST_SUBJECTS.issue).mockRejectedValueOnce(new Error("offline"));
        const { app, store } = setup({}, {
          holdAccount: true,
          subjects: { issue: identifyOnServer, onStopped: async () => {} },
        });
        await app.identifyAccount(U1);
        await vi.advanceTimersByTimeAsync(0);
        expect(identifyOnServer).toHaveBeenCalledTimes(1);
        const useApp = async () => {
          if (use === "track") app.ui.track("opened", { where: "app" });
          else await app.recheckSetup();
          await vi.advanceTimersByTimeAsync(0);
        };
        await useApp();
        // The retry derives the origin proof first (Web Crypto completes outside fake timers).
        await vi.waitFor(() => expect(identifyOnServer).toHaveBeenCalledTimes(2));
        await vi.waitFor(() =>
          expect((store.data[STATE_KEY] as { userId?: string } | undefined)?.userId).toBe(testSubjectFor(U1))
        );
        await useApp();
        await vi.advanceTimersByTimeAsync(10);
        expect(identifyOnServer).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
