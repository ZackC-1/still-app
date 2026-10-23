import { afterEach, describe, expect, it, vi } from "vitest";
import { originProof } from "../../../core/src/analytics/derive.js";
import {
  ANALYTICS_MESSAGE_KIND,
  CONSENT_KEY,
  QUEUE_KEY,
  createDefaultOnUsage,
  readAnalyticsPermission,
  type AnalyticsKeyValue,
} from "@still/core/analytics";
import { createSafariBackgroundAnalytics } from "../analytics.js";
import { defaultOnSafariAnalytics } from "../default-on-analytics.js";

// A V3 build: the default-on basis is compiled in (core build-basis.ts reads the build flags).
vi.mock("../../../core/src/analytics/build-basis.js", () => ({ USAGE_ON_BY_DEFAULT_BUILD: true }));

// The production wiring, with no test seam: the Safari extension follows the Apple app's
// usage-sharing permission, read from the App Group through the native `analyticsPermission` lane.

const backgrounds: ReturnType<typeof createSafariBackgroundAnalytics>[] = [];
afterEach(() => {
  for (const bg of backgrounds.splice(0)) bg.stop();
  vi.unstubAllEnvs();
});

const PAGE = { id: "ext", url: "safari-web-extension://ext/popup.html" };
const OPENED = { kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } };
const TOGGLED = { kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "global_toggled", props: { enabled: false, where: "popup" } };

function memory(): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return { data, get: async (k) => structuredClone(data[k]) ?? null, set: async (k, v) => void (data[k] = structuredClone(v)) };
}

interface Device {
  readonly appGroup: ReturnType<typeof memory>;
  readonly local: ReturnType<typeof memory>;
  /** What the app published to the App Group for its signed-in account (setAnalyticsSubject). */
  readonly appGroupSubject: { value: unknown };
  /** The account the app reports as signed in. */
  readonly account: { value: string | null };
}

