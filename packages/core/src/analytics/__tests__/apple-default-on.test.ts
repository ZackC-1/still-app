import { describe, expect, it, vi } from "vitest";
import { NativeBridge } from "../../native/bridge.js";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
import { LAUNCH_ACCOUNT_WAIT_MS, createAppAnalytics } from "../apple-app.js";
import { AnalyticsClient, QUEUE_KEY, STATE_KEY } from "../client.js";
import { readAnalyticsPermission, type AnalyticsPermission } from "../consent.js";
import { NOTICE_VERSION_KEY, USAGE_PERMISSION_VERSION, createDefaultOnAppAnalytics, supabaseSubjectIssuer } from "../default-on.js";
import type { AnalyticsKeyValue } from "../identity.js";
import { makeController } from "../../ui/__tests__/support/controller-fixtures.js";

// A V3 build: the default-on basis is compiled in (build-basis.ts reads the build flags).
vi.mock("../build-basis.js", () => ({ USAGE_ON_BY_DEFAULT_BUILD: true }));

/** The App Group's one consent slot, as AnalyticsIdentityStore keeps it: unset, a 2.1 Boolean, or
 * the permission record. Behind the real NativeBridge, so its parsing is exercised too. */
function fakeNative(initial?: boolean | AnalyticsPermission) {
  const native = {
    slot: initial as boolean | AnalyticsPermission | undefined,
    noticeSeen: false,
    /** The App Group refuses permission writes (a full disk, a failing native call). */
    refuseCommit: false,
    /** The App Group cannot be read. */
    unreadable: false,
    subject: null as unknown,
    subjectWrites: 0,
    refuseSubject: false,
    /** Reads start failing once the next permission write has been taken. */
    unreadableAfterCommit: false,
    /** Native answers in a later task, as WKWebView does, so reads can overlap. */
    async: false,
  };
  const record = () => (typeof native.slot === "object" ? native.slot : null);
  const permissionReply = () => ({ ok: true, permission: record() ?? (native.slot === false ? false : null) });
  const consent = () => (record() ? record()!.state === "granted" : native.slot !== false);
  const port = {
    postMessage: vi.fn(async (message: Record<string, unknown>): Promise<unknown> => {
      if (native.async) await new Promise((resolve) => setTimeout(resolve, 0));
      switch (message.kind) {
        case "analyticsPermission":
          if (native.unreadable) throw new Error("unreadable");
          return permissionReply();
        case "setAnalyticsSubject":
          if (native.refuseSubject) return JSON.stringify({ ok: false });
          native.subject = message.subject;
          native.subjectWrites += 1;
          return JSON.stringify({ ok: true });
        case "commitAnalyticsPermission": {
          if (native.refuseCommit) return { ok: false };
          const value = message.permission;
          if (value === false) {
            const current = record();
            if (current?.state === "granted")
              native.slot = { ...current, state: "stopped", generation: current.generation + 1 };
            else if (!current) native.slot = false;
          } else {
            const parsed = readAnalyticsPermission(value);
            if (!parsed) return { ok: false };
            native.slot = parsed;
          }
          const reply = permissionReply();
          if (native.unreadableAfterCommit) native.unreadable = true;
          return reply;
        }
        case "analyticsContext":
          return {
            platform: "ios",
            appVersion: "3.0.0",
            installId: "11111111-1111-4111-8111-111111111111",
            anchorId: "22222222-2222-4222-8222-222222222222",
            created: true,
            returning: false,
            previousVersion: null,
            consent: consent(),
            consentAnswered: native.slot !== undefined,
            noticeSeen: native.noticeSeen,
            extensionEnabled: null,
            device: "phone",
          };
        case "acknowledgeAnalyticsNotice":
          native.noticeSeen = true;
          return { ok: true };
        default:
          throw new Error(`unexpected ${String(message.kind)}`);
      }
    }),
  };
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: port } } };
  return { native, record, win, bridge: new NativeBridge(win) };
}

function memory(): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return { data, get: async (k) => structuredClone(data[k]) ?? null, set: async (k, v) => void (data[k] = structuredClone(v)) };
}

