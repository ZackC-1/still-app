import { afterEach, describe, expect, it, vi } from "vitest";
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
});

const PAGE = { id: "ext", url: "safari-web-extension://ext/popup.html" };
const OPENED = { kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } };

function memory(): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return { data, get: async (k) => structuredClone(data[k]) ?? null, set: async (k, v) => void (data[k] = structuredClone(v)) };
}

function setup(options: { lane?: boolean; defaultOn?: boolean } = {}) {
  // The app's side of the App Group: its own default-on authority over the shared slot.
  const appGroup = memory();
  const app = createDefaultOnUsage({ store: appGroup });
  const local = memory();
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
    if (message.kind === "getAccountSyncStatus") return { accountSyncStatus: null };
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
  return { app, appGroup, bg, fetch, sendNative, send, sent, queue, settle, use };
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