function setup(
  options: { lane?: boolean; defaultOn?: boolean; account?: string | null; device?: Device; mac?: boolean } = {},
) {
  const device: Device = options.device ?? {
    appGroup: memory(),
    local: memory(),
    appGroupSubject: { value: null },
    account: { value: options.account ?? null },
  };
  // The app's side of the App Group: its own default-on authority over the shared slot.
  const { appGroup, local, appGroupSubject } = device;
  const app = createDefaultOnUsage({ store: appGroup });
  const fetch = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 200 }));
  const sendNative = vi.fn(async (message: Record<string, unknown>): Promise<unknown> => {
    if (message.kind === "analyticsPermission")
      return options.lane === false ? null : { analyticsPermission: appGroup.data[CONSENT_KEY] ?? null };
    if (message.kind === "analyticsContext")
      return {
        analytics: {
          installId: "11111111-1111-4111-8111-111111111111",
          anchorId: "22222222-2222-4222-8222-222222222222",
          consent: true,
          platform: options.mac ? "macos" : "ios",
          device: options.mac ? "desktop" : "phone",
        },
      };
    if (message.kind === "analyticsSubject") return { analyticsSubject: appGroupSubject.value };
    if (message.kind === "getAccountSyncStatus")
      return device.account.value
        ? {
            accountSyncStatus: JSON.stringify({
              accountId: device.account.value,
              email: null,
              lastSyncedAt: null,
              pendingUpload: false,
              cloudReachable: true,
              updatedAt: 1,
            }),
          }
        : { accountSyncStatus: null };
    return null;
  });
  let n = 0;
  const bg = createSafariBackgroundAnalytics({
    config: { key: "phc_test", host: "https://us.i.posthog.com" },
    appVersion: "3.0.0",
    envelope: { build_channel: "test" },
    sendNative,
    platform: async () => (options.mac ? "mac" : "ios"),
    local,
    isTrustedPage: (s) => s.url?.startsWith("safari-web-extension://ext/") === true,
    fetch: fetch as unknown as typeof globalThis.fetch,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    ...(options.defaultOn === false ? {} : defaultOnSafariAnalytics(sendNative)),
  });
  backgrounds.push(bg);
  const send = (message: unknown) =>
    new Promise<unknown>((resolve) => {
      if (!bg.listener(message, PAGE, resolve)) resolve(undefined);
    });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  /** Until the background has gone quiet: no new native read, request or queued event for 50 ms
   * (bounded). Fixed waits raced the background's asynchronous chain on a slow CI runner. */
  const idle = async () => {
    const mark = () => `${sendNative.mock.calls.length}:${fetch.mock.calls.length}:${JSON.stringify(local.data[QUEUE_KEY] ?? null)}`;
    const end = Date.now() + 3_000;
    for (let last = ""; Date.now() < end; ) {
      const now = mark();
      if (now === last) return;
      last = now;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  /** Wait for something the background does asynchronously to happen (bounded), then assert it. */
  const eventually = (check: () => void) => vi.waitFor(check, { timeout: 3_000, interval: 10 });
  const sent = () =>
    fetch.mock.calls.flatMap((call) =>
      (JSON.parse(String((call[1] as RequestInit).body)) as { batch: { event: string }[] }).batch.map((e) => e.event),
    );
  const queue = () => ((local.data[QUEUE_KEY] as { event: string }[] | undefined) ?? []).map((e) => e.event);
  /** Real use, then the quiet-flush alarm. */
  const use = async () => {
    bg.onStart();
    await idle();
    await send(OPENED);
    bg.flush();
    await idle();
  };
  const bodies = () => fetch.mock.calls.map((call) => String((call[1] as RequestInit).body)).join("\n");
  return { app, appGroup, appGroupSubject, device, local, bg, fetch, sendNative, send, sent, bodies, queue, settle, idle, eventually, use };
}

describe("root cause: the 2.x Safari wiring supplies no permission or policy", () => {
  it("reports nothing even though the app reads sharing as on", async () => {
    const t = setup({ defaultOn: false });
    await t.app.permission(); // the app has granted its default
    await t.use();
    expect(t.fetch).not.toHaveBeenCalled();
  });
});

describe("V3 Safari extension: follows the Apple app's default-on permission", () => {
  it("reports under the app's permission once the app has granted it", async () => {
    const t = setup();
    await t.app.permission();
    await t.use();
    await t.eventually(() => expect(t.sent()).toEqual(expect.arrayContaining(["opened"])));
    const body = String((t.fetch.mock.calls[0]![1] as RequestInit).body);
    expect(body).toContain('"surface":"safari-ios"');
    expect(body).toContain('"build_channel":"test"');
  });

  it("reports nothing before the app has created the permission, and never creates one itself", async () => {
    const t = setup();
    await t.use();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.queue()).toEqual([]);
    expect(t.appGroup.data[CONSENT_KEY]).toBeUndefined();
    expect(t.sendNative.mock.calls.map(([m]) => m.kind)).not.toContain("commitAnalyticsPermission");
  });

  it("stops when the app's switch is turned off: nothing that waited is ever sent", async () => {
    const t = setup();
    await t.app.permission();
    await t.use();
    await t.eventually(() => expect(t.sent()).toEqual(expect.arrayContaining(["opened"])));
    await t.idle();
    t.fetch.mockClear();
    await t.send(OPENED);
    expect(t.queue()).toEqual(expect.arrayContaining(["opened"]));
    await t.app.commit(false);
    t.bg.flush();
    await t.idle();
    expect(t.fetch).not.toHaveBeenCalled();
    // Turned on again in the app: a new permission, and what waited under the old one is discarded
    // before anything is sent (the extension has no switch of its own to discard it at the tap).
    await t.app.commit(true);
    await t.use();
    await t.eventually(() => expect(t.sent()).toContain("opened"));
    await t.idle();
    expect(t.sent().filter((e) => e === "opened")).toHaveLength(1); // only the new use's
  });

  it("an app whose native handler has no permission lane yet gets no reports", async () => {
    const t = setup({ lane: false });
    await t.app.permission();
    await t.use();
    expect(t.fetch).not.toHaveBeenCalled();
  });
});

