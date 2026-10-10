import { describe, expect, it, vi } from "vitest";
import { CONSENT_KEY, QUEUE_KEY, USAGE_PERMISSION_VERSION, readAnalyticsPermission, type AnalyticsKeyValue } from "@still/core/analytics";
import { ANALYTICS_MESSAGE_KIND, createBackgroundAnalytics, type BackgroundAnalyticsDeps } from "../analytics.js";
import { createDefaultOnBackgroundAnalytics } from "../default-on-analytics.js";

// A V3 build: the default-on basis is compiled in (core build-basis.ts reads the build flags).
vi.mock("../../../core/src/analytics/build-basis.js", () => ({ USAGE_ON_BY_DEFAULT_BUILD: true }));

// The production wiring, with no test seam: what a V3 Chrome or Firefox package actually runs.

const RUNTIME_ID = "still-id";
const ORIGIN = "chrome-extension://still-id/";
const PAGE = { id: RUNTIME_ID, url: `${ORIGIN}options.html` };

function memory(initial: Record<string, unknown> = {}): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data = { ...initial };
  return { data, get: async (k) => structuredClone(data[k]) ?? null, set: async (k, v) => void (data[k] = structuredClone(v)) };
}

type Factory = typeof createDefaultOnBackgroundAnalytics;

function setup(factory: Factory, over: { isFirefox?: boolean; granted?: boolean; local?: ReturnType<typeof memory> } = {}) {
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
  return { bg, local, browser, fetch, send, queue, sent, permission, settle };
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

describe("V3 Chrome: on by default, with the one-time notice and a working switch", () => {
  it("reports from install, even when the start's account answer lands right after onInstalled, and the notice shows until acknowledged", async () => {
    const t = setup(createDefaultOnBackgroundAnalytics);
    await install(t);
    expect(t.permission()).toMatchObject({ state: "granted", version: USAGE_PERMISSION_VERSION });
    expect(t.sent()).toEqual(expect.arrayContaining(["installed", "setup_completed"]));
    const request = t.fetch.mock.calls[0]!;
    expect(String(request[0])).toBe("https://us.i.posthog.com/batch/");
    expect(String((request[1] as RequestInit).body)).toContain('"build_channel":"test"');

    expect(await t.send({ action: "sharing" })).toEqual({ enabled: true, noticeNeeded: true });
    await t.send({ action: "acknowledgeNotice" });
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

  it("while signed in, events wait unsent: per-device identities are not wired (owner decision 50)", async () => {
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
    expect(t.sent()).toEqual(expect.arrayContaining(["installed", "setup_completed"]));
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