function setup(
  initial?: boolean | AnalyticsPermission,
  defaultOn = true,
  issueSubject?: (body: { originProof: string }, signal: AbortSignal, account: string) => Promise<unknown>,
  reuse?: { host: ReturnType<typeof fakeNative>; store: ReturnType<typeof memory> },
) {
  const host = reuse?.host ?? fakeNative(initial);
  const store = reuse?.store ?? memory();
  const fetch = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 200 }));
  let n = 0;
  const app = (defaultOn ? createDefaultOnAppAnalytics : createAppAnalytics)({
    bridge: host.bridge,
    config: { key: "phc_test", host: "https://us.i.posthog.com" },
    envelope: { build_channel: "test" },
    store,
    fetch: fetch as unknown as typeof globalThis.fetch,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    ...(defaultOn ? { win: host.win, issueSubject } : {}),
  });
  const bodies = () => fetch.mock.calls.map((call) => String((call[1] as RequestInit).body));
  const sent = () =>
    fetch.mock.calls.flatMap((call) =>
      (JSON.parse(String((call[1] as RequestInit).body)) as { batch: { event: string }[] }).batch.map((e) => e.event),
    );
  const queue = () => ((store.data[QUEUE_KEY] as { event: string }[] | undefined) ?? []).map((e) => e.event);
  return { ...host, app, store, fetch, sent, bodies, queue };
}

/** A launch as main.ts runs it: the account check finds nobody, and the launch events go out. */
async function launch(t: ReturnType<typeof setup>) {
  await t.app.accountAbsent();
  await t.app.start();
}

describe("root cause: without the default-on wiring the Apple app reports nothing and shows no switch", () => {
  it("has no usage-sharing state and sends nothing, although native reads sharing as on", async () => {
    const t = setup(undefined, false);
    await launch(t);
    expect(await t.app.ui.sharing!()).toBeNull();
    expect(t.fetch).not.toHaveBeenCalled();
  });
});