describe("V3 Safari extension, signed in: the same per-device identity as the app (owner decision 50)", () => {
  const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SUBJECT = "5ab5ec7a-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  // The subject lane is compiled into V3 builds only (an inline build-time check in lib/analytics.ts).
  const v3 = () => vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true");

  it("reports under the identity the app published, never as the account, and never calls the server", async () => {
    v3();
    const t = setup({ account: ACCOUNT });
    const permission = (await t.app.permission())!;
    t.appGroupSubject.value = { account: ACCOUNT, originProof: await originProof(permission.origin), subject: SUBJECT };
    await t.use();
    await t.eventually(() => expect(t.sent()).toEqual(expect.arrayContaining(["opened"])));
    expect(t.bodies()).toContain(`"distinct_id":"${SUBJECT}"`);
    expect(t.bodies()).not.toContain(ACCOUNT);
    expect(t.sendNative.mock.calls.map(([m]) => m.kind)).toContain("analyticsSubject");
  });

  it("waits while the app has no identity for this account under this permission", async () => {
    v3();
    for (const published of [
      null,
      { account: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", originProof: "0".repeat(64), subject: SUBJECT }, // another account
      { account: ACCOUNT, originProof: "0".repeat(64), subject: SUBJECT }, // an earlier permission
    ]) {
      const t = setup({ account: ACCOUNT });
      await t.app.permission();
      t.appGroupSubject.value = published;
      await t.use();
      expect(t.fetch).not.toHaveBeenCalled();
      expect(t.queue()).toEqual(expect.arrayContaining(["opened"]));
    }
  });

  it("a 2.x build never reads the identity lane", async () => {
    const t = setup({ account: ACCOUNT });
    const permission = (await t.app.permission())!;
    t.appGroupSubject.value = { account: ACCOUNT, originProof: await originProof(permission.origin), subject: SUBJECT };
    await t.use();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.sendNative.mock.calls.map(([m]) => m.kind)).not.toContain("analyticsSubject");
  });
});

describe("V3 Safari extension, signed in, with no Still page opened", () => {
  const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SUBJECT = "5ab5ec7a-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const v3 = () => vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true");
  /** Background only: a start, real use on a supported site, then the quiet-flush alarm. */
  const background = async (t: ReturnType<typeof setup>) => {
    t.bg.onStart();
    await t.idle();
    t.bg.onActivity();
    await t.idle();
    t.bg.flush();
    await t.idle();
  };

  it("a background start uses the identity the app published (a local read), so the alarm sends", async () => {
    v3();
    const t = setup({ account: ACCOUNT });
    const permission = (await t.app.permission())!;
    t.appGroupSubject.value = { account: ACCOUNT, originProof: await originProof(permission.origin), subject: SUBJECT };
    await background(t);
    expect(t.sendNative.mock.calls.some(([m]) => m.kind === "track")).toBe(false);
    await t.eventually(() => expect(t.sent()).toEqual(expect.arrayContaining(["active"])));
    expect(t.bodies()).toContain(`"distinct_id":"${SUBJECT}"`);
  });

  it("an identity the app withdrew (deleted elsewhere, or stopped) is not reused at the next start", async () => {
    v3();
    const first = setup({ account: ACCOUNT });
    const permission = (await first.app.permission())!;
    first.appGroupSubject.value = { account: ACCOUNT, originProof: await originProof(permission.origin), subject: SUBJECT };
    await background(first);
    await first.eventually(() => expect(first.bodies()).toContain(SUBJECT));
    first.bg.stop();

    first.appGroupSubject.value = null; // the app cleared it
    const next = setup({ device: first.device });
    await background(next);
    await next.send(OPENED); // even an opened page finds no identity to use
    next.bg.flush();
    await next.idle();
    expect(next.fetch).not.toHaveBeenCalled();
    expect(next.queue()).toEqual(expect.arrayContaining(["opened"])); // waits, bound to the account
    expect(JSON.stringify(next.local.data["still:analytics:subjects"] ?? [])).not.toContain(SUBJECT);
  });

  it("ISS-0108: the first popup event after the app publishes the identity goes to it, not dropped", async () => {
    v3();
    const t = setup({ account: ACCOUNT });
    const permission = (await t.app.permission())!;
    t.bg.onStart(); // signed in, no identity published yet: held for the account
    await t.idle();
    expect(t.fetch).not.toHaveBeenCalled();
    // The app publishes the identity; the popup's next event is observed under the hold, and the
    // popup's own account read then confirms the identity before the event is recorded.
    t.appGroupSubject.value = { account: ACCOUNT, originProof: await originProof(permission.origin), subject: SUBJECT };
    await t.send(OPENED);
    t.bg.flush();
    await t.idle();
    await t.eventually(() => expect(t.sent()).toEqual(expect.arrayContaining(["opened"])));
    expect(t.bodies()).toContain(`"distinct_id":"${SUBJECT}"`);
    expect(t.bodies()).not.toContain(ACCOUNT);
  });

  it("a confirmed sign-out forgets the cached identity of the account that ended", async () => {
    v3();
    const t = setup({ account: ACCOUNT });
    const permission = (await t.app.permission())!;
    t.appGroupSubject.value = { account: ACCOUNT, originProof: await originProof(permission.origin), subject: SUBJECT };
    await background(t);
    await t.eventually(() => expect(JSON.stringify(t.local.data["still:analytics:subjects"])).toContain(SUBJECT));
    t.device.account.value = null;
    t.bg.onStart();
    await t.eventually(() =>
      expect(JSON.stringify(t.local.data["still:analytics:subjects"] ?? [])).not.toContain(SUBJECT),
    );
  });
});

