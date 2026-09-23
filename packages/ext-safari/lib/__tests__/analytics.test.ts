import { describe, expect, it, vi } from "vitest";
import { ANALYTICS_MESSAGE_KIND, QUEUE_KEY, type AnalyticsKeyValue } from "@still/core/analytics";
import { createSafariBackgroundAnalytics, createSafariPageAnalytics, parseNativeAnalytics } from "../analytics.js";

const INSTALL = "11111111-1111-4111-8111-111111111111";
const ANCHOR = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const PAGE = { id: "ext", url: "safari-web-extension://ext/popup.html" };
const CONTENT = { id: "ext", url: "https://m.youtube.com/shorts/x", tab: {} };

function memory(): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return { data, get: async (k) => structuredClone(data[k]), set: async (k, v) => void (data[k] = structuredClone(v)) };
}

function setup(native: { consent?: boolean; available?: boolean; signedIn?: boolean; os?: string } = {}, local = memory()) {
  let consent = native.consent ?? true;
  let clock = 1_000_000;
  const sendNative = vi.fn(async (message: Record<string, unknown>) => {
    if (native.available === false) throw new Error("no app");
    if (message.kind === "analyticsContext") return { analytics: { installId: INSTALL, anchorId: ANCHOR, consent } };
    if (message.kind === "getAccountSyncStatus") {
      return native.signedIn
        ? { accountSyncStatus: JSON.stringify({ accountId: ACCOUNT, email: null, lastSyncedAt: null, pendingUpload: false, cloudReachable: true, updatedAt: 1 }) }
        : { accountSyncStatus: null };
    }
    return null;
  });
  const bg = createSafariBackgroundAnalytics({
    config: { key: "phc_test", host: "https://us.i.posthog.com" },
    appVersion: "2.1.0",
    sendNative,
    platform: async () => native.os ?? "ios",
    local,
    isTrustedPage: (s) => s.url?.startsWith("safari-web-extension://ext/") === true,
    fetch: (async () => { throw new TypeError("offline in tests"); }) as unknown as typeof fetch,
    now: () => clock,
    uuid: (() => { let n = 0; return () => `uuid-${++n}`; })(),
  });
  const send = (message: unknown, sender: object) =>
    new Promise<unknown>((resolve) => {
      if (!bg.listener(message, sender, resolve)) resolve(undefined);
    });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const events = () => ((local.data[QUEUE_KEY] as { event: string; properties: Record<string, unknown> }[] | undefined) ?? []);
  return { bg, local, send, settle, events, sendNative, setConsent: (v: boolean) => void (consent = v), advance: (ms: number) => void (clock += ms) };
}

describe("Safari extension analytics", () => {
  it("reports under the app's install, with the right surface, and names the account", async () => {
    const { bg, settle, events } = setup({ signedIn: true, os: "mac" });
    bg.onStart();
    await settle();
    const kinds = events().map((e) => e.event);
    expect(kinds).toEqual(["$identify", "setup_step", "setup_completed", "active"]);
    expect(events()[1]!.properties).toMatchObject({ step: "extension_enabled" });
    expect(events()[2]!.properties).toMatchObject({ surface: "safari-macos", store: "macos", $device_id: INSTALL, distinct_id: ACCOUNT });
    expect(events()[0]!.properties).toMatchObject({ $anon_distinct_id: ANCHOR });
  });

  it("the extension never reports the download itself: that is the app's", async () => {
    const { bg, settle, events } = setup();
    bg.onInstalled({ reason: "install" });
    bg.onInstalled({ reason: "update", previousVersion: "2.0.0" });
    await settle();
    expect(events().map((e) => e.event)).toEqual(["updated"]);
  });

  it("follows the app's switch, re-reading it after a short cache", async () => {
    const { send, settle, events, setConsent, advance } = setup({ consent: false });
    await send({ kind: "blocked", service: "youtube" }, CONTENT);
    await settle();
    expect(events()).toEqual([]);
    setConsent(true);
    advance(31_000);
    await send({ kind: "blocked", service: "youtube" }, CONTENT);
    await settle();
    expect(events().map((e) => [e.event, e.properties.service])).toEqual([["blocking_worked", "youtube"]]);
  });

  it("only popup/options may use the page protocol", async () => {
    const { send, settle, events } = setup();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, CONTENT)).toBeUndefined();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } }, PAGE)).toBe(true);
    await settle();
    expect(events().map((e) => e.event)).toEqual(["opened"]);
  });

  it("outside the app container nothing is reported and nothing waits forever", async () => {
    const { bg, send, settle, events } = setup({ available: false });
    bg.onStart();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "sharing" }, PAGE)).toBeUndefined();
    await settle();
    expect(events()).toEqual([]);
  });

  it("the popup shows no switch: the app owns it", () => {
    const page = createSafariPageAnalytics(async () => true);
    expect(page.sharing).toBeUndefined();
    expect(page.setSharing).toBeUndefined();
  });

  it("rejects malformed native replies", () => {
    expect(parseNativeAnalytics({ analytics: { installId: "x", anchorId: ANCHOR } })).toBeNull();
    expect(parseNativeAnalytics(null)).toBeNull();
    expect(parseNativeAnalytics({ analytics: { installId: INSTALL, anchorId: ANCHOR } })).toEqual({ installId: INSTALL, anchorId: ANCHOR, consent: true });
  });
});

describe("Safari extension account changes", () => {
  it("lets go of an account the app signed out or deleted, with a fresh anonymous id", async () => {
    const first = setup({ signedIn: true });
    first.bg.onStart();
    await first.settle();
    // Next background start: the app reports no account.
    const later = setup({ signedIn: false }, first.local);
    later.bg.onStart();
    await later.settle();
    await later.send({ kind: "blocked", service: "youtube" }, CONTENT);
    await later.settle();
    const blocked = later.events().find((e) => e.event === "blocking_worked")!;
    expect(blocked.properties.distinct_id).not.toBe(ACCOUNT);
    expect(blocked.properties.distinct_id).not.toBe(ANCHOR);
    expect(blocked.properties.signed_in).toBe(false);
  });

  it("an unreadable account status changes nothing", async () => {
    const first = setup({ signedIn: true });
    first.bg.onStart();
    await first.settle();
    const later = setup({ available: false }, first.local);
    later.bg.onStart();
    await later.settle();
    const state = first.local.data["still:analytics:state"] as { userId: string | null };
    expect(state.userId).toBe(ACCOUNT);
  });
});
