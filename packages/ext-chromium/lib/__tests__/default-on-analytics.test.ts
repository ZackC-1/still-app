import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  CONSENT_KEY,
  NOTICE_KEY,
  NOTICE_VERSION_KEY,
  QUEUE_KEY,
  STATE_KEY,
  USAGE_PERMISSION_VERSION,
  readAnalyticsPermission,
  supabaseSubjectIssuer,
  purchaseAnalyticsContext,
  purchaseAnalyticsReporter,
  withCheckoutAnalytics,
  type AnalyticsKeyValue,
} from "@still/core/analytics";
import { ANALYTICS_MESSAGE_KIND, createBackgroundAnalytics, type BackgroundAnalyticsDeps } from "../analytics.js";
import { createDefaultOnBackgroundAnalytics } from "../default-on-analytics.js";

// A V3 build: the default-on basis is compiled in (core build-basis.ts reads the build flags).
vi.mock("../../../core/src/analytics/build-basis.js", () => ({ USAGE_ON_BY_DEFAULT_BUILD: true }));

// The production wiring, with no test seam: what a V3 Chrome or Firefox package actually runs.

const RUNTIME_ID = "still-id";
const ORIGIN = "chrome-extension://still-id/";
const PAGE = { id: RUNTIME_ID, url: `${ORIGIN}options.html` };

function memory(initial: Record<string, unknown> = {}, readDelayMs = 0): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: async (k) => {
      if (readDelayMs) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      return structuredClone(data[k]) ?? null;
    },
    set: async (k, v) => void (data[k] = structuredClone(v)),
  };
}

type Factory = typeof createDefaultOnBackgroundAnalytics;

function setup(
  factory: Factory,
  over: {
    isFirefox?: boolean;
    granted?: boolean;
    local?: ReturnType<typeof memory>;
    issueSubject?: BackgroundAnalyticsDeps["issueSubject"];
    reportPurchases?: () => void;
    production?: boolean;
  } = {},
) {
  const local = over.local ?? memory();
  const browser = { granted: over.granted ?? false, revoked: 0 };
  let n = 0;
  const fetch = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 200 }));
  const deps: BackgroundAnalyticsDeps = {
    isFirefox: over.isFirefox ?? false,
    config: { key: "phc_test", host: "https://us.i.posthog.com" },
    envelope: over.production ? undefined : { build_channel: "test" },
    appVersion: "3.0.0",
    local,
    shared: memory(),
    sharedGraceMs: 0,
    firefoxPermissionGranted: async () => browser.granted,
    firefoxPermissionRevoke: async () => {
      browser.revoked += 1;
      browser.granted = false;
      return true;
    },
    fetch: fetch as unknown as typeof globalThis.fetch,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    issueSubject: over.issueSubject,
    reportPurchases: over.reportPurchases,
  };
  const bg = factory(deps, RUNTIME_ID, ORIGIN);
  const send = (message: Record<string, unknown>) =>
    new Promise<unknown>((resolve) => {
      if (!bg.listener({ kind: ANALYTICS_MESSAGE_KIND, ...message }, PAGE, resolve)) resolve(undefined);
    });
  const queue = () => ((local.data[QUEUE_KEY] as { event: string }[] | undefined) ?? []).map((e) => e.event);
  const sent = () =>
    fetch.mock.calls.flatMap((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as { batch: { event: string }[] };
      return body.batch.map((e) => e.event);
    });
  const permission = () => readAnalyticsPermission(local.data[CONSENT_KEY]);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const bodies = () => fetch.mock.calls.map((call) => String((call[1] as RequestInit).body)).join("\n");
  return { bg, local, browser, fetch, send, queue, sent, bodies, permission, settle };
}

/** A fresh install as the background runs it: the start hands over its account read (still
 * pending) in the first pass, Chrome then delivers onInstalled, and the read finds nobody. */
async function install(t: ReturnType<typeof setup>) {
  let answer!: (account: string | null) => void;
  t.bg.onStart(new Promise<string | null>((resolve) => (answer = resolve)));
  t.bg.onInstalled({ reason: "install" });
  answer(null); // as early as it can come: before the install path has done anything
  for (let i = 0; i < 5; i++) await t.settle();
  await t.bg.flushWhenReady();
}

/** Install reporting is fire-and-forget; startup readiness does not mean its events are queued.
 * Flush again until both events have been sent, bounded so a missing event still fails. */
async function expectInstallReported(t: ReturnType<typeof setup>) {
  await vi.waitFor(async () => {
    await t.bg.flushWhenReady();
    expect(t.sent()).toEqual(expect.arrayContaining(["installed", "setup_completed"]));
  }, { timeout: 3_000, interval: 10 });
}

