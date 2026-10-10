import { afterEach, describe, expect, it, vi } from "vitest";
import { originProof } from "../../../core/src/analytics/derive.js";
import {
  ANALYTICS_MESSAGE_KIND,
  CONSENT_KEY,
  QUEUE_KEY,
  createDefaultOnUsage,
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

function setup(options: { lane?: boolean; defaultOn?: boolean; account?: string | null; device?: Device } = {}) {
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
          platform: "ios",
          device: "phone",
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
    platform: async () => "ios",
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
  const sent = () =>
    fetch.mock.calls.flatMap((call) =>
      (JSON.parse(String((call[1] as RequestInit).body)) as { batch: { event: string }[] }).batch.map((e) => e.event),
    );
  const queue = () => ((local.data[QUEUE_KEY] as { event: string }[] | undefined) ?? []).map((e) => e.event);
  /** Real use, then the quiet-flush alarm. */
  const use = async () => {
    bg.onStart();
    await settle();
    await send(OPENED);
    bg.flush();
    await settle();
    await settle();
  };
  const bodies = () => fetch.mock.calls.map((call) => String((call[1] as RequestInit).body)).join("\n");
  return { app, appGroup, appGroupSubject, device, local, bg, fetch, sendNative, send, sent, bodies, queue, settle, use };
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
    expect(t.sent()).toEqual(expect.arrayContaining(["opened"]));
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
    t.fetch.mockClear();
    await t.send(OPENED);
    expect(t.queue()).toEqual(expect.arrayContaining(["opened"]));
    await t.app.commit(false);
    t.bg.flush();
    await t.settle();
    await t.settle();
    expect(t.fetch).not.toHaveBeenCalled();
    // Turned on again in the app: a new permission, and what waited under the old one is discarded
    // before anything is sent (the extension has no switch of its own to discard it at the tap).
    await t.app.commit(true);
    await t.use();
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
    expect(t.sent()).toEqual(expect.arrayContaining(["opened"]));
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
    await t.settle();
    t.bg.onActivity();
    await t.settle();
    t.bg.flush();
    await t.settle();
    await t.settle();
  };

  it("a background start uses the identity the app published (a local read), so the alarm sends", async () => {
    v3();
    const t = setup({ account: ACCOUNT });
    const permission = (await t.app.permission())!;
    t.appGroupSubject.value = { account: ACCOUNT, originProof: await originProof(permission.origin), subject: SUBJECT };
    await background(t);
    expect(t.sendNative.mock.calls.some(([m]) => m.kind === "track")).toBe(false);
    expect(t.sent()).toEqual(expect.arrayContaining(["active"]));
    expect(t.bodies()).toContain(`"distinct_id":"${SUBJECT}"`);
  });

  it("an identity the app withdrew (deleted elsewhere, or stopped) is not reused at the next start", async () => {
    v3();
    const first = setup({ account: ACCOUNT });
    const permission = (await first.app.permission())!;
    first.appGroupSubject.value = { account: ACCOUNT, originProof: await originProof(permission.origin), subject: SUBJECT };
    await background(first);
    expect(first.bodies()).toContain(SUBJECT);
    first.bg.stop();

    first.appGroupSubject.value = null; // the app cleared it
    const next = setup({ device: first.device });
    await background(next);
    await next.send(OPENED); // even an opened page finds no identity to use
    next.bg.flush();
    await next.settle();
    await next.settle();
    expect(next.fetch).not.toHaveBeenCalled();
    expect(next.queue()).toEqual(expect.arrayContaining(["opened"])); // waits, bound to the account
    expect(JSON.stringify(next.local.data["still:analytics:subjects"] ?? [])).not.toContain(SUBJECT);
  });

  it("a confirmed sign-out forgets the cached identity of the account that ended", async () => {
    v3();
    const t = setup({ account: ACCOUNT });
    const permission = (await t.app.permission())!;
    t.appGroupSubject.value = { account: ACCOUNT, originProof: await originProof(permission.origin), subject: SUBJECT };
    await background(t);
    expect(JSON.stringify(t.local.data["still:analytics:subjects"])).toContain(SUBJECT);
    t.device.account.value = null;
    t.bg.onStart();
    await t.settle();
    await t.settle();
    expect(JSON.stringify(t.local.data["still:analytics:subjects"] ?? [])).not.toContain(SUBJECT);
  });
});
