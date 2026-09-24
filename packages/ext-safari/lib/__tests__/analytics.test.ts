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

function setup(native: { consent?: boolean; available?: boolean; signedIn?: boolean; os?: string; platform?: string; device?: string } = {}, local = memory()) {
  let consent = native.consent ?? true;
  let signedIn = native.signedIn ?? false;
  let clock = 1_000_000;
  const sendNative = vi.fn(async (message: Record<string, unknown>) => {
    if (native.available === false) throw new Error("no app");
    if (message.kind === "analyticsContext") {
      return { analytics: { installId: INSTALL, anchorId: ANCHOR, consent, platform: native.platform, device: native.device } };
    }
    if (message.kind === "getAccountSyncStatus") {
      return signedIn
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
  return { bg, local, send, settle, events, sendNative, setConsent: (v: boolean) => void (consent = v), setSignedIn: (v: boolean) => void (signedIn = v), advance: (ms: number) => void (clock += ms) };
}

describe("Safari extension analytics", () => {
  it("reports under the app's install, with the right surface, and names the account", async () => {
    const { bg, settle, events } = setup({ signedIn: true, os: "mac" });
    bg.onStart();
    bg.onActivity(); // real use: a supported site or the popup nudged the background
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

  it("follows the app's switch, re-reading it on every event", async () => {
    const { bg, send, settle, events, setConsent } = setup({ consent: false });
    bg.onStart();
    const open = () => send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } }, PAGE);
    await open();
    await settle();
    expect(events()).toEqual([]);
    setConsent(true);
    await open();
    await settle();
    expect(events().map((e) => e.event)).toEqual(["opened", "active"]);
  });

  it("content scripts cannot record anything", async () => {
    const { send, settle, events } = setup();
    expect(await send({ kind: "blocked", service: "youtube" }, CONTENT)).toBeUndefined();
    await settle();
    expect(events().filter((e) => e.event !== "setup_step")).toEqual([]);
  });

  it("only popup/options may use the page protocol", async () => {
    const { bg, send, settle, events } = setup();
    bg.onStart();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, CONTENT)).toBeUndefined();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } }, PAGE)).toBe(true);
    await settle();
    expect(events().map((e) => e.event)).toEqual(["opened", "active"]);
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
    expect(parseNativeAnalytics({ analytics: { installId: INSTALL, anchorId: ANCHOR } })).toEqual({
      installId: INSTALL, anchorId: ANCHOR, consent: false, platform: null, device: null, // no field: off
    });
    expect(parseNativeAnalytics({ analytics: { installId: INSTALL, anchorId: ANCHOR, consent: true } })?.consent).toBe(true);
    expect(parseNativeAnalytics({ analytics: { installId: INSTALL, anchorId: ANCHOR, platform: "ios", device: "tablet" } }))
      .toMatchObject({ platform: "ios", device: "tablet" });
    expect(parseNativeAnalytics({ analytics: { installId: INSTALL, anchorId: ANCHOR, device: "https://x" } })?.device).toBeNull();
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
    await later.send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } }, PAGE);
    await later.settle();
    const blocked = later.events().find((e) => e.event === "opened")!;
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

describe("Safari follows the app's account while running", () => {
  it("a sign-out in the app is honoured before the next popup event, without a restart", async () => {
    const { bg, send, settle, events, setSignedIn } = setup({ signedIn: true });
    bg.onStart();
    await settle();
    setSignedIn(false);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } }, PAGE);
    await settle();
    expect(JSON.stringify(events())).not.toContain(ACCOUNT);
    const opened = events().find((e) => e.event === "opened")!;
    expect(opened.properties.signed_in).toBe(false);
  });
});

describe("Safari on iPhone, iPad and Mac are told apart", () => {
  for (const [platform, device, os, surface] of [
    ["ios", "phone", "ios", "safari-ios"],
    ["ios", "tablet", "mac", "safari-ios"], // an iPad the browser reports as a Mac: native wins
    ["macos", "desktop", "mac", "safari-macos"],
  ] as const) {
    it(`${device} reports surface ${surface} and device ${device}`, async () => {
      const { bg, settle, events } = setup({ platform, device, os });
      bg.onStart();
      bg.onActivity();
      await settle();
      const e = events().find((x) => x.event === "active")!;
      expect(e.properties).toMatchObject({ surface, device, store: platform === "macos" ? "macos" : "ios" });
    });
  }
});

describe("Safari's timed send follows the app's account", () => {
  it("an alarm flush after the app signed out drops the old account's waiting events first", async () => {
    const { bg, send, settle, events, setSignedIn } = setup({ signedIn: true });
    bg.onStart();
    await settle();
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } }, PAGE);
    await settle();
    expect(JSON.stringify(events())).toContain(ACCOUNT); // waiting under the account (offline)
    setSignedIn(false); // the app signed out while this background slept
    bg.flush(); // the alarm
    await settle();
    await new Promise((r) => setTimeout(r, 30));
    expect(JSON.stringify(events())).not.toContain(ACCOUNT);
  });
});