describe("root cause: the 2.x wrapper supplies no permission or policy, so nothing can ever send", () => {
  it("Chrome: sharing reads off, the switch cannot turn it on, and no request is made", async () => {
    const t = setup(createBackgroundAnalytics);
    await install(t);
    await t.send({ action: "track", name: "opened", props: { where: "options" } });
    await t.bg.client.flush();
    expect(await t.send({ action: "sharing" })).toEqual({ enabled: false, noticeNeeded: true });
    expect(await t.send({ action: "setSharing", enabled: true })).toBe(false);
    expect(t.queue()).toEqual([]);
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("Firefox: even with the data-collection permission granted, nothing sends", async () => {
    const t = setup(createBackgroundAnalytics, { isFirefox: true, granted: true });
    await install(t);
    await t.send({ action: "track", name: "opened", props: { where: "options" } });
    await t.bg.client.flush();
    expect(await t.send({ action: "sharing" })).toEqual({ enabled: false, noticeNeeded: false });
    expect(t.fetch).not.toHaveBeenCalled();
  });
});

describe("V3 Chrome: on by default, with the switch as the one control", () => {
  it("delivers offer and purchase actions through the actual V3 wrapper, then stops after withdrawal", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics);
    await install(t);
    await t.send({ action: "track", name: "paywall_viewed", props: { trigger: "settings_card", where: "options" } });
    await t.send({ action: "track", name: "purchase_started", props: { purchase_origin: "web", product: "still-pro-v3" } });
    await t.bg.flushWhenReady();
    expect(t.sent()).toEqual(expect.arrayContaining(["paywall_viewed", "purchase_started"]));
    await t.send({ action: "setSharing", enabled: false });
    t.fetch.mockClear();
    await t.send({ action: "track", name: "purchase_started", props: { purchase_origin: "web", product: "still-pro-v3" } });
    await t.bg.flushWhenReady();
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it.each([0, 10])("reports from install with %i ms storage reads, even when the start's account answer lands right after onInstalled, and asks for no notice", async (readDelayMs) => {
    const t = setup(createDefaultOnBackgroundAnalytics, { local: memory({}, readDelayMs) });
    await install(t);
    expect(t.permission()).toMatchObject({ state: "granted", version: USAGE_PERMISSION_VERSION });
    await expectInstallReported(t);
    const request = t.fetch.mock.calls[0]!;
    expect(String(request[0])).toBe("https://us.i.posthog.com/batch/");
    expect(String((request[1] as RequestInit).body)).toContain('"build_channel":"test"');

    // No one-time notice since 2026-10-12 (ADR 0004 "One usage-data control").
    expect(await t.send({ action: "sharing" })).toEqual({ enabled: true, noticeNeeded: false });
  });

  it("off discards what waits and stops sending; on resumes under a new permission", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics);
    await install(t);
    const first = t.permission()!;
    t.fetch.mockClear();

    await t.send({ action: "track", name: "opened", props: { where: "options" } });
    expect(t.queue()).toEqual(expect.arrayContaining(["opened"]));
    expect(await t.send({ action: "setSharing", enabled: false })).toBe(false);
    expect(t.queue()).toEqual([]);
    expect(t.permission()).toMatchObject({ state: "stopped", origin: first.origin });
    expect(await t.send({ action: "sharing" })).toMatchObject({ enabled: false });

    await t.send({ action: "track", name: "opened", props: { where: "options" } });
    await t.bg.client.flush();
    expect(t.queue()).toEqual([]);
    expect(t.fetch).not.toHaveBeenCalled();

    // A new background (a browser restart) keeps it off: a read never re-grants a stop.
    const restarted = setup(createDefaultOnBackgroundAnalytics, { local: t.local });
    await install(restarted);
    expect(restarted.fetch).not.toHaveBeenCalled();
    expect(await restarted.send({ action: "sharing" })).toMatchObject({ enabled: false });

    expect(await t.send({ action: "setSharing", enabled: true })).toBe(true);
    const again = t.permission()!;
    expect(again).toMatchObject({ state: "granted" });
    expect(again.origin).not.toBe(first.origin);
    await t.bg.client.flush();
    expect(t.sent()).toEqual(["analytics_choice_made"]);
    expect(await t.send({ action: "sharing" })).toMatchObject({ enabled: true });
  });

  it("while signed in without a per-device identity (no issuer in this build), events wait unsent", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics);
    t.bg.onStart("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await t.settle();
    await t.send({ action: "track", name: "opened", props: { where: "options" } });
    await t.bg.flushWhenReady();
    expect(await t.send({ action: "sharing" })).toMatchObject({ enabled: true });
    expect(t.queue()).toEqual(expect.arrayContaining(["opened"]));
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("an upgrade from 2.1 keeps a 2.1 off", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics, { local: memory({ [CONSENT_KEY]: false }) });
    await install(t);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(await t.send({ action: "sharing" })).toMatchObject({ enabled: false });
  });
});