describe("V3 Apple app: on by default, with the switch as the one control", () => {
  it("delivers offer and purchase actions with native store attribution, then honors the off switch", async () => {
    const t = setup();
    await launch(t);
    t.app.ui.track("paywall_viewed", { trigger: "upgrade_button", where: "app" });
    t.app.ui.track("purchase_started", { purchase_origin: "unknown", product: "still-pro-v3" });
    await vi.waitFor(async () => {
      await t.app.start();
      expect(t.sent()).toEqual(expect.arrayContaining(["paywall_viewed", "purchase_started"]));
    });
    expect(t.bodies().join("\n")).toContain('"purchase_origin":"app_store"');
    await t.app.ui.setSharing!(false);
    t.fetch.mockClear();
    t.app.ui.track("purchase_started", { purchase_origin: "unknown", product: "still-pro-v3" });
    await t.app.start();
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("grants in the App Group at the first launch, reports it, and asks for no notice (2026-10-12)", async () => {
    const t = setup();
    await launch(t);
    expect(t.record()).toMatchObject({ state: "granted", version: USAGE_PERMISSION_VERSION });
    expect(t.sent()).toEqual(["installed", "setup_step", "opened", "active"]);
    expect(String((t.fetch.mock.calls[0]![1] as RequestInit).body)).toContain('"surface":"app-ios"');
    expect(await t.app.ui.sharing!()).toEqual({ enabled: true, noticeNeeded: false });
    t.app.ui.acknowledgeNotice!();
    await Promise.resolve();
    expect(t.native.noticeSeen).toBe(true);
  });

  it("the switch: off stops it in the App Group and discards what waits; on starts again", async () => {
    const t = setup();
    await launch(t);
    const first = t.record()!;
    t.fetch.mockClear();

    t.app.ui.track("opened", { where: "app" });
    expect(await t.app.ui.setSharing!(false)).toBe(false);
    expect(t.record()).toMatchObject({ state: "stopped", origin: first.origin });
    expect(t.queue()).toEqual([]);
    expect(await t.app.ui.sharing!()).toMatchObject({ enabled: false });
    t.app.ui.track("opened", { where: "app" });
    await t.app.start();
    expect(t.fetch).not.toHaveBeenCalled();

    expect(await t.app.ui.setSharing!(true)).toBe(true);
    expect(t.record()).toMatchObject({ state: "granted" });
    expect(t.record()!.origin).not.toBe(first.origin);
    expect(await t.app.ui.sharing!()).toMatchObject({ enabled: true });
    t.app.ui.track("opened", { where: "app" });
    await t.app.recheckSetup();
    await t.app.start(); // the next send goes out without waiting for another launch
    expect(t.sent()).toEqual(expect.arrayContaining(["analytics_choice_made", "opened"]));
  });

  it("after a relaunch with sharing off, the switch is still there (showing off) and turns it back on", async () => {
    const before = setup();
    await launch(before);
    await before.app.ui.setSharing!(false);
    const stopped = before.record()!;

    const t = setup(stopped); // the next launch finds the stop in the App Group
    await launch(t);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(await t.app.ui.sharing!()).toEqual({ enabled: false, noticeNeeded: false });
    expect(await t.app.ui.setSharing!(true)).toBe(true);
    expect(t.record()).toMatchObject({ state: "granted" });
    await t.app.start();
    expect(t.sent()).toEqual(expect.arrayContaining(["analytics_choice_made", "opened"]));
  });

  it("an upgrade from 2.1 keeps a 2.1 off, and keeps the 2.1 default on", async () => {
    const off = setup(false);
    await launch(off);
    expect(off.fetch).not.toHaveBeenCalled();
    expect(off.native.slot).toBe(false);

    const on = setup(true);
    await launch(on);
    expect(on.record()?.state).toBe("granted");
    expect(on.fetch).toHaveBeenCalled();
  });
});

describe("V3 Apple app: review follow-ups", () => {
  it("an off the App Group does not take is a failure: the switch keeps showing on", async () => {
    const t = setup();
    await launch(t);
    t.native.refuseCommit = true;
    await expect(t.app.ui.setSharing!(false)).rejects.toThrow();
    expect(t.record()?.state).toBe("granted");
    t.native.refuseCommit = false;
    expect(await t.app.ui.setSharing!(false)).toBe(false);
    expect(t.record()?.state).toBe("stopped");
  });

  it("hides the switch when the state is unknown, rather than showing off over a granted record", async () => {
    const t = setup();
    await launch(t);
    const granted = t.record()!;
    // A later launch whose native reads fail: nothing is known, so no switch.
    const next = setup(granted);
    next.native.unreadable = true;
    await launch(next);
    expect(await next.app.ui.sharing!()).toBeNull();
    expect(next.fetch).not.toHaveBeenCalled();
  });

  it("a 2.1 upgrader who saw the 2.1 notice stays on and is asked for no notice", async () => {
    const t = setup(true);
    t.native.noticeSeen = true; // the 2.1 notice
    await launch(t);
    expect(await t.app.ui.sharing!()).toEqual({ enabled: true, noticeNeeded: false });
    t.app.ui.acknowledgeNotice!();
    await Promise.resolve();
    expect(t.store.data[NOTICE_VERSION_KEY]).toBe(USAGE_PERMISSION_VERSION);
    expect(await t.app.ui.sharing!()).toEqual({ enabled: true, noticeNeeded: false });
  });
});

describe("V3 Apple app: signed-in devices report under their own identity (owner decision 50)", () => {
  const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SUBJECT = "5ab5ec7a-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("asks the server with only the origin proof, reports under the subject, and shares it with the extension", async () => {
    const issue = vi.fn(async (_body: { originProof: string }, _signal: AbortSignal, _account: string) => ({
      state: "active",
      subject: SUBJECT,
    }));
    const t = setup(undefined, true, issue);
    await t.app.identifyAccount(ACCOUNT);
    await t.app.start();
    expect(issue).toHaveBeenCalledTimes(1);
    const [body, , account] = issue.mock.calls[0]!;
    expect(Object.keys(body)).toEqual(["originProof"]);
    expect(body.originProof).toMatch(/^[0-9a-f]{64}$/);
    expect(account).toBe(ACCOUNT);
    expect(t.sent()).toEqual(expect.arrayContaining(["installed", "opened", "active"]));
    const all = t.bodies().join("\n");
    expect(all).toContain(`"distinct_id":"${SUBJECT}"`);
    expect(all).not.toContain(ACCOUNT); // the account id never reaches PostHog from the client
    expect(all).not.toMatch(/@|email/i); // nor an email: the server attaches it
    expect(t.native.subject).toEqual({ account: ACCOUNT, originProof: body.originProof, subject: SUBJECT });

    // Deleting the account forgets the identity here and in the App Group.
    await t.app.ui.reset({ forgetAccount: true, account: ACCOUNT });
    expect(t.native.subject).toBeNull();
  });

  it("while the server switch is off (503), signed-in use waits on the device and nothing is sent", async () => {
    const issue = vi.fn(async () => {
      throw new Error("503 unavailable");
    });
    const t = setup(undefined, true, issue);
    await t.app.identifyAccount(ACCOUNT);
    await t.app.start();
    expect(issue).toHaveBeenCalled();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.queue().length).toBeGreaterThan(0);
    expect(t.native.subject).toBeNull();
  });

  it("ISS-0108: signed_in, observed under the sign-in's hold, goes to the identity that lands just before it is recorded", async () => {
    let reply!: (value: unknown) => void;
    const issue = vi.fn(() => new Promise<unknown>((resolve) => (reply = resolve)));
    const trackUnchecked = vi.spyOn(AnalyticsClient.prototype, "trackUnchecked");
    const confirm = vi.spyOn(AnalyticsClient.prototype, "confirm");
    try {
      const t = setup(undefined, true, issue);
      await launch(t); // signed out, reporting
      const client = trackUnchecked.mock.instances[0] as unknown as AnalyticsClient;
      const signingIn = t.app.identifyAccount(ACCOUNT); // the session's sign-in
      await vi.waitFor(() => expect(issue).toHaveBeenCalled()); // held; the identity is being asked for
      // Keep the client's operation chain busy (one paused queue read) so the order below is exact.
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const read = t.store.get;
      let armed = true;
      t.store.get = async (key) => {
        if (armed && key === QUEUE_KEY) {
          armed = false;
          await gate;
        }
        return read(key);
      };
      const busy = client.queuedCount();
      trackUnchecked.mockClear();
      confirm.mockClear();
      t.app.ui.track("signed_in", {}); // the controller, right after the verified code
      await vi.waitFor(() => expect(trackUnchecked).toHaveBeenCalled()); // observed under the hold
      reply({ state: "active", subject: SUBJECT }); // the identity lands one step before it is recorded
      await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
      open();
      await busy;
      await signingIn;
      await t.app.start(); // the next send
      expect(t.sent()).toEqual(expect.arrayContaining(["signed_in"]));
      expect(t.bodies().join("\n")).toContain(`"distinct_id":"${SUBJECT}"`);
      expect(t.bodies().join("\n")).not.toContain(ACCOUNT);
    } finally {
      trackUnchecked.mockRestore();
      confirm.mockRestore();
    }
  });
  // The server answers 503 while the subjects switch is off, and test_channel for a QA build once
  // it is on; either way no identity is issued.
  it.each([
    ["test_channel", { data: { state: "test_channel" }, error: null }],
    ["503", { data: null, error: Object.assign(new Error("503"), { context: { status: 503 } }) }],
  ])("ISS-0106: signed in on iPhone, a device with no identity (%s) sends nothing more until it signs out", async (_name, reply) => {
    // The QA sequence: signed-out use reports, a code sign-in completes, and from then on the
    // device is held: no identity is issued, so later events stay queued, across a relaunch too.
    // Signing out lets the account go: what waited is dropped and reporting resumes. Nothing is
    // published to the App Group, so the Safari extension has no identity to follow (its hold is
    // pinned in packages/ext-safari/lib/__tests__/default-on-analytics.test.ts, "waits while the
    // app has no identity for this account under this permission").
    const issuerFor = () => {
      const invoke = vi.fn(async () => reply);
      const issue = supabaseSubjectIssuer(
        {
          auth: { getSession: async () => ({ data: { session: { access_token: "t", user: { id: ACCOUNT } } }, error: null }) },
          functions: { invoke },
        },
        "phc_test",
      );
      return { invoke, issue };
    };
    const first = issuerFor();
    const t = setup(undefined, true, first.issue);
    await launch(t);
    t.app.ui.track("sign_in_opened", {});
    t.app.ui.track("code_requested", {});
    await vi.waitFor(() => expect(t.sent()).toEqual(expect.arrayContaining(["sign_in_opened", "code_requested"])), {
      timeout: 5_000,
    });
    const before = t.fetch.mock.calls.length;

    // Awaited in sequence here for determinism; packages/app-webview/src/main.ts fires
    // identifyAccount without awaiting.
    await t.app.identifyAccount(ACCOUNT); // the session's onAccountEntered, inside the verified code
    await t.app.ui.identify(ACCOUNT);
    t.app.ui.track("signed_in", {});
    t.app.ui.track("opened", { where: "app" });
    await vi.waitFor(() => expect(t.queue()).toEqual(expect.arrayContaining(["signed_in", "opened"])));
    await t.app.recheckSetup(); // a foreground return
    await new Promise((r) => setTimeout(r, 1_700)); // past the client's send delay
    expect(first.invoke).toHaveBeenCalledTimes(1); // asked once; the issuer then waits SUBJECT_RETRY_MS
    expect(t.fetch.mock.calls.length).toBe(before);
    expect(t.native.subject).toBeNull();

    // A real relaunch: a new client over the same store and App Group, with a new issuer that is
    // asked once for this launch.
    const second = issuerFor();
    const next = setup(undefined, true, second.issue, { host: t, store: t.store });
    await next.app.identifyAccount(ACCOUNT);
    await next.app.start();
    await next.app.recheckSetup();
    await new Promise((r) => setTimeout(r, 1_700));
    expect(second.invoke).toHaveBeenCalledTimes(1);
    expect(next.fetch).not.toHaveBeenCalled();
    expect(next.native.subject).toBeNull();
    expect(next.queue()).toContain("signed_in");

    // Signing out lets the account go: what waited for it is dropped, and reporting resumes.
    await next.app.ui.reset();
    await next.app.start();
    expect(next.fetch.mock.calls.length).toBeGreaterThan(0);
    expect(next.queue()).not.toContain("signed_in");
    expect(next.sent()).not.toContain("signed_in");
    expect(next.bodies().join("\n")).toContain('"signed_in":false');
  }, 15_000);

  // ISS-0113: a client made when sharing is turned back on is told the account before it records
  // the choice; recorded first, the choice waited unattributed and the account answer dropped it.
  const choiceIds = (t: ReturnType<typeof setup>) =>
    t.bodies().flatMap((body) =>
      (JSON.parse(body) as { batch: { event: string; properties: { distinct_id: string } }[] }).batch
        .filter((e) => e.event === "analytics_choice_made")
        .map((e) => e.properties.distinct_id),
    );

  it("ISS-0113: Off then On while signed in records the choice under this device's identity", async () => {
    const t = setup(undefined, true, async () => ({ state: "active", subject: SUBJECT }));
    await t.app.identifyAccount(ACCOUNT);
    await t.app.start();
    t.fetch.mockClear();
    expect(await t.app.ui.setSharing!(false)).toBe(false);
    expect(await t.app.ui.setSharing!(true)).toBe(true);
    await t.app.start();
    expect(choiceIds(t)).toEqual([SUBJECT]);
    expect(t.bodies().join("\n")).not.toContain(ACCOUNT);
    expect(t.queue()).toEqual([]);
  });

  it("ISS-0113: signed out while sharing was off, then On records the choice under a new anonymous id", async () => {
    const t = setup(undefined, true, async () => ({ state: "active", subject: SUBJECT }));
    await t.app.identifyAccount(ACCOUNT);
    await t.app.start();
    const before = new Set(t.bodies().flatMap((b) => [...b.matchAll(/"distinct_id":"([^"]+)"/g)].map((m) => m[1])));
    t.fetch.mockClear();
    expect(await t.app.ui.setSharing!(false)).toBe(false);
    await t.app.ui.reset(); // the sign-out, while no client runs
    expect(await t.app.ui.setSharing!(true)).toBe(true);
    await t.app.start();
    const ids = choiceIds(t);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(SUBJECT);
    expect(before.has(ids[0]!)).toBe(false);
    expect(t.bodies().join("\n")).not.toContain(ACCOUNT);
    expect(t.queue()).toEqual([]);
    expect(t.native.subject).toBeNull();
  });

  it("ISS-0113: with no identity issued, the choice after Off then On waits under the hold, never sent unattributed", async () => {
    const t = setup(undefined, true, async () => {
      throw new Error("503 unavailable");
    });
    await t.app.identifyAccount(ACCOUNT);
    await t.app.start();
    expect(await t.app.ui.setSharing!(false)).toBe(false);
    expect(await t.app.ui.setSharing!(true)).toBe(true);
    await t.app.start();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.queue().filter((e) => e === "analytics_choice_made")).toHaveLength(1);
    expect((t.store.data[STATE_KEY] as { heldFor: unknown }).heldFor).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a server stop ends sharing on this device", async () => {
    const t = setup(undefined, true, async () => ({ state: "stopped" }));
    await t.app.identifyAccount(ACCOUNT);
    await t.app.start();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.record()?.state).toBe("stopped");
  });
});

