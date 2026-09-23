import { describe, expect, it, vi } from "vitest";
import { QUEUE_KEY, type AnalyticsKeyValue } from "@still/core/analytics";
import { ANALYTICS_MESSAGE_KIND, createBackgroundAnalytics, createPageAnalytics } from "../analytics.js";

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
      sharedGraceMs: 0,
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

  it("content scripts cannot record anything, whatever they send", async () => {
    const { send, queue, bg } = setup();
    expect(await send({ kind: "blocked", service: "youtube" }, CONTENT)).toBeUndefined();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "active", props: {} }, CONTENT)).toBeUndefined();
    await bg.client.flush();
    expect(queue()).toEqual([]);
  });

  it("only extension pages can reach the page protocol", async () => {
    const { send, queue } = setup();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, CONTENT)).toBeUndefined();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, PAGE)).toBe(true);
    expect(queue().map((e) => e.event)).toEqual(["signed_in", "active"]);
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
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "active", props: {} }, PAGE);
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
    page.identify(U1);
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
    await identify(U1);
    fail = false;
    await identify(U1);
    await identify(U1);
    await identify(U2);
    expect(identifyOnServer).toHaveBeenCalledTimes(3); // failed u1, retried u1, then u2
  });

  it("never runs while sharing is off", async () => {
    const identifyOnServer = vi.fn(async () => {});
    const { send } = setup({ isFirefox: true, granted: false, identifyOnServer });
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "identify", userId: U1 }, PAGE);
    expect(identifyOnServer).not.toHaveBeenCalled();
  });
});

describe("account changes outside the popup", () => {
  it("a start that finds no session lets go of the earlier account; an unreadable one keeps it", async () => {
    const { bg, send, queue } = setup();
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "identify", userId: U1 }, PAGE);
    bg.onStart(undefined);
    await bg.client.trackDaily("x", "active", {});
    expect(await bg.client.signedInAs()).toBe(U1);
    bg.onStart(null);
    await bg.client.trackDaily("y", "active", {});
    expect(await bg.client.signedInAs()).toBeNull();
    const last = queue().at(-1)!;
    expect(last.properties.distinct_id).not.toBe(U1);
  });

  it("deletion from the popup forgets the account's waiting events", async () => {
    const { send, queue } = setup();
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "identify", userId: U1 }, PAGE);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, PAGE);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "reset", forgetAccount: true }, PAGE);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "account_deleted", props: {} }, PAGE);
    expect(JSON.stringify(queue())).not.toContain(U1);
    expect(queue().map((e) => e.event)).toEqual(["account_deleted"]);
  });
});

describe("activation milestones and active days", () => {
  it("setup completes at install, right after installed; opening the popup is its own event", async () => {
    const { bg, send, queue, settle } = setup();
    bg.onInstalled({ reason: "install" });
    await settle();
    await bg.client.trackDaily("drain", "active", {});
    expect(queue().map((e) => e.event).slice(0, 2)).toEqual(["installed", "setup_completed"]);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } }, PAGE);
    expect(queue().filter((e) => e.event === "setup_completed")).toHaveLength(1);
    expect(queue().filter((e) => e.event === "opened")).toHaveLength(1);
  });

  it("an update never reports setup", async () => {
    const { bg, queue } = setup();
    bg.onInstalled({ reason: "update", previousVersion: "2.0.0" });
    await bg.client.trackDaily("drain", "active", {});
    expect(queue().some((e) => e.event === "setup_completed")).toBe(false);
  });

  it("a background that lives past midnight still records the next day's use", async () => {
    let clock = new Date(2026, 8, 23, 23, 0).getTime();
    const local = memory();
    const bg = createBackgroundAnalytics(
      {
        isFirefox: false,
        config: { key: "phc_test", host: "https://us.i.posthog.com" },
        appVersion: "2.1.0",
        local,
        shared: null,
        sharedGraceMs: 0,
        fetch: (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch,
        now: () => clock,
        uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })(),
      },
      RUNTIME_ID,
      ORIGIN,
    );
    const send = (m: unknown) => new Promise<unknown>((r) => { if (!bg.listener(m, PAGE, r)) r(undefined); });
    bg.onStart(null);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } });
    clock += 2 * 3_600_000; // next morning, same worker
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } });
    const actives = ((local.data[QUEUE_KEY] as { event: string }[]) ?? []).filter((e) => e.event === "active");
    expect(actives).toHaveLength(2);
  });

  it("a start that finds the account gone drops that account's waiting events", async () => {
    const { bg, send, queue } = setup();
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "identify", userId: U1 }, PAGE);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, PAGE);
    bg.onStart(null); // deleted from another device
    await bg.client.trackDaily("drain2", "active", {});
    expect(JSON.stringify(queue())).not.toContain(U1);
  });
});

