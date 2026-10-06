import { describe, expect, it, vi } from "vitest";
import { CONSENT_KEY, QUEUE_KEY, type AnalyticsKeyValue, type ExtensionAnalyticsHostDeps } from "@still/core/analytics";
import { TEST_PERMISSION, TEST_PRIVACY_POLICY } from "../../../core/src/analytics/__tests__/privacy-fixture.js";
import { ANALYTICS_MESSAGE_KIND, createBackgroundAnalytics, createPageAnalytics } from "../analytics.js";

const HOST_TEST = vi.hoisted(() => ({ inject: true }));

// Explicit controlled test integration, never a production host configuration or provider proof.
// Production wrappers still omit this seam and therefore hold optional analytics.
vi.mock("@still/core/analytics", async (importOriginal) => {
  const real = await importOriginal<typeof import("@still/core/analytics")>();
  return {
    ...real,
    createExtensionAnalyticsHost: (deps: ExtensionAnalyticsHostDeps) =>
      !HOST_TEST.inject
        ? real.createExtensionAnalyticsHost(deps)
        : real.createExtensionAnalyticsHost({
            ...deps,
            privacyPolicy: TEST_PRIVACY_POLICY,
            envelope: { build_channel: "test" },
            permission: async () => real.readAnalyticsPermission(await deps.local.get(CONSENT_KEY)),
            commitPermission: async (enabled) => {
              const authority = real.createStoredConsent(deps.local, false);
              if (enabled) await authority.grant(TEST_PERMISSION.version);
              else await authority.set(false);
            },
          }),
  };
});

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

function setup(
  over: {
    isFirefox?: boolean;
    granted?: boolean;
    shared?: AnalyticsKeyValue;
    identifyOnServer?: () => Promise<void>;
  } = {},
) {
  const local = memory({ [CONSENT_KEY]: TEST_PERMISSION });
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
  bg.onStart(null); // this fixture explicitly confirms no account
  const queue = () =>
    (local.data[QUEUE_KEY] as
      | { event: string; attributeLater?: boolean; properties: Record<string, unknown> }[]
      | undefined) ?? [];
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
    expect(first.queue()[0]).toMatchObject({
      event: "installed",
      properties: { returning: false, surface: "chrome", store: "chrome" },
    });

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
    expect(queue().map((e) => [e.event, e.properties.from])).toEqual([
      ["updated", "2.0.0"],
      ["active", undefined],
    ]);
  });

  it("content scripts cannot record anything, whatever they send", async () => {
    const { send, queue, bg } = setup();
    expect(await send({ kind: "blocked", service: "youtube" }, CONTENT)).toBeUndefined();
    expect(
      await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "active", props: {} }, CONTENT),
    ).toBeUndefined();
    await bg.client.flush();
    expect(queue()).toEqual([]);
  });

  it("only extension pages can reach the page protocol", async () => {
    const { send, queue } = setup();
    expect(
      await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, CONTENT),
    ).toBeUndefined();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, PAGE)).toBe(
      true,
    );
    expect(queue().map((e) => e.event)).toEqual(["signed_in", "active"]);
  });

  it("an explicit fresh test grant has a notice, and withdrawal drops the queue", async () => {
    const { send, queue } = setup();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "sharing" }, PAGE)).toEqual({
      enabled: true,
      noticeNeeded: true,
    });
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "acknowledgeNotice" }, PAGE);
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "sharing" }, PAGE)).toEqual({
      enabled: true,
      noticeNeeded: false,
    });
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
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "sharing" }, PAGE)).toEqual({
      enabled: false,
      noticeNeeded: false,
    });
  });

  it("reports under explicit fresh test consent plus the browser permission", async () => {
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
    const page = createPageAnalytics(false, async () => {
      throw new Error("no background");
    });
    expect(await page.sharing!()).toBeNull();
    expect(await page.setSharing!(false)).toBe(true);
    expect(() => page.track("opened", { where: "popup" })).not.toThrow();
  });
});