describe("ISS-0115: the popup opened right after the app turns sharing on", () => {
  const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SUBJECT = "5ab5ec7a-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const v3 = () => vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true");
  /** Each sent event with the id it went out under. */
  const sentAs = (t: ReturnType<typeof setup>) =>
    t.fetch.mock.calls.flatMap((call) =>
      (
        JSON.parse(String((call[1] as RequestInit).body)) as {
          batch: { event: string; properties: { distinct_id?: unknown } }[];
        }
      ).batch.map((e) => [e.event, e.properties.distinct_id]),
    );
  const anonymousId = (t: ReturnType<typeof setup>) =>
    readAnalyticsPermission(t.appGroup.data[CONSENT_KEY])!.provider.anonymousId;

  it("keeps the popup's opened, under the new anonymous id, when the background started while sharing was off", async () => {
    v3();
    // Sharing was on once (the app's default) and this device reported under that origin.
    const before = setup();
    await before.app.permission();
    await before.use();
    await before.eventually(() => expect(before.sent()).toContain("opened"));
    const oldId = anonymousId(before);
    before.bg.stop();
    // Turned off in the app. The extension's background starts again while it is off: nothing is
    // read about the account and nothing is confirmed.
    await before.app.commit(false);
    const t = setup({ device: before.device });
    t.bg.onStart();
    await t.idle();
    expect(t.sendNative.mock.calls.map(([m]) => m.kind)).not.toContain("getAccountSyncStatus");
    // Turned on in the app (a new origin and anonymous id), then the popup opens at once and the
    // person flips the YouTube Blocker a moment later.
    await t.app.commit(true);
    const newId = anonymousId(t);
    expect(newId).not.toBe(oldId);
    await t.send(OPENED);
    await t.send(TOGGLED);
    t.bg.flush();
    await t.idle();
    await t.eventually(() =>
      expect(sentAs(t)).toEqual(expect.arrayContaining([["opened", newId], ["global_toggled", newId]])),
    );
    expect(t.bodies()).not.toContain(oldId);
  });

  it("the same on a background that has been running since before sharing was turned on", async () => {
    v3();
    const t = setup();
    await t.app.permission(); // the app's default, never used by this background
    const oldId = anonymousId(t);
    await t.app.commit(false); // off before the background ever started
    t.bg.onStart();
    await t.idle();
    await t.app.commit(true);
    await t.send(OPENED);
    await t.send(TOGGLED);
    t.bg.flush();
    await t.idle();
    const newId = anonymousId(t);
    expect(newId).not.toBe(oldId);
    await t.eventually(() =>
      expect(sentAs(t)).toEqual(expect.arrayContaining([["opened", newId], ["global_toggled", newId]])),
    );
    expect(t.bodies()).not.toContain(oldId);
  });

  it("NEGATIVE CONTROL: what the popup sent while sharing was off is never sent after it is turned on", async () => {
    v3();
    const t = setup();
    await t.app.permission();
    const oldId = anonymousId(t);
    await t.app.commit(false);
    t.bg.onStart();
    await t.idle();
    await t.send(OPENED); // observed while off: discarded, no marker written
    await t.app.commit(true);
    await t.send(TOGGLED);
    t.bg.flush();
    await t.idle();
    await t.eventually(() => expect(t.sent()).toContain("global_toggled"));
    await t.idle();
    expect(t.sent()).not.toContain("opened");
    expect(t.bodies()).not.toContain(oldId);
  });

  it("NEGATIVE CONTROL: an event that arrives as the app's sign-out is confirmed is still dropped, never sent anonymously", async () => {
    v3();
    const first = setup({ account: ACCOUNT });
    const permission = (await first.app.permission())!;
    first.appGroupSubject.value = { account: ACCOUNT, originProof: await originProof(permission.origin), subject: SUBJECT };
    await first.use();
    await first.eventually(() => expect(first.bodies()).toContain(SUBJECT));
    first.bg.stop();
    // Signed out in the app while the background was gone; the popup's event wakes it.
    first.device.account.value = null;
    first.appGroupSubject.value = null;
    const t = setup({ device: first.device });
    await t.send(OPENED); // possibly the departed account's use: its sign-out was not confirmed yet
    t.bg.flush();
    await t.idle();
    await t.send(TOGGLED); // after the sign-out is confirmed: anonymous
    t.bg.flush();
    await t.idle();
    await t.eventually(() => expect(t.sent()).toContain("global_toggled"));
    expect(t.sent()).not.toContain("opened");
    expect(t.bodies()).not.toContain(SUBJECT);
  });

  it("NEGATIVE CONTROL: a sign-in held before a restart is let go of by the sign-out; what arrives then is never sent", async () => {
    v3();
    // Signed in to an account the app has issued no identity for yet: the background holds for it
    // (saved), and what the popup records waits, bound to the account.
    const first = setup({ account: ACCOUNT });
    await first.app.permission();
    first.bg.onStart();
    await first.idle();
    await first.send(TOGGLED);
    first.bg.flush();
    await first.idle();
    expect(first.fetch).not.toHaveBeenCalled();
    expect(first.queue()).toEqual(expect.arrayContaining(["global_toggled"]));
    first.bg.stop();
    // Signed out in the app while Safari had unloaded the background; the popup's event wakes a new one.
    first.device.account.value = null;
    const t = setup({ device: first.device });
    await t.send(OPENED); // possibly the held account's use: the sign-out releases its hold
    t.bg.flush();
    await t.idle();
    expect(t.fetch).not.toHaveBeenCalled(); // under no id: not the account's, not anonymous
    await t.send(TOGGLED); // after the sign-out is confirmed: anonymous, and only this one
    t.bg.flush();
    await t.idle();
    await t.eventually(() => expect(t.sent()).toContain("global_toggled"));
    await t.idle();
    expect(t.sent()).toEqual(expect.not.arrayContaining(["opened"]));
    expect(t.sent().filter((e) => e === "global_toggled")).toHaveLength(1);
  });

  it("NEGATIVE CONTROL: sharing turned off and on again while the sign-out is confirmed: the event goes out under neither id", async () => {
    v3();
    const t = setup();
    await t.app.permission();
    await t.app.commit(false);
    t.bg.onStart(); // started while off: the account is not confirmed
    await t.idle();
    await t.app.commit(true);
    const arrivedUnder = anonymousId(t);
    // Off and on again in the app while this event's own sign-out confirmation is being saved (after
    // the account was read and the event was checked against the permission it arrived under).
    let read = false;
    let flipped = false;
    const original = t.sendNative.getMockImplementation()!;
    t.sendNative.mockImplementation(async (message) => {
      if (message.kind === "getAccountSyncStatus") read = true;
      return original(message);
    });
    const set = t.local.set.bind(t.local);
    t.local.set = async (key, value) => {
      if (read && !flipped && key === "still:analytics:state") {
        flipped = true;
        await t.app.commit(false);
        await t.app.commit(true);
      }
      return set(key, value);
    };
    await t.send(OPENED);
    expect(flipped).toBe(true);
    const newId = anonymousId(t);
    expect(newId).not.toBe(arrivedUnder);
    t.bg.flush();
    await t.idle();
    expect(t.sent()).not.toContain("opened");
    expect(t.bodies()).not.toContain(arrivedUnder);
  });
});