describe("V3 Firefox: follows the optional technicalAndInteraction permission", () => {
  it("off when the install prompt did not grant it: nothing queued, sent or written", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics, { isFirefox: true, granted: false });
    await install(t);
    await t.send({ action: "track", name: "opened", props: { where: "options" } });
    await t.bg.client.flush();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.queue()).toEqual([]);
    expect(t.local.data[CONSENT_KEY]).toBeUndefined();
    expect(await t.send({ action: "sharing" })).toEqual({ enabled: false, noticeNeeded: false });
  });

  it("on from install when granted there; the switch withdraws it and asks for it again", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics, { isFirefox: true, granted: true });
    await install(t);
    await expectInstallReported(t);
    expect(await t.send({ action: "sharing" })).toEqual({ enabled: true, noticeNeeded: false });

    expect(await t.send({ action: "setSharing", enabled: false })).toBe(false);
    expect(t.browser.revoked).toBe(1);
    expect(t.permission()?.state).toBe("stopped");

    // The page asks Firefox inside the tap (createPageAnalytics); declined, it stays off.
    expect(await t.send({ action: "setSharing", enabled: true })).toBe(false);
    t.browser.granted = true; // accepted
    expect(await t.send({ action: "setSharing", enabled: true })).toBe(true);
    expect(t.permission()?.state).toBe("granted");
  });

  it("withdrawing it in the add-on manager stops sharing and discards what waits", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics, { isFirefox: true, granted: true });
    await install(t);
    t.fetch.mockClear();
    await t.send({ action: "track", name: "opened", props: { where: "options" } });
    t.browser.granted = false;
    await t.bg.client.flush();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.queue()).toEqual([]);
    expect(t.permission()?.state).toBe("stopped");
  });
});

describe("V3 Chrome: install timing", () => {
  it("counts the install when the start's account read is slow", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics);
    let answer!: (account: string | null) => void;
    t.bg.onStart(new Promise<string | null>((resolve) => (answer = resolve)));
    t.bg.onInstalled({ reason: "install" });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.queue()).toEqual([]); // not observed yet: waiting for the read
    answer(null);
    for (let i = 0; i < 5; i++) await t.settle();
    await t.bg.flushWhenReady();
    await expectInstallReported(t);
  });

  it("a background stopped while the install waits records and sends nothing", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics);
    let answer!: (account: string | null) => void;
    t.bg.onStart(new Promise<string | null>((resolve) => (answer = resolve)));
    t.bg.onInstalled({ reason: "install" });
    t.bg.stop();
    answer(null);
    for (let i = 0; i < 5; i++) await t.settle();
    expect(t.queue()).toEqual([]);
    expect(t.fetch).not.toHaveBeenCalled();
  });
});

describe("V3 Chrome: no notice, whatever the acknowledgement record says (2026-10-12)", () => {
  it("a 2.1 upgrader who acknowledged the 2.1 notice stays on and is asked for no notice", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics, { local: memory({ [CONSENT_KEY]: true, [NOTICE_KEY]: true }) });
    await install(t);
    expect(t.permission()).toMatchObject({ state: "granted", version: USAGE_PERMISSION_VERSION });
    expect(await t.send({ action: "sharing" })).toEqual({ enabled: true, noticeNeeded: false });
    // An acknowledgement from an older page still records this version; nothing reads it.
    await t.send({ action: "acknowledgeNotice" });
    expect(t.local.data[NOTICE_VERSION_KEY]).toBe(USAGE_PERMISSION_VERSION);
    expect(await t.send({ action: "sharing" })).toEqual({ enabled: true, noticeNeeded: false });
  });
});