describe("server-side email attach", () => {
  // Owner decision 50 (U5-W2): a signed-in device reports under its own server-issued identity, never
  // the account id. This build has no per-device identities wired, so the legacy attach (which sets
  // the email on the account-id person) never runs, and nothing is reported as the account.
  it("never attaches the email to the account id, and never reports as the account", async () => {
    const identifyOnServer = vi.fn(async () => {});
    const { send, queue, local } = setup({ identifyOnServer });
    const identify = (userId: string) => send({ kind: ANALYTICS_MESSAGE_KIND, action: "identify", userId }, PAGE);
    await identify(U1);
    await identify(U1);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, PAGE);
    // Signed-in use waits with no person at all: neither an account nor the anonymous id.
    expect(queue().find((e) => e.event === "signed_in")).toMatchObject({ attributeLater: true });
    expect(queue().find((e) => e.event === "signed_in")!.properties.distinct_id).toBeUndefined();
    await identify(U2);
    // What waited for U1 never goes to U2: it is dropped when U2 signs in.
    expect(queue().find((e) => e.event === "signed_in")).toBeUndefined();
    expect(identifyOnServer).not.toHaveBeenCalled();
    for (const account of [U1, U2]) {
      expect(JSON.stringify(queue())).not.toContain(account);
      expect(JSON.stringify(local.data)).not.toContain(account);
    }
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
    // The fixture confirmed nobody. A sign-in withdraws that at once: signed-in use is never
    // reported as nobody, and (no per-device identity here) never as the account id either.
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "identify", userId: U1 }, PAGE);
    expect(bg.client.accountConfirmed).toBe(false);
    bg.onStart(undefined); // unreadable: the account is kept, nothing becomes nobody
    await bg.client.trackDaily("x", "active", {});
    expect(bg.client.accountConfirmed).toBe(false);
    expect(await bg.client.signedInAs()).toBeNull(); // the account id is never the person
    expect(queue().map((e) => [e.event, e.attributeLater])).toEqual([["active", true]]);
    expect(queue()[0]!.properties.distinct_id).toBeUndefined();
    bg.onStart(null); // no session: the account is let go of
    await bg.client.trackDaily("y", "active", {});
    expect(bg.client.accountConfirmed).toBe(true);
    expect(await bg.client.signedInAs()).toBeNull();
    // The use recorded while signed in went with the account; only use after it is reported.
    expect(queue()).toHaveLength(1);
    const last = queue().at(-1)!;
    expect(last.attributeLater).toBeUndefined();
    expect(last.properties).toMatchObject({ signed_in: false });
    expect(last.properties.distinct_id).not.toBe(U1);
    expect(JSON.stringify(queue())).not.toContain(U1);
  });

  it("deletion from the popup forgets the account's waiting events", async () => {
    const { send, queue } = setup();
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "identify", userId: U1 }, PAGE);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "signed_in", props: {} }, PAGE);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "reset", forgetAccount: true }, PAGE);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "account_deleted", props: {} }, PAGE);
    expect(JSON.stringify(queue())).not.toContain(U1);
    expect(queue().map((e) => e.event)).toEqual([]);
  });
});

describe("activation milestones and active days", () => {
  it("setup completes at install, right after installed; opening the popup is its own event", async () => {
    const { bg, send, queue, settle } = setup();
    bg.onInstalled({ reason: "install" });
    await settle();
    await bg.client.trackDaily("drain", "active", {});
    expect(
      queue()
        .map((e) => e.event)
        .slice(0, 2),
    ).toEqual(["installed", "setup_completed"]);
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
    const local = memory({ [CONSENT_KEY]: TEST_PERMISSION });
    const bg = createBackgroundAnalytics(
      {
        isFirefox: false,
        config: { key: "phc_test", host: "https://us.i.posthog.com" },
        appVersion: "2.1.0",
        local,
        shared: null,
        sharedGraceMs: 0,
        fetch: (async () => {
          throw new TypeError("offline");
        }) as unknown as typeof fetch,
        now: () => clock,
        uuid: (() => {
          let n = 0;
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        })(),
      },
      RUNTIME_ID,
      ORIGIN,
    );
    const send = (m: unknown) =>
      new Promise<unknown>((r) => {
        if (!bg.listener(m, PAGE, r)) r(undefined);
      });
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
    // Signed out: the events are attributed at once, so a later (alarm) send has work to do.
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const requestQuietFlush = vi.fn();
    const local = memory({ [CONSENT_KEY]: TEST_PERMISSION });
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
        uuid: (() => {
          let n = 0;
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        })(),
        requestQuietFlush,
      },
      RUNTIME_ID,
      ORIGIN,
    );
    bg.onStart(null);
    await bg.flushWhenReady();
    bg.onActivity(); // the content script's visit nudge
    await new Promise((r) => setTimeout(r, 20));
    const queued =
      (local.data[QUEUE_KEY] as { event: string; timestamp: string; properties: Record<string, unknown> }[]) ?? [];
    expect(queued.map((e) => e.event)).toEqual(["active"]);
    const midnight = new Date(2026, 8, 23).toISOString();
    for (const e of queued) expect(e.timestamp).toBe(midnight);
    // Nothing anywhere in the payload is more precise than the day.
    const serialized = JSON.stringify(queued);
    const times = serialized.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? [];
    expect(new Set(times)).toEqual(new Set([midnight]));
    await new Promise((r) => setTimeout(r, 1_700)); // past the ordinary flush delay
    expect(fetch).not.toHaveBeenCalled();
    expect(requestQuietFlush).toHaveBeenCalled();
  }, 5_000);

  it("a start held for a signed-in account asks for no alarm: nothing could be sent", async () => {
    // No per-device identity here (owner decision 50): signed-in use waits with no person, so a
    // timed send would do nothing; it is never scheduled.
    const requestQuietFlush = vi.fn();
    const local = memory({ [CONSENT_KEY]: TEST_PERMISSION });
    const bg = createBackgroundAnalytics(
      {
        isFirefox: false,
        config: { key: "phc_test", host: "https://us.i.posthog.com" },
        appVersion: "2.1.0",
        local,
        shared: null,
        sharedGraceMs: 0,
        fetch: vi.fn() as unknown as typeof globalThis.fetch,
        uuid: (() => {
          let n = 0;
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        })(),
        requestQuietFlush,
      },
      RUNTIME_ID,
      ORIGIN,
    );
    bg.onStart(U1);
    await bg.flushWhenReady();
    bg.onActivity();
    await new Promise((r) => setTimeout(r, 20));
    const queued = (local.data[QUEUE_KEY] as { event: string; attributeLater?: boolean }[]) ?? [];
    expect(queued.map((e) => [e.event, e.attributeLater])).toEqual([["active", true]]);
    expect(requestQuietFlush).not.toHaveBeenCalled();
  });
});