describe("V3 Apple app: the identity the Safari extension follows (review ADV-2, ADV-6)", () => {
  const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SUBJECT = "5ab5ec7a-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const active = async () => ({ state: "active", subject: SUBJECT });

  it("publishes nothing the shared module did not confirm (a reply naming the account itself)", async () => {
    const t = setup(undefined, true, async () => ({ state: "active", subject: ACCOUNT }));
    await t.app.identifyAccount(ACCOUNT);
    await t.app.start();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.native.subject).toBeNull();
  });

  it("republishes a cached identity at the next launch when the App Group no longer holds it", async () => {
    const issue = vi.fn(active);
    const first = setup(undefined, true, issue);
    await first.app.identifyAccount(ACCOUNT);
    await first.app.start();
    expect(first.native.subject).toMatchObject({ account: ACCOUNT, subject: SUBJECT });
    first.native.subject = null; // lost in the App Group
    const next = setup(undefined, true, issue, { host: first, store: first.store });
    await next.app.identifyAccount(ACCOUNT);
    await next.app.start();
    expect(issue).toHaveBeenCalledTimes(1); // the cached identity, no second request
    expect(next.native.subject).toMatchObject({ account: ACCOUNT, subject: SUBJECT });
  });

  it("a write native refuses is tried again", async () => {
    const t = setup(undefined, true, active);
    t.native.refuseSubject = true;
    await t.app.identifyAccount(ACCOUNT);
    await t.app.start();
    expect(t.native.subject).toBeNull();
    t.native.refuseSubject = false;
    await t.app.recheckSetup();
    expect(t.native.subject).toMatchObject({ subject: SUBJECT });
  });

  it("signing out, or turning sharing off, withdraws it from the App Group", async () => {
    const t = setup(undefined, true, active);
    await t.app.identifyAccount(ACCOUNT);
    await t.app.start();
    expect(t.native.subject).not.toBeNull();
    expect(await t.app.ui.setSharing!(false)).toBe(false);
    expect(t.native.subject).toBeNull();

    const u = setup(undefined, true, active);
    await u.app.identifyAccount(ACCOUNT);
    await u.app.start();
    await u.app.ui.reset();
    expect(u.native.subject).toBeNull();
  });

  it("an off whose read-back fails is unknown, not a failure", async () => {
    const t = setup();
    await launch(t);
    t.native.unreadableAfterCommit = true; // the off is taken, then the App Group cannot be read
    await expect(t.app.ui.setSharing!(false)).resolves.toBe(false);
    expect(t.record()?.state).toBe("stopped");
  });
});