describe("V3 signed-in devices report under their own identity (owner decision 50)", () => {
  const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SUBJECT = "5ab5ec7a-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OPEN = { action: "track", name: "opened", props: { where: "options" } };

  /** The production issuer answered `test_channel` by the server (a QA build), as in the QA lane. */
  const testChannelIssuer = () =>
    supabaseSubjectIssuer(
      {
        auth: { getSession: async () => ({ data: { session: { access_token: "t", user: { id: ACCOUNT } } }, error: null }) },
        functions: { invoke: async () => ({ data: { state: "test_channel" }, error: null }) },
      },
      "phc_qa_project_key",
    );
  /** The server issues one identity per device origin: a new origin (sharing turned back on) gets a
   * new one. `available` false answers 503 as the server's switch does while it is off. */
  const perOriginIssuer = (subjects: readonly string[]) => {
    const issued = new Map<string, string>();
    const issuer = {
      available: true,
      issue: vi.fn(async (body: { originProof: string }) => {
        if (!issuer.available) throw new Error("503 unavailable");
        if (!issued.has(body.originProof)) issued.set(body.originProof, subjects[issued.size]!);
        return { state: "active", subject: issued.get(body.originProof)! };
      }),
    };
    return issuer;
  };
  const SUBJECT_2 = "5ab5ec7a-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const events = (t: ReturnType<typeof setup>) =>
    t.fetch.mock.calls.flatMap((call) =>
      (JSON.parse(String((call[1] as RequestInit).body)) as { batch: { event: string; properties: { distinct_id: string } }[] }).batch,
    );
  const choices = (t: ReturnType<typeof setup>) =>
    events(t).filter((e) => e.event === "analytics_choice_made").map((e) => e.properties.distinct_id);
  const settled = async (t: ReturnType<typeof setup>) => {
    for (let i = 0; i < 5; i++) await t.settle();
    await t.bg.client.flush();
  };

  // ISS-0113 review: a sign-in hold that spans Off then On was tagged under the stopped origin, so
  // the identity confirmed under the new one did not own the choice waiting under it.
  it("ISS-0113: signed in while sharing was off, then On: one choice, under the identity issued for the new origin", async () => {
    const issuer = perOriginIssuer([SUBJECT, SUBJECT_2]);
    const t = setup(createDefaultOnBackgroundAnalytics, { issueSubject: issuer.issue });
    await install(t);
    expect(await t.send({ action: "setSharing", enabled: false })).toBe(false);
    await t.send({ action: "identify", userId: ACCOUNT }); // signed in while sharing is off
    await settled(t);
    t.fetch.mockClear();
    expect(await t.send({ action: "setSharing", enabled: true })).toBe(true);
    await t.send(OPEN);
    await settled(t);
    expect(choices(t)).toEqual([SUBJECT]); // the first identity this account was ever issued here
    expect(t.bodies()).not.toContain(ACCOUNT);
    expect(t.queue()).toEqual([]);
  });

  it("ISS-0113: signed in with no identity issued yet (503), Off then On: one choice, sent once the identity arrives", async () => {
    const issuer = perOriginIssuer([SUBJECT]);
    issuer.available = false;
    const t = setup(createDefaultOnBackgroundAnalytics, { issueSubject: issuer.issue });
    await install(t);
    await t.send({ action: "identify", userId: ACCOUNT });
    await t.send(OPEN);
    await settled(t);
    t.fetch.mockClear();
    expect(await t.send({ action: "setSharing", enabled: false })).toBe(false);
    expect(await t.send({ action: "setSharing", enabled: true })).toBe(true);
    await settled(t);
    expect(t.fetch).not.toHaveBeenCalled(); // held: never sent unattributed
    expect(t.queue()).toEqual(["analytics_choice_made"]);
    issuer.available = true;
    await t.send({ action: "identify", userId: ACCOUNT }); // the page reports the session again
    await settled(t);
    expect(choices(t)).toEqual([SUBJECT]);
    expect(t.bodies()).not.toContain(ACCOUNT);
    expect(t.queue()).toEqual([]);
  });

  // ISS-0113 review: signed in with a confirmed identity, Off then On while still signed in. The
  // earlier identity belongs to the stopped origin (being erased); the choice goes to the new one.
  it("ISS-0113: signed in with an identity, Off then On: the choice goes to the identity for the new origin", async () => {
    const issuer = perOriginIssuer([SUBJECT, SUBJECT_2]);
    const t = setup(createDefaultOnBackgroundAnalytics, { issueSubject: issuer.issue });
    await install(t);
    await t.send({ action: "identify", userId: ACCOUNT });
    await t.send(OPEN);
    await settled(t);
    expect(t.bodies()).toContain(`"distinct_id":"${SUBJECT}"`);
    t.fetch.mockClear();
    expect(await t.send({ action: "setSharing", enabled: false })).toBe(false);
    expect(await t.send({ action: "setSharing", enabled: true })).toBe(true);
    await t.send(OPEN);
    await settled(t);
    expect(choices(t)).toEqual([SUBJECT_2]);
    expect(t.bodies()).not.toContain(SUBJECT);
    expect(t.bodies()).not.toContain(ACCOUNT);
    expect(t.queue()).toEqual([]);
    const state = t.local.data[STATE_KEY] as { userId: unknown; heldFor: unknown };
    expect(state.userId).toBe(SUBJECT_2);
    expect(state.heldFor).toBeNull();
  });

  // ISS-0113 final check: the session ended while the worker slept, and the On tap wakes it. The
  // start's account read (nobody) must land before the re-identify, which would otherwise supersede
  // it and hold the device for the departed account for the worker's life.
  it.each([12, 25, 40])(
    "ISS-0113: a worker woken by the On tap after the session ended (start read %i ms) ends signed out",
    async (delay) => {
      const issuer = perOriginIssuer([SUBJECT, SUBJECT_2]);
      const local = memory({}, 1);
      const before = setup(createDefaultOnBackgroundAnalytics, { issueSubject: issuer.issue, local });
      await install(before);
      await before.send({ action: "identify", userId: ACCOUNT });
      await before.send(OPEN);
      await settled(before);
      expect(before.bodies()).toContain(`"distinct_id":"${SUBJECT}"`);
      expect(await before.send({ action: "setSharing", enabled: false })).toBe(false);
      before.bg.stop(); // the worker sleeps; the session ends meanwhile

      const t = setup(createDefaultOnBackgroundAnalytics, { issueSubject: issuer.issue, local });
      t.bg.onStart(new Promise<string | null>((resolve) => setTimeout(() => resolve(null), delay)));
      expect(await t.send({ action: "setSharing", enabled: true })).toBe(true); // the tap that woke it
      await settled(t);
      await t.send(OPEN);
      await settled(t);
      const state = local.data[STATE_KEY] as { userId: unknown; heldFor: unknown };
      expect(state.userId).toBeNull();
      expect(state.heldFor).toBeNull();
      expect(t.queue()).toEqual([]);
      const ids = choices(t);
      expect(ids).toHaveLength(1);
      expect([SUBJECT, SUBJECT_2]).not.toContain(ids[0]);
      expect(t.bodies()).not.toContain(ACCOUNT);
      expect(issuer.issue).toHaveBeenCalledTimes(1); // only the first worker's sign-in asked
    },
    15_000,
  );

  // ISS-0113 re-review: the re-identify on turn-on must never win over a sign-out that arrives
  // around the tap. Storage reads take a macrotask, as chrome.storage's do.
  it.each([-1, 0, 1, 2, 3, 5, 8, 13, 21, 34])(
    "ISS-0113: a sign-out arriving %i ms around the On tap (signed in with an identity) ends signed out",
    async (offset) => {
      const issuer = perOriginIssuer([SUBJECT, SUBJECT_2]);
      const t = setup(createDefaultOnBackgroundAnalytics, { issueSubject: issuer.issue, local: memory({}, 1) });
      await install(t);
      await t.send({ action: "identify", userId: ACCOUNT });
      await t.send(OPEN);
      await settled(t);
      expect(t.bodies()).toContain(`"distinct_id":"${SUBJECT}"`);
      expect(await t.send({ action: "setSharing", enabled: false })).toBe(false);
      t.fetch.mockClear();
      const signOut = () => t.send({ action: "reset", forgetAccount: false });
      let resetting: Promise<unknown> | undefined;
      if (offset < 0) resetting = signOut();
      const turningOn = t.send({ action: "setSharing", enabled: true });
      if (offset >= 0) {
        await new Promise((r) => setTimeout(r, offset));
        resetting = signOut();
      }
      expect(await turningOn).toBe(true);
      await resetting;
      await settled(t);
      await t.send(OPEN); // signed-out use
      await settled(t);
      await t.bg.client.flush();
      const state = t.local.data[STATE_KEY] as { userId: unknown; heldFor: unknown };
      expect(state.userId).toBeNull();
      expect(state.heldFor).toBeNull();
      expect(t.queue()).toEqual([]);
      const sent = events(t);
      expect(sent.filter((e) => e.event === "analytics_choice_made")).toHaveLength(1);
      const opened = sent.filter((e) => e.event === "opened").map((e) => e.properties.distinct_id);
      expect(opened).toHaveLength(1);
      expect([SUBJECT, SUBJECT_2]).not.toContain(opened[0]);
      expect(choices(t)).not.toContain(SUBJECT); // never the stopped period's identity
      expect(t.bodies()).not.toContain(ACCOUNT);
    },
    15_000,
  );


  it("a Still screen asks the server with only the origin proof; use is sent under the subject", async () => {
    const issueSubject = vi.fn(async (_body: { originProof: string }, _signal: AbortSignal, _account: string) => ({
      state: "active",
      subject: SUBJECT,
    }));
    const t = setup(createDefaultOnBackgroundAnalytics, { issueSubject });
    t.bg.onStart(ACCOUNT); // a background start never calls the server
    for (let i = 0; i < 3; i++) await t.settle();
    expect(issueSubject).not.toHaveBeenCalled();
    await t.send(OPEN); // an ordinary Still screen
    for (let i = 0; i < 3; i++) await t.settle();
    await t.bg.client.flush();
    expect(issueSubject).toHaveBeenCalledTimes(1);
    const [body, , account] = issueSubject.mock.calls[0]!;
    expect(Object.keys(body)).toEqual(["originProof"]);
    expect(account).toBe(ACCOUNT);
    expect(t.sent()).toEqual(expect.arrayContaining(["opened"]));
    expect(t.bodies()).toContain(`"distinct_id":"${SUBJECT}"`);
    expect(t.bodies()).not.toContain(ACCOUNT);
  });

  it("ISS-0108: the page's signed_in, observed under the sign-in's hold, goes to the identity that lands just before it is recorded", async () => {
    let reply!: (value: unknown) => void;
    const issueSubject = vi.fn(() => new Promise<unknown>((resolve) => (reply = resolve)));
    const local = memory();
    const t = setup(createDefaultOnBackgroundAnalytics, { issueSubject, local });
    await install(t); // signed out, reporting
    const identifying = t.send({ action: "identify", userId: ACCOUNT }); // the page's code sign-in
    await vi.waitFor(() => expect(issueSubject).toHaveBeenCalled()); // held; the identity is being asked for
    // Keep the client's operation chain busy (one paused queue read) so the order below is exact.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const read = local.get;
    let armed = true;
    local.get = async (key) => {
      if (armed && key === QUEUE_KEY) {
        armed = false;
        await gate;
      }
      return read(key);
    };
    const busy = t.bg.client.queuedCount();
    const trackUnchecked = vi.spyOn(t.bg.client, "trackUnchecked");
    const confirm = vi.spyOn(t.bg.client, "confirm");
    const tracking = t.send({ action: "track", name: "signed_in", props: {} });
    await vi.waitFor(() => expect(trackUnchecked).toHaveBeenCalled()); // observed under the hold
    reply({ state: "active", subject: SUBJECT }); // the identity lands one step before it is recorded
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    open();
    await busy;
    await tracking;
    await identifying;
    await t.bg.client.flush();
    expect(t.sent()).toEqual(expect.arrayContaining(["signed_in"]));
    expect(t.bodies()).toContain(`"distinct_id":"${SUBJECT}"`);
    expect(t.bodies()).not.toContain(ACCOUNT);
  });

  it("while the server's switch is off (503), signed-in use waits on the device", async () => {
    const issueSubject = vi.fn(async () => {
      throw new Error("503 unavailable");
    });
    const t = setup(createDefaultOnBackgroundAnalytics, { issueSubject });
    t.bg.onStart(ACCOUNT);
    await t.settle();
    await t.send(OPEN);
    for (let i = 0; i < 3; i++) await t.settle();
    await t.bg.client.flush();
    expect(issueSubject).toHaveBeenCalled();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.queue()).toEqual(expect.arrayContaining(["opened"]));
  });

  it("a test build answered test_channel keeps sharing on and its signed-in use waiting", async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => ({ data: { state: "test_channel" }, error: null }));
    const issueSubject = supabaseSubjectIssuer(
      {
        auth: { getSession: async () => ({ data: { session: { access_token: "t", user: { id: ACCOUNT } } }, error: null }) },
        functions: { invoke },
      },
      "phc_qa_project_key",
    );
    const t = setup(createDefaultOnBackgroundAnalytics, { issueSubject });
    t.bg.onStart(ACCOUNT);
    await t.settle();
    await t.send(OPEN);
    await t.send(OPEN); // a second screen does not ask again (back-off)
    for (let i = 0; i < 3; i++) await t.settle();
    await t.bg.client.flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    const body = (invoke.mock.calls[0]![1] as { body: Record<string, unknown> }).body;
    expect(Object.keys(body).sort()).toEqual(["originProof", "projectKeySha256"]);
    expect(t.permission()?.state).toBe("granted"); // never a stop
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.queue()).toEqual(expect.arrayContaining(["opened"]));
  });

  // ISS-0113 (QA 2.1.1.400): signed in, sharing Off, signed out while it was off, then On. The
  // sign-out could not be installed while sharing was off, so the choice waited beside it and was
  // dropped with what waited for the account. ADR 0004: the choice is recorded each time.
  it.each([
    ["an issued identity", (): BackgroundAnalyticsDeps["issueSubject"] => async () => ({ state: "active", subject: SUBJECT })],
    ["no identity (test_channel)", testChannelIssuer],
  ])("ISS-0113: with %s, Off, a sign-out while off, then On sends the choice under a new anonymous id", async (_label, issuer) => {
    const t = setup(createDefaultOnBackgroundAnalytics, { issueSubject: issuer() });
    await install(t);
    // A first Off then On while signed out: the choice is sent (and the anonymous id rotates).
    expect(await t.send({ action: "setSharing", enabled: false })).toBe(false);
    expect(await t.send({ action: "setSharing", enabled: true })).toBe(true);
    await t.bg.client.flush();
    const ids = () =>
      t.fetch.mock.calls.flatMap((call) =>
        (JSON.parse(String((call[1] as RequestInit).body)) as { batch: { event: string; properties: { distinct_id: string } }[] }).batch,
      );
    const firstChoice = ids().filter((e) => e.event === "analytics_choice_made");
    expect(firstChoice).toHaveLength(1);
    const earlier = new Set(ids().map((e) => e.properties.distinct_id));

    // Signed in, then Off, then signed out while sharing is off.
    await t.send({ action: "identify", userId: ACCOUNT });
    await t.send(OPEN);
    for (let i = 0; i < 3; i++) await t.settle();
    await t.bg.client.flush();
    expect(await t.send({ action: "setSharing", enabled: false })).toBe(false);
    await t.send({ action: "track", name: "signed_out", props: {} });
    await t.send({ action: "reset", forgetAccount: false });
    t.fetch.mockClear();

    expect(await t.send({ action: "setSharing", enabled: true })).toBe(true);
    await t.bg.client.flush();
    const choice = ids().filter((e) => e.event === "analytics_choice_made");
    expect(choice).toHaveLength(1);
    const id = choice[0]!.properties.distinct_id;
    expect(earlier.has(id)).toBe(false);
    expect(id).not.toBe(SUBJECT);
    expect(t.bodies()).not.toContain(ACCOUNT);
    expect(t.queue()).toEqual([]);
    expect((t.local.data[STATE_KEY] as { userId: unknown; heldFor: unknown }).userId).toBeNull();
    expect((t.local.data[STATE_KEY] as { heldFor: unknown }).heldFor).toBeNull();
  });

  it("a server stop ends sharing on this device", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics, { issueSubject: async () => ({ state: "stopped" }) });
    t.bg.onStart(ACCOUNT);
    await t.settle();
    await t.send(OPEN);
    for (let i = 0; i < 3; i++) await t.settle();
    expect(t.permission()?.state).toBe("stopped");
    expect(await t.send({ action: "sharing" })).toMatchObject({ enabled: false });
    expect(t.fetch).not.toHaveBeenCalled();
  });
});