describe("installs counted after sharing is allowed", () => {
  it("a Firefox install observed before permission is never backfilled by a later grant", async () => {
    let granted = false;
    const local = memory({ [CONSENT_KEY]: TEST_PERMISSION });
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
        fetch: (async () => {
          throw new TypeError("offline");
        }) as unknown as typeof fetch,
        now: () => clock,
        uuid: (() => {
          let n = 0;
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        })(),
      },
      RUNTIME_ID,
      ORIGIN,
    );
    bg.onStart(null);
    bg.onInstalled({ reason: "install" });
    await new Promise((r) => setTimeout(r, 10));
    expect((local.data[QUEUE_KEY] as unknown[] | undefined) ?? []).toEqual([]);
    clock = new Date(2026, 8, 23, 9, 0).getTime();
    granted = true;
    const send = (m: unknown) =>
      new Promise<unknown>((r) => {
        if (!bg.listener(m, PAGE, r)) r(undefined);
      });
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: true });
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } });
    const events = local.data[QUEUE_KEY] as { event: string; timestamp: string }[];
    const installed = events.filter((e) => e.event === "installed");
    expect(installed).toHaveLength(0);
    expect(events.filter((e) => e.event === "setup_completed")).toHaveLength(0);
    expect(local.data["still:analytics:pending-install"]).toBeUndefined();
  });
});

describe("withdrawal ends optional collection", () => {
  it("turning sharing off never sends a farewell event", async () => {
    const posted: string[] = [];
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      for (const e of JSON.parse(String(init.body)).batch) posted.push(e.event);
      return new Response("{}", { status: 200 });
    });
    const { send } = (() => {
      const local = memory({ [CONSENT_KEY]: TEST_PERMISSION });
      const bg = createBackgroundAnalytics(
        {
          isFirefox: false,
          config: { key: "phc_test", host: "https://us.i.posthog.com" },
          appVersion: "2.1.0",
          local,
          shared: null,
          fetch: fetch as unknown as typeof globalThis.fetch,
          uuid: (() => {
            let n = 0;
            return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
          })(),
        },
        RUNTIME_ID,
        ORIGIN,
      );
      bg.onStart(null);
      return {
        send: (m: unknown) =>
          new Promise<unknown>((r) => {
            if (!bg.listener(m, PAGE, r)) r(undefined);
          }),
      };
    })();
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: false })).toBe(false);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } });
    expect(posted).toEqual([]);
  });
});

describe("the alarm never manufactures a day of use", () => {
  it("a background start alone records no active day; a visit nudge or a Still screen does", async () => {
    const { bg, send, queue } = setup();
    await bg.flushWhenReady().catch(() => {});
    await bg.client.trackDaily("probe", "opened", { where: "popup" }); // drain
    expect(queue().some((e) => e.event === "active")).toBe(false);
    bg.onActivity();
    await new Promise((r) => setTimeout(r, 20));
    expect(queue().filter((e) => e.event === "active")).toHaveLength(1);
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } }, PAGE);
    expect(queue().filter((e) => e.event === "active")).toHaveLength(1); // still one for the day
  });
});