describe("background starts never say when a site was visited", () => {
  it("events recorded at a start carry only their day and wait for a later send", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const requestQuietFlush = vi.fn();
    const local = memory();
    const at = new Date(2026, 8, 23, 21, 3, 17).getTime();
    const bg = createBackgroundAnalytics(
      {
        isFirefox: false,
        config: { key: "phc_test", host: "https://us.i.posthog.com" },
        appVersion: "2.1.0",
        local,
        shared: null,
        sharedGraceMs: 0,
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => at,
        uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })(),
        requestQuietFlush,
      },
      RUNTIME_ID,
      ORIGIN,
    );
    bg.onStart(U1);
    await new Promise((r) => setTimeout(r, 20));
    const queued = (local.data[QUEUE_KEY] as { event: string; timestamp: string }[]) ?? [];
    expect(queued.map((e) => e.event)).toEqual(["$identify", "active"]);
    for (const e of queued) expect(e.timestamp).toBe(new Date(2026, 8, 23).toISOString());
    await new Promise((r) => setTimeout(r, 1_700)); // past the ordinary flush delay
    expect(fetch).not.toHaveBeenCalled();
    expect(requestQuietFlush).toHaveBeenCalled();
  }, 5_000);
});

describe("installs counted after sharing is allowed", () => {
  it("a Firefox install with sharing off is counted, on its day, once the permission is granted", async () => {
    let granted = false;
    const local = memory();
    const installAt = new Date(2026, 8, 20, 10, 0).getTime();
    let clock = installAt;
    const bg = createBackgroundAnalytics(
      {
        isFirefox: true,
        config: { key: "phc_test", host: "https://us.i.posthog.com" },
        appVersion: "2.1.0",
        local,
        shared: null,
        sharedGraceMs: 0,
        firefoxPermissionGranted: async () => granted,
        fetch: (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch,
        now: () => clock,
        uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })(),
      },
      RUNTIME_ID,
      ORIGIN,
    );
    bg.onInstalled({ reason: "install" });
    await new Promise((r) => setTimeout(r, 10));
    expect((local.data[QUEUE_KEY] as unknown[] | undefined) ?? []).toEqual([]);
    clock = new Date(2026, 8, 23, 9, 0).getTime();
    granted = true;
    const send = (m: unknown) => new Promise<unknown>((r) => { if (!bg.listener(m, PAGE, r)) r(undefined); });
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: true });
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } });
    const events = (local.data[QUEUE_KEY] as { event: string; timestamp: string }[]);
    const installed = events.filter((e) => e.event === "installed");
    expect(installed).toHaveLength(1);
    expect(installed[0]!.timestamp).toBe(new Date(installAt).toISOString());
    expect(events.filter((e) => e.event === "setup_completed")).toHaveLength(1);
    expect(local.data["still:analytics:pending-install"]).toBeNull();
  });
});

describe("opt-out is measurable", () => {
  it("turning sharing off with Still's switch sends one last event, then nothing", async () => {
    const posted: string[] = [];
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      for (const e of JSON.parse(String(init.body)).batch) posted.push(e.event);
      return new Response("{}", { status: 200 });
    });
    const { send } = (() => {
      const local = memory();
      const bg = createBackgroundAnalytics(
        { isFirefox: false, config: { key: "phc_test", host: "https://us.i.posthog.com" }, appVersion: "2.1.0", local, shared: null,
          fetch: fetch as unknown as typeof globalThis.fetch, uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })() },
        RUNTIME_ID, ORIGIN,
      );
      return { send: (m: unknown) => new Promise<unknown>((r) => { if (!bg.listener(m, PAGE, r)) r(undefined); }) };
    })();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: false })).toBe(false);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } });
    expect(posted).toEqual(["sharing_turned_off"]);
  });
});