describe("canonical web reporting through the actual default-on factory", () => {
  it.each([false,true])("captures original and current permission on %s Firefox, then stops at the real switch",async isFirefox => {
    const account="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", subject="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let report=()=>{}, clock=1;
    const t=setup(createDefaultOnBackgroundAnalytics,{ isFirefox,granted:true,production:true,
      issueSubject:async()=>({ state:"active",subject }),reportPurchases:()=>report() });
    const capture=purchaseAnalyticsContext(t.bg.client,{ key:"phc_test",host:"https://us.i.posthog.com" });
    const reported:unknown[]=[];
    report=purchaseAnalyticsReporter({ capture,now:()=>clock,prepare:async()=>({ account,
      send:async body=>{ reported.push(body); } }) });
    t.bg.onStart(account);
    await t.bg.flushWhenReady();
    expect(reported).toEqual([]);
    await t.send({ action:"track",name:"opened",props:{ where:"options" } });
    await vi.waitFor(()=>expect(reported).toHaveLength(1));
    expect(reported[0]).toEqual({ originProof:expect.stringMatching(/^[a-f0-9]{64}$/),projectKeySha256:expect.stringMatching(/^[a-f0-9]{64}$/) });
    const endpoint="https://synthetic.supabase.co/functions/v1/create-web-checkout";
    const checkoutBodies:Record<string,unknown>[]=[];
    const wire:typeof fetch=async(_input,init)=>{
      checkoutBodies.push(JSON.parse(String(init?.body)));
      return new Response("{}",{ headers:{ "content-type":"application/json" } });
    };
    const token=`header.${btoa(JSON.stringify({ sub:account }))}.signature`;
    const supabase=createClient("https://synthetic.supabase.co","synthetic-public",{
      accessToken:async()=>token,global:{ fetch:withCheckoutAnalytics(wire,endpoint,capture) },
    });
    const body={ access_schema:1,surface:isFirefox ? "firefox_desktop" : "chrome_desktop",build:"3.0.0" };
    await supabase.functions.invoke("create-web-checkout",{ body });
    expect(checkoutBodies[0]?.analytics).toEqual(reported[0]);
    const prior=await capture(); expect(prior).not.toBeNull();
    await t.send({ action:"setSharing",enabled:false });
    expect(prior?.current()).toBe(false); expect(prior?.signal.aborted).toBe(true);
    clock+=30_001;
    await t.send({ action:"track",name:"opened",props:{ where:"options" } });
    await t.bg.flushWhenReady();
    expect(reported).toHaveLength(1);
    await supabase.functions.invoke("create-web-checkout",{ body });
    expect(checkoutBodies[1]).toEqual(body);
    expect(await capture()).toBeNull();
    expect(JSON.stringify(reported)).not.toContain(account);
    expect(JSON.stringify(reported)).not.toContain(subject);
    t.bg.stop();
  });
});

