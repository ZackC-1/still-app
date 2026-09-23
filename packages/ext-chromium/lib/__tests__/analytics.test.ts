import { describe, expect, it, vi } from "vitest";
import { QUEUE_KEY, type AnalyticsKeyValue } from "@still/core/analytics";
import { ANALYTICS_MESSAGE_KIND, createBackgroundAnalytics, createPageAnalytics } from "../analytics.js";

const RUNTIME_ID = "still-id";
const ORIGIN = "chrome-extension://still-id/";
const PAGE = { id: RUNTIME_ID, url: `${ORIGIN}popup.html` };
const CONTENT = { id: RUNTIME_ID, url: "https://www.youtube.com/shorts/abc", tab: {} };

function memory(initial: Record<string, unknown> = {}): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data = { ...initial };
  return { data, get: async (k) => structuredClone(data[k]), set: async (k, v) => void (data[k] = structuredClone(v)) };
}

function setup(over: { isFirefox?: boolean; granted?: boolean; shared?: AnalyticsKeyValue; identifyOnServer?: () => Promise<void> } = {}) {
  const local = memory();
  let n = 0;
  const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  const bg = createBackgroundAnalytics(
    {
      isFirefox: over.isFirefox ?? false,
      config: { key: "phc_test", host: "https://us.i.posthog.com" },
      appVersion: "2.1.0",
      local,
      shared: over.shared ?? memory(),
      firefoxPermissionGranted: async () => over.granted ?? false,
      fetch: fetch as unknown as typeof globalThis.fetch,
      uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      identifyOnServer: over.identifyOnServer,
    },
    RUNTIME_ID,
    ORIGIN,
  );
  const queue = () => ((local.data[QUEUE_KEY] as { event: string; properties: Record<string, unknown> }[] | undefined) ?? []);
  const send = (message: unknown, sender: object) =>
    new Promise<unknown>((resolve) => {
      const async = bg.listener(message, sender, resolve);
      if (!async) resolve(undefined);
    });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { bg, local, queue, send, settle, fetch };
}

describe("background analytics (Chrome)", () => {
  it("a fresh install reports installed, returning when this Google account had Still before", async () => {
    const shared = memory();
    const first = setup({ shared });
    first.bg.onInstalled({ reason: "install" });
    await first.settle();
    await first.bg.client.trackDaily("x", "active", {}); // drain the chain
    expect(first.queue()[0]).toMatchObject({ event: "installed", properties: { returning: false, surface: "chrome", store: "chrome" } });

    const second = setup({ shared });
    second.bg.onInstalled({ reason: "install" });
    await second.settle();
    await second.bg.client.trackDaily("x", "active", {});
    expect(second.queue()[0]).toMatchObject({ event: "installed", properties: { returning: true } });
  });

  it("an update reports from and to versions, and a browser update to the same version reports nothing", async () => {
    const { bg, queue } = setup();
    bg.onInstalled({ reason: "update", previousVersion: "2.0.0" });
    bg.onInstalled({ reason: "update", previousVersion: "2.1.0" });
    bg.onInstalled({ reason: "chrome_update" });
    await bg.client.trackDaily("x", "active", {});
    expect(queue().map((e) => [e.event, e.properties.from])).toEqual([["updated", "2.0.0"], ["active", undefined]]);
  });

  it("content scripts may only name a known service, once a day", async () => {
    const { send, queue, bg } = setup();
    await send({ kind: "blocked", service: "youtube" }, CONTENT);
    await send({ kind: "blocked", service: "youtube" }, CONTENT);
    await send({ kind: "blocked", service: "https://evil.example" }, CONTENT);
    await send({ kind: "blocked", service: "instagram", url: "https://www.instagram.com/reels/x" }, CONTENT);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, CONTENT);
    await bg.client.trackDaily("x", "active", {}); // drain the client's queue of pending work
    const events = queue();
    expect(events.map((e) => [e.event, e.properties.service])).toEqual([
      ["blocking_worked", "youtube"],
      ["blocking_worked", "instagram"],
      ["active", undefined],
    ]);
    expect(JSON.stringify(events)).not.toContain("instagram.com");
  });

  it("only extension pages can reach the page protocol", async () => {
    const { send, queue } = setup();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, CONTENT)).toBeUndefined();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, PAGE)).toBe(true);
    expect(queue().map((e) => e.event)).toEqual(["signed_in"]);
  });

  it("starts on with a one-time notice, and turning it off drops the queue", async () => {
    const { send, queue } = setup();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "sharing" }, PAGE)).toEqual({ enabled: true, noticeNeeded: true });
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "acknowledgeNotice" }, PAGE);
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "sharing" }, PAGE)).toEqual({ enabled: true, noticeNeeded: false });
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "active", props: {} }, PAGE);
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: false }, PAGE)).toBe(false);
    expect(queue()).toEqual([]);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "active", props: {} }, PAGE);
    expect(queue()).toEqual([]);
  });
});