describe("ISS-0111: a device whose sharing is off keeps its switch at every launch", () => {
  const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SUBJECT = "5ab5ec7a-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const active = async () => ({ state: "active", subject: SUBJECT });
  /** Let every native reply (each a later task) and what follows it land. */
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** A launch as main.ts runs it: the controller (and its first switch read) before the account
   * check and the launch events, none of them awaited, with native answering in later tasks. */
  async function relaunch(t: ReturnType<typeof setup>) {
    t.native.async = true;
    const { c } = makeController({ analytics: t.app.ui });
    void t.app.accountAbsent();
    void t.app.start();
    await settle();
    return c;
  }

  it("sharing turned off while signed in, then signed out: the relaunched app shows the switch, off", async () => {
    const before = setup(undefined, true, active);
    await before.app.identifyAccount(ACCOUNT);
    await before.app.start();
    expect(await before.app.ui.setSharing!(false)).toBe(false); // Off, while signed in
    await before.app.ui.reset(); // then the sign-out
    await before.app.accountAbsent();
    expect(before.record()).toMatchObject({ state: "stopped" });

    const t = setup(undefined, true, active, { host: before, store: before.store });
    const c = await relaunch(t);
    expect(c.usageSharing).toBe(false); // was null: no "Share usage data" card at all
    expect(t.record()).toMatchObject({ state: "stopped" }); // Off stays Off
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("answers off for every stored shape that means off, whatever else the launch is reading", async () => {
    const granted = setup();
    await launch(granted);
    const record = granted.record()!;
    const shapes: (boolean | AnalyticsPermission)[] = [
      false, // a 2.1 off
      { ...record, state: "stopped", generation: record.generation + 1 },
      { ...record, state: "stopped", version: "0".repeat(64) }, // a stop under an earlier disclosure
    ];
    for (const shape of shapes) {
      const t = setup(shape);
      const c = await relaunch(t);
      expect(c.usageSharing).toBe(false);
      expect(await t.app.ui.sharing!()).toEqual({ enabled: false, noticeNeeded: false });
      expect(t.fetch).not.toHaveBeenCalled();
    }
  });

  it("an off the App Group refused still shows on after a foreground re-read (PR #500 review)", async () => {
    const t = setup();
    await launch(t);
    const { c } = makeController({ analytics: t.app.ui });
    await settle();
    expect(c.usageSharing).toBe(true);
    t.native.refuseCommit = true; // native refuses (or times out) the App Group write
    c.toggleUsageSharing(); // Off: the wrapper retries once, then reports the failure
    await settle();
    expect(c.usageSharing).toBe(true);
    expect(t.record()?.state).toBe("granted");
    await t.app.recheckSetup(); // the next return to the foreground, as main.ts runs it
    await c.refreshUsageSharing();
    expect(c.usageSharing).toBe(true); // the Safari extension still reports: never shown as off
    expect(t.record()?.state).toBe("granted");
  });

  it("an unknown first read does not hide the switch for the session: main.ts reads it again after start", async () => {
    const t = setup(undefined, true);
    t.native.slot = false;
    t.native.unreadable = true; // the controller's first read finds nothing it can trust
    const { c } = makeController({ analytics: t.app.ui });
    await settle();
    expect(c.usageSharing).toBeNull();
    t.native.unreadable = false;
    await t.app.start();
    await c.refreshUsageSharing(); // what main.ts does once start() settles
    expect(c.usageSharing).toBe(false);
  });
});

describe("ISS-0116: the launch's account answer never costs the launch its events", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  it("signed out with sharing on: opened and active are recorded wherever the session check lands", async () => {
    const lost: string[] = [];
    // Native answers in a later task, so the launch takes several turns; the session check (no
    // session) lands at each of them in turn, as main.ts can order it (start() is not awaited).
    for (let delay = 0; delay < 24; delay += 1) {
      const earlier = setup();
      earlier.native.async = true;
      await launch(earlier);
      for (let i = 0; i < 5; i += 1) await tick();
      // The relaunch (a later day: nothing marked today yet), sharing on, nobody signed in.
      const t = setup(undefined, true, undefined, { host: earlier, store: earlier.store });
      t.store.data[QUEUE_KEY] = [];
      const state = t.store.data[STATE_KEY] as { daily: Record<string, string> };
      t.store.data[STATE_KEY] = { ...state, daily: { "once:installed": "done", "once:app_opened": "done" } };
      void t.app.ui.sharing!(); // the controller's first switch read, beside the launch
      const launched = t.app.start();
      for (let i = 0; i < delay; i += 1) await tick();
      await t.app.accountAbsent();
      await launched;
      for (let i = 0; i < 20; i += 1) await tick();
      const recorded = [...t.sent(), ...t.queue()]; // queued ones go out with the next flush
      if (!recorded.includes("opened") || !recorded.includes("active"))
        lost.push(`${delay}: ${recorded.join(", ") || "nothing"}`);
    }
    expect(lost).toEqual([]);
  }, 30_000);

  it("a session read that never answers costs the launch only the wait: opened and active are recorded, and the switch is read again", async () => {
    // Timers are fake; the native and crypto work in between is real, so it is let run (setImmediate).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const settled = async () => {
      for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    try {
      const t = setup();
      const { c } = makeController({ analytics: t.app.ui });
      let done = false;
      // main.ts: start().finally(refreshUsageSwitch). The session read failed, so neither
      // identifyAccount nor accountAbsent is ever called.
      const launched = t.app
        .start()
        .finally(() => c.refreshUsageSharing())
        .then(() => void (done = true));
      await settled();
      await vi.advanceTimersByTimeAsync(LAUNCH_ACCOUNT_WAIT_MS - 1);
      await settled();
      expect(done).toBe(false);
      expect(t.queue()).toEqual([]); // still waiting for the account answer
      await vi.advanceTimersByTimeAsync(1);
      await settled();
      await launched;
      expect(done).toBe(true);
      // Recorded, waiting for an account answer before anything is sent (as before the wait).
      expect(t.queue()).toEqual(expect.arrayContaining(["opened", "active"]));
      expect(t.fetch).not.toHaveBeenCalled();
      expect(c.usageSharing).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