describe("ISS-0115 (22 Oct): a popup that wakes the service worker keeps its opened", () => {
  const OPENED = { action: "track", name: "opened", props: { where: "popup" } };
  const TOGGLED = { action: "track", name: "service_toggled", props: { service: "youtube", enabled: false, where: "popup" } };
  const sentAs = (t: ReturnType<typeof setup>) =>
    t.fetch.mock.calls.flatMap((call) =>
      (
        JSON.parse(String((call[1] as RequestInit).body)) as {
          batch: { event: string; properties: { distinct_id?: unknown } }[];
        }
      ).batch.map((e) => [e.event, e.properties.distinct_id]),
    );
  /** The worker was unloaded; the popup's opening wakes a new one. Its start-up account read
   * (signed out) is in flight when the popup's `opened` arrives, and lands just after. */
  const wake = async (before: ReturnType<typeof setup>, isFirefox: boolean) => {
    const t = setup(createDefaultOnBackgroundAnalytics, { local: before.local, isFirefox, granted: before.browser.granted });
    let answer!: (account: string | null) => void;
    t.bg.onStart(new Promise<string | null>((resolve) => (answer = resolve)));
    const opened = t.send(OPENED);
    answer(null);
    await opened;
    return t;
  };

  for (const isFirefox of [false, true])
    it(`${isFirefox ? "Firefox" : "Chrome"}: after Off then On, a woken worker reports the popup's opened under the new id`, async () => {
      const t = setup(createDefaultOnBackgroundAnalytics, { isFirefox, granted: true });
      await install(t);
      await expectInstallReported(t);
      const oldId = t.permission()!.provider.anonymousId;
      expect(await t.send({ action: "setSharing", enabled: false })).toBe(false);
      t.browser.granted = true; // Firefox: the page's permission request was accepted
      expect(await t.send({ action: "setSharing", enabled: true })).toBe(true);
      const newId = t.permission()!.provider.anonymousId;
      expect(newId).not.toBe(oldId);
      await t.bg.flushWhenReady();

      for (let session = 0; session < 2; session++) {
        const woken = await wake(t, isFirefox);
        await woken.send(TOGGLED);
        await woken.bg.flushWhenReady();
        expect(sentAs(woken)).toEqual(expect.arrayContaining([["opened", newId], ["master_toggled", newId]]));
        expect(woken.bodies()).not.toContain(oldId);
      }
    });

  it("NEGATIVE CONTROL: Chrome with sharing Off, a woken worker sends and queues nothing", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics);
    await install(t);
    await expectInstallReported(t);
    expect(await t.send({ action: "setSharing", enabled: false })).toBe(false);
    const woken = await wake(t, false);
    await woken.send(TOGGLED);
    await woken.bg.flushWhenReady();
    expect(woken.fetch).not.toHaveBeenCalled();
    expect(woken.queue()).toEqual([]);
  });

  it("NEGATIVE CONTROL: Chrome, an event observed as a woken worker lets go of a signed-in account is never sent", async () => {
    const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const t = setup(createDefaultOnBackgroundAnalytics);
    await install(t);
    await expectInstallReported(t);
    t.bg.onStart(ACCOUNT); // signed in (no per-device identity in this build: its use waits)
    // The hold is saved before the worker is unloaded.
    await vi.waitFor(() => expect((t.local.data[STATE_KEY] as { heldFor?: unknown } | undefined)?.heldFor).toBeTruthy());
    t.bg.stop();
    // Signed out while the worker slept; the popup wakes a new one.
    const woken = setup(createDefaultOnBackgroundAnalytics, { local: t.local });
    let answer!: (account: string | null) => void;
    woken.bg.onStart(new Promise<string | null>((resolve) => (answer = resolve)));
    const opened = woken.send(OPENED); // possibly the departed account's use
    answer(null);
    await opened;
    await woken.send(TOGGLED); // after the sign-out: anonymous
    await woken.bg.flushWhenReady();
    expect(woken.sent()).toContain("master_toggled");
    expect(woken.sent()).not.toContain("opened");
  });
});