describe("background analytics (Firefox)", () => {
  it("sends and queues nothing until the data-collection permission is granted", async () => {
    const { bg, send, queue, fetch } = setup({ isFirefox: true, granted: false });
    bg.onInstalled({ reason: "install" });
    bg.onStart(null);
    await send({ kind: "blocked", service: "youtube" }, CONTENT);
    await bg.client.flush();
    expect(queue()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "sharing" }, PAGE)).toEqual({ enabled: false, noticeNeeded: false });
  });

  it("reports once the permission is granted", async () => {
    const { send, queue } = setup({ isFirefox: true, granted: true });
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, PAGE);
    expect(queue()[0]).toMatchObject({ event: "signed_in", properties: { surface: "firefox", store: "firefox" } });
  });
});

describe("page analytics", () => {
  it("forwards to the background and reads the sharing state", async () => {
    const sent: Record<string, unknown>[] = [];
    const page = createPageAnalytics(false, async (m) => {
      sent.push(m);
      if (m.action === "sharing") return { enabled: true, noticeNeeded: false };
      if (m.action === "setSharing") return m.enabled;
      return true;
    });
    page.track("opened", { where: "popup" });
    page.identify("u1");
    expect(await page.sharing!()).toEqual({ enabled: true, noticeNeeded: false });
    expect(await page.setSharing!(false)).toBe(false);
    expect(sent.map((m) => m.action)).toEqual(["track", "identify", "sharing", "setSharing"]);
  });

  it("an unreachable background reads as no switch and keeps the previous state", async () => {
    const page = createPageAnalytics(false, async () => { throw new Error("no background"); });
    expect(await page.sharing!()).toBeNull();
    expect(await page.setSharing!(false)).toBe(true);
    expect(() => page.track("opened", { where: "popup" })).not.toThrow();
  });
});

describe("server-side email attach", () => {
  it("runs once per account while sharing is on, and retries after a failure", async () => {
    let fail = true;
    const identifyOnServer = vi.fn(async () => {
      if (fail) throw new Error("offline");
    });
    const { send } = setup({ identifyOnServer });
    const identify = (userId: string) => send({ kind: ANALYTICS_MESSAGE_KIND, action: "identify", userId }, PAGE);
    await identify("u1");
    fail = false;
    await identify("u1");
    await identify("u1");
    await identify("u2");
    expect(identifyOnServer).toHaveBeenCalledTimes(3); // failed u1, retried u1, then u2
  });

  it("never runs while sharing is off", async () => {
    const identifyOnServer = vi.fn(async () => {});
    const { send } = setup({ isFirefox: true, granted: false, identifyOnServer });
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "identify", userId: "u1" }, PAGE);
    expect(identifyOnServer).not.toHaveBeenCalled();
  });
});

describe("account changes outside the popup", () => {
  it("a start that finds no session lets go of the earlier account; an unreadable one keeps it", async () => {
    const { bg, send, queue } = setup();
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "identify", userId: "u1" }, PAGE);
    bg.onStart(undefined);
    await bg.client.trackDaily("x", "active", {});
    expect(await bg.client.signedInAs()).toBe("u1");
    bg.onStart(null);
    await bg.client.trackDaily("y", "active", {});
    expect(await bg.client.signedInAs()).toBeNull();
    const last = queue().at(-1)!;
    expect(last.properties.distinct_id).not.toBe("u1");
  });

  it("deletion from the popup forgets the account's waiting events", async () => {
    const { send, queue } = setup();
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "identify", userId: "u1" }, PAGE);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, PAGE);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "reset", forgetAccount: true }, PAGE);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "account_deleted", props: {} }, PAGE);
    expect(JSON.stringify(queue())).not.toContain("u1");
    expect(queue().map((e) => e.event)).toEqual(["account_deleted"]);
  });
});
