import { describe, it, expect, vi } from "vitest";
import { createAppAnalytics, type AppAnalyticsBridge } from "../apple-app.js";
import { QUEUE_KEY } from "../client.js";
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
  previousAnchorId: null,
};

function memory(): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return { data, get: async (k) => structuredClone(data[k]), set: async (k, v) => void (data[k] = structuredClone(v)) };
}

function setup(context: Partial<AnalyticsContextReply> | null = {}, over: { identifyOnServer?: () => Promise<void> } = {}) {
  const store = memory();
  let current = context === null ? null : { ...CONTEXT, ...context };
  const bridge: AppAnalyticsBridge & { setAnalyticsConsent: ReturnType<typeof vi.fn> } = {
    analyticsContext: vi.fn(async () => current),
    setAnalyticsConsent: vi.fn(async (enabled: boolean) => enabled),
    acknowledgeAnalyticsNotice: vi.fn(async () => {}),
  };
  const fetch = vi.fn(async () => { throw new TypeError("offline in tests"); });
  let n = 0;
  const app = createAppAnalytics({
    bridge,
    config: { key: "phc_test", host: "https://us.i.posthog.com" },
    store,
    fetch: fetch as unknown as typeof globalThis.fetch,
    uuid: () => `uuid-${++n}`,
    identifyOnServer: over.identifyOnServer,
  });
  const events = () =>
    ((store.data[QUEUE_KEY] as { event: string; properties: Record<string, unknown> }[] | undefined) ?? []);
  return { app, bridge, events, setContext: (c: Partial<AnalyticsContextReply>) => void (current = { ...current!, ...c }) };
}

describe("Apple app analytics", () => {
  it("a new Mac install reports installed, the app opening and one active day", async () => {
    const { app, events } = setup();
    await app.start();
    expect(events().map((e) => [e.event, e.properties.step ?? e.properties.where ?? e.properties.returning])).toEqual([
      ["installed", false],
      ["setup_step", "app_opened"],
      ["opened", "app"],
      ["active", undefined],
    ]);
    expect(events()[0]!.properties).toMatchObject({ surface: "app-macos", store: "macos", distinct_id: CONTEXT.anchorId });
  });

  it("an update from 2.0 reports updated, not installed", async () => {
    const { app, events } = setup({ previousVersion: "2.0.0" });
    await app.start();
    expect(events()[0]).toMatchObject({ event: "updated", properties: { from: "2.0.0", to: "2.1.0" } });
    expect(events().some((e) => e.event === "installed")).toBe(false);
  });

  it("reports the Safari extension being switched on once, when the person comes back", async () => {
    const { app, events, setContext } = setup();
    await app.start();
    setContext({ extensionEnabled: true });
    await app.recheckSetup();
    await app.recheckSetup();
    expect(events().filter((e) => e.properties.step === "extension_enabled")).toHaveLength(1);
  });

  it("follows the app's switch and turning it off drops the queue", async () => {
    const { app, events, bridge } = setup();
    await app.start();
    expect(await app.ui.sharing!()).toEqual({ enabled: true, noticeNeeded: true });
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
    expect(await app.ui.sharing!()).toEqual({ enabled: false, noticeNeeded: true });
  });

  it("outside the app there is no switch and nothing happens", async () => {
    const { app, events } = setup(null);
    await app.start();
    expect(await app.ui.sharing!()).toBeNull();
    expect(events()).toEqual([]);
  });

  it("identifies a signed-in account and attaches the email server-side once", async () => {
    const identifyOnServer = vi.fn(async () => {});
    const { app, events } = setup({}, { identifyOnServer });
    await app.identifyAccount(U1);
    await app.identifyAccount(U1);
    expect(identifyOnServer).toHaveBeenCalledTimes(1);
    expect(events()[0]).toMatchObject({ event: "$identify", properties: { distinct_id: U1, $anon_distinct_id: CONTEXT.anchorId } });
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

  it("merges the Safari extension's provisional id into the anchor the app adopted", async () => {
    const { app, events } = setup({ previousAnchorId: CONTEXT.installId });
    await app.start();
    const alias = events().find((e) => e.event === "$create_alias")!;
    expect(alias.properties).toMatchObject({ distinct_id: CONTEXT.anchorId, alias: CONTEXT.installId });
  });

  it("any use in the app counts toward the day", async () => {
    const { app, events } = setup();
    app.ui.track("service_toggled", { service: "youtube", enabled: false });
    await app.start();
    expect(events().filter((e) => e.event === "active")).toHaveLength(1);
  });
});