describe("turning sharing off", () => {
  it("takes effect immediately, sends none of the waiting events, and never waits on the network", async () => {
    const bodies: string[] = [];
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      await hang; // the network never answers
      return new Response("{}", { status: 200 });
    });
    const local = memory({ [CONSENT_KEY]: TEST_PERMISSION });
    const bg = createBackgroundAnalytics(
      {
        isFirefox: false,
        config: { key: "phc_test", host: "https://us.i.posthog.com" },
        appVersion: "2.1.0",
        local,
        shared: null,
        sharedGraceMs: 0,
        fetch: fetch as unknown as typeof globalThis.fetch,
        uuid: (() => {
          let n = 0;
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        })(),
      },
      RUNTIME_ID,
      ORIGIN,
    );
    bg.onStart(null); // the start established that nobody is signed in
    const send = (m: unknown) =>
      new Promise<unknown>((r) => {
        if (!bg.listener(m, PAGE, r)) r(undefined);
      });
    await bg.client.track("opened", { where: "popup" }); // waiting, not yet sent
    const off = await Promise.race([
      send({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: false }),
      new Promise((r) => setTimeout(() => r("stalled"), 500)),
    ]);
    expect(off).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    const sentEvents = bodies.flatMap((b) => JSON.parse(b).batch.map((e: { event: string }) => e.event));
    expect(sentEvents).toEqual([]);
    expect((local.data[QUEUE_KEY] as unknown[] | undefined) ?? []).toEqual([]);
    release();
  });
});

describe("server email attach for people already signed in", () => {
  // Without per-device identities (owner decision 50) there is no person to attach an email to: the
  // legacy attach would set it on the account-id person, so neither a background start nor a later
  // Still screen runs it, and the signed-in use waits with no person.
  it("neither a background start nor a later Still screen attaches the email to the account id", async () => {
    const identifyOnServer = vi.fn(async () => {});
    const { bg, send, queue } = setup({ identifyOnServer });
    bg.onStart(U1); // quiet: no server call
    await new Promise((r) => setTimeout(r, 20));
    expect(identifyOnServer).not.toHaveBeenCalled();
    await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "opened", props: { where: "popup" } }, PAGE);
    await new Promise((r) => setTimeout(r, 20));
    expect(identifyOnServer).not.toHaveBeenCalled();
    expect(bg.client.accountConfirmed).toBe(false);
    expect(JSON.stringify(queue())).not.toContain(U1);
    expect(queue().find((e) => e.event === "opened")).toMatchObject({ attributeLater: true });
  });
});

describe("opt-out when the account is unknown", () => {
  it("sends nothing at all, not even the opt-out note", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const local = memory({ [CONSENT_KEY]: TEST_PERMISSION });
    const bg = createBackgroundAnalytics(
      {
        isFirefox: false,
        config: { key: "phc_test", host: "https://us.i.posthog.com" },
        appVersion: "2.1.0",
        local,
        shared: null,
        sharedGraceMs: 0,
        fetch: fetch as unknown as typeof globalThis.fetch,
        uuid: (() => {
          let n = 0;
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        })(),
      },
      RUNTIME_ID,
      ORIGIN,
    );
    bg.onStart(undefined); // the account could not be read
    const send = (m: unknown) =>
      new Promise<unknown>((r) => {
        if (!bg.listener(m, PAGE, r)) r(undefined);
      });
    expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "setSharing", enabled: false })).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("production wrapper readiness remains held", () => {
  it.each([false, true])(
    "no injected capabilities: browser permission alone is insufficient (Firefox %s)",
    async (isFirefox) => {
      HOST_TEST.inject = false;
      try {
        const { bg, local, send, fetch, queue } = setup({ isFirefox, granted: true });
        local.data[CONSENT_KEY] = true; // Actual old On has no reviewed combined purposes or provider binding.
        bg.onInstalled({ reason: "install" });
        await send({ kind: ANALYTICS_MESSAGE_KIND, action: "track", name: "active", props: {} }, PAGE);
        await bg.flushWhenReady();
        expect(fetch).not.toHaveBeenCalled();
        expect(queue()).toEqual([]);
        expect(local.data["still:analytics:install"]).toBeUndefined();
        expect(await send({ kind: ANALYTICS_MESSAGE_KIND, action: "sharing" }, PAGE)).toMatchObject({ enabled: false });
      } finally {
        HOST_TEST.inject = true;
      }
    },
  );
});