describe("ISS-0115 (22 Oct): a popup that wakes the background keeps its events", () => {
  const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SUBJECT = "5ab5ec7a-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const v3 = () => vi.stubEnv("VITE_MODERN_SETTINGS_SYNC_ENABLED", "true");
  const MASTER = (enabled: boolean) => ({
    kind: ANALYTICS_MESSAGE_KIND,
    action: "track",
    name: "service_toggled",
    props: { service: "youtube", enabled, where: "popup" },
  });
  const sentAs = (t: ReturnType<typeof setup>) =>
    t.fetch.mock.calls.flatMap((call) =>
      (
        JSON.parse(String((call[1] as RequestInit).body)) as {
          batch: { event: string; properties: { distinct_id?: unknown; surface?: unknown } }[];
        }
      ).batch.map((e) => [e.event, e.properties.distinct_id]),
    );
  const anonymousId = (t: ReturnType<typeof setup>) =>
    readAnalyticsPermission(t.appGroup.data[CONSENT_KEY])!.provider.anonymousId;
  /** Safari unloaded the background (no stop: its memory is simply gone); the popup's opening wakes
   * a new one, whose start-up account check runs alongside the popup's `opened`. */
  const wake = (before: ReturnType<typeof setup>, options: { mac?: boolean } = {}) => {
    before.fetch.mockImplementation(() => new Promise<Response>(() => {})); // the old one never sends again
    const t = setup({ device: before.device, ...options });
    t.bg.onStart();
    const opened = t.send(OPENED);
    return { t, opened };
  };

  for (const mac of [false, true])
    it(`${mac ? "Mac" : "iPhone"}: after Off then On in the app, every popup session reports opened and its toggles under the new id`, async () => {
      v3();
      const first = setup({ mac });
      await first.app.permission();
      await first.use();
      await first.eventually(() => expect(first.sent()).toContain("opened"));
      const oldId = anonymousId(first);
      await first.app.commit(false);
      await first.app.commit(true);
      const newId = anonymousId(first);
      expect(newId).not.toBe(oldId);
      // (a) The first popup session after On: opened, then YouTube off and on.
      const one = wake(first, { mac });
      await one.opened;
      await one.t.send(MASTER(false));
      await one.t.send(MASTER(true));
      one.t.bg.flush();
      await one.t.idle();
      await one.t.eventually(() =>
        expect(sentAs(one.t)).toEqual(
          expect.arrayContaining([["opened", newId], ["master_toggled", newId]]),
        ),
      );
      expect(sentAs(one.t).filter(([e]) => e === "master_toggled")).toHaveLength(2);
      expect(one.t.bodies()).toContain(mac ? '"surface":"safari-macos"' : '"surface":"safari-ios"');
      // (c) A later popup session, on another woken background: opened is kept too.
      const two = wake(one.t, { mac });
      await two.opened;
      await two.t.send(MASTER(false));
      two.t.bg.flush();
      await two.t.idle();
      await two.t.eventually(() =>
        expect(sentAs(two.t)).toEqual(expect.arrayContaining([["opened", newId], ["master_toggled", newId]])),
      );
      for (const t of [one.t, two.t]) expect(t.bodies()).not.toContain(oldId);
    });

  it("a woken background keeps the popup's opened without any Off/On too", async () => {
    v3();
    const first = setup();
    await first.app.permission();
    await first.use();
    await first.eventually(() => expect(first.sent()).toContain("opened"));
    const { t, opened } = wake(first);
    await opened;
    t.bg.flush();
    await t.idle();
    await t.eventually(() => expect(t.sent()).toContain("opened"));
  });

  it("two popup events in quick succession are both kept (the second's account check does not drop the first)", async () => {
    v3();
    const first = setup();
    await first.app.permission();
    await first.use();
    await first.eventually(() => expect(first.sent()).toContain("opened"));
    const { t, opened } = wake(first);
    const toggled = t.send(TOGGLED);
    await Promise.all([opened, toggled]);
    t.bg.flush();
    await t.idle();
    await t.eventually(() => expect(t.sent()).toEqual(expect.arrayContaining(["opened", "global_toggled"])));
  });

  it("NEGATIVE CONTROL: while the app's sharing is Off, a woken background sends and queues nothing", async () => {
    v3();
    const first = setup();
    await first.app.permission();
    await first.use();
    await first.eventually(() => expect(first.sent()).toContain("opened"));
    await first.app.commit(false);
    const { t, opened } = wake(first);
    await opened;
    await t.send(MASTER(false));
    t.bg.flush();
    await t.idle();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.queue()).toEqual([]);
  });

  it("NEGATIVE CONTROL: an event observed as a woken background lets go of a signed-out account is never sent", async () => {
    v3();
    const first = setup({ account: ACCOUNT });
    const permission = (await first.app.permission())!;
    first.appGroupSubject.value = { account: ACCOUNT, originProof: await originProof(permission.origin), subject: SUBJECT };
    await first.use();
    await first.eventually(() => expect(first.bodies()).toContain(SUBJECT));
    // Signed out in the app while Safari had unloaded the background.
    first.device.account.value = null;
    first.appGroupSubject.value = null;
    const { t, opened } = wake(first); // possibly the departed account's use
    await opened;
    t.bg.flush();
    await t.idle();
    await t.send(TOGGLED); // after the sign-out is confirmed: anonymous
    t.bg.flush();
    await t.idle();
    await t.eventually(() => expect(t.sent()).toContain("global_toggled"));
    await t.idle();
    expect(t.sent()).not.toContain("opened");
    expect(t.bodies()).not.toContain(SUBJECT);
  });

  it("NEGATIVE CONTROL: Off in the app between queueing and sending drops the event", async () => {
    v3();
    const first = setup();
    await first.app.permission();
    await first.use();
    await first.eventually(() => expect(first.sent()).toContain("opened"));
    const { t, opened } = wake(first);
    await opened;
    await t.idle();
    // Queued (its own flush is 1.5 s away); the app's switch goes Off before it is sent.
    expect(t.queue()).toContain("opened");
    await t.app.commit(false);
    t.bg.flush();
    await new Promise((r) => setTimeout(r, 1_700));
    await t.idle();
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL: a permission read that fails at send time sends nothing", async () => {
    v3();
    const first = setup();
    await first.app.permission();
    await first.use();
    await first.eventually(() => expect(first.sent()).toContain("opened"));
    const { t, opened } = wake(first);
    await opened;
    await t.idle();
    expect(t.queue()).toContain("opened");
    const original = t.sendNative.getMockImplementation()!;
    t.sendNative.mockImplementation(async (message) => {
      if (message.kind === "analyticsPermission") throw new Error("native host unavailable");
      return original(message);
    });
    t.bg.flush();
    await new Promise((r) => setTimeout(r, 1_700));
    await t.idle();
    expect(t.fetch).not.toHaveBeenCalled();
  });
});
