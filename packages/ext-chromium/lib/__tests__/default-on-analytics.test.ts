import { describe, expect, it, vi } from "vitest";
import {
  CONSENT_KEY,
  NOTICE_KEY,
  NOTICE_VERSION_KEY,
  QUEUE_KEY,
  STATE_KEY,
  USAGE_PERMISSION_VERSION,
  readAnalyticsPermission,
  supabaseSubjectIssuer,
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
  } = {},
) {
  const local = over.local ?? memory();
  const browser = { granted: over.granted ?? false, revoked: 0 };
  let n = 0;
  const fetch = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 200 }));
  const deps: BackgroundAnalyticsDeps = {
    isFirefox: over.isFirefox ?? false,
    config: { key: "phc_test", host: "https://us.i.posthog.com" },
    envelope: { build_channel: "test" },
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
  });


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
