import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_MESSAGE_KIND,
  CONSENT_KEY,
  QUEUE_KEY,
  type AnalyticsKeyValue,
  type AnalyticsPrivacyPolicy,
  type AnalyticsConfig,
  readAnalyticsPermission,
  PRIVACY_CAPABILITIES,
} from "@still/core/analytics";
import {
  TEST_PERMISSION,
  TEST_PRIVACY_POLICY,
} from "../../../core/src/analytics/__tests__/privacy-fixture.js";
import {
  createSafariBackgroundAnalytics,
  createSafariPageAnalytics,
  parseNativeAnalytics,
} from "../analytics.js";

const HOST_TEST = { inject: true };
const backgrounds: ReturnType<typeof createSafariBackgroundAnalytics>[] = [];
afterEach(() => {
  for (const bg of backgrounds.splice(0)) bg.stop();
  vi.useRealTimers();
});

const INSTALL = "11111111-1111-4111-8111-111111111111";
const ANCHOR = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const PAGE = { id: "ext", url: "safari-web-extension://ext/popup.html" };
const CONTENT = { id: "ext", url: "https://m.youtube.com/shorts/x", tab: {} };

function memory(): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k) => structuredClone(data[k]),
    set: async (k, v) => void (data[k] = structuredClone(v)),
  };
}

function setup(
  native: {
    consent?: boolean;
    available?: boolean;
    signedIn?: boolean;
    os?: string;
    platform?: string;
    device?: string;
    contextWait?: Promise<void>;
    platformWait?: Promise<void>;
    accountWait?: Promise<void>;
    installId?: string;
    anchorId?: string;
  } = {},
  local = memory(),
  policy: AnalyticsPrivacyPolicy = TEST_PRIVACY_POLICY,
  config: AnalyticsConfig = {
    key: "phc_test",
    host: "https://us.i.posthog.com",
  },
) {
  if (HOST_TEST.inject && local.data[CONSENT_KEY] === undefined)
    local.data[CONSENT_KEY] = TEST_PERMISSION;
  let consent = native.consent ?? true;
  let account: string | null = native.signedIn ? ACCOUNT : null;
  let clock = 1_000_000;
  const sendNative = vi.fn(async (message: Record<string, unknown>) => {
    if (native.available === false) throw new Error("no app");
    if (message.kind === "analyticsContext") {
      await native.contextWait;
      return {
        analytics: {
          installId: native.installId ?? INSTALL,
          anchorId: native.anchorId ?? ANCHOR,
          consent,
          platform: native.platform,
          device: native.device,
        },
      };
    }
    if (message.kind === "getAccountSyncStatus") {
      await native.accountWait;
      return account
        ? {
            accountSyncStatus: JSON.stringify({
              accountId: account,
              email: null,
              lastSyncedAt: null,
              pendingUpload: false,
              cloudReachable: true,
              updatedAt: 1,
            }),
          }
        : { accountSyncStatus: null };
    }
    return null;
  });
  const bg = createSafariBackgroundAnalytics({
    config,
    appVersion: "2.1.0",
    privacyPolicy: HOST_TEST.inject ? policy : undefined,
    envelope: { build_channel: "test" },
    permission: HOST_TEST.inject
      ? async () =>
          consent ? readAnalyticsPermission(await local.get(CONSENT_KEY)) : null
      : undefined,
    sendNative,
    platform: async () => {
      await native.platformWait;
      return native.os ?? "ios";
    },
    local,
    isTrustedPage: (s) =>
      s.url?.startsWith("safari-web-extension://ext/") === true,
    fetch: (async () => {
      throw new TypeError("offline in tests");
    }) as unknown as typeof fetch,
    now: () => clock,
    uuid: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    })(),
  });
  backgrounds.push(bg);
  const send = (message: unknown, sender: object) =>
    new Promise<unknown>((resolve) => {
      if (!bg.listener(message, sender, resolve)) resolve(undefined);
    });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const events = () =>
    (local.data[QUEUE_KEY] as
      | {
          event: string;
          attributeLater?: boolean;
          properties: Record<string, unknown>;
        }[]
      | undefined) ?? [];
  return {
    bg,
    local,
    send,
    settle,
    events,
    sendNative,
    setConsent: (v: boolean) => void (consent = v),
    setSignedIn: (v: boolean) => void (account = v ? ACCOUNT : null),
    setAccount: (value: string | null) => void (account = value),
    advance: (ms: number) => void (clock += ms),
  };
}

describe("Safari extension analytics", () => {
  it("reports under the fresh provider scope, with the right surface, never as the signed-in account", async () => {
    const { bg, settle, events } = setup({ signedIn: true, os: "mac" });
    bg.onStart();
    await settle();
    bg.onActivity(); // real use: a supported site or the popup nudged the background
    await settle();
    const kinds = events().map((e) => e.event);
    expect(kinds).toEqual(["setup_step", "setup_completed", "active"]);
    expect(events()[0]!.properties).toMatchObject({
      step: "extension_enabled",
    });
    expect(events()[1]!.properties).toMatchObject({
      surface: "safari-macos",
      store: "macos",
      $device_id: INSTALL,
    });
    // Owner decision 50 (U5-W2): the account id is never the person, and this build has no
    // per-device identity, so signed-in use waits with no person (neither the account nor the
    // anonymous id) until one is issued.
    for (const event of events()) {
      expect(event.attributeLater).toBe(true);
      expect(event.properties.distinct_id).toBeUndefined();
    }
    expect(JSON.stringify(events())).not.toContain(ACCOUNT);
    expect(JSON.stringify(events())).not.toContain("$anon_distinct_id");
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
    const open = () =>
      send(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "popup" },
        },
        PAGE,
      );
    await open();
    await settle();
    expect(events()).toEqual([]);
    setConsent(true);
    expect(await open()).toBeUndefined(); // The first confirmed account retires the earlier unknown scope.
    await open(); // A new observation in the established scope is eligible.
    await settle();
    expect(events().map((e) => e.event)).toEqual(["opened", "active"]);
  });

  it("content scripts cannot record anything", async () => {
    const { send, settle, events } = setup();
    expect(
      await send({ kind: "blocked", service: "youtube" }, CONTENT),
    ).toBeUndefined();
    await settle();
    expect(events().filter((e) => e.event !== "setup_step")).toEqual([]);
  });

  it("only popup/options may use the page protocol", async () => {
    const { bg, send, settle, events } = setup();
    bg.onStart();
    await settle();
    expect(
      await send(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "signed_in",
          props: {},
        },
        CONTENT,
      ),
    ).toBeUndefined();
    expect(
      await send(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "popup" },
        },
        PAGE,
      ),
    ).toBe(true);
    await settle();
    expect(events().map((e) => e.event)).toEqual(["opened", "active"]);
  });

  it("outside the app container nothing is reported and nothing waits forever", async () => {
    const { bg, send, settle, events } = setup({ available: false });
    bg.onStart();
    expect(
      await send({ kind: ANALYTICS_MESSAGE_KIND, action: "sharing" }, PAGE),
    ).toBeUndefined();
    await settle();
    expect(events()).toEqual([]);
  });

  it("the popup shows no switch: the app owns it", () => {
    const page = createSafariPageAnalytics(async () => true);
    expect(page.sharing).toBeUndefined();
    expect(page.setSharing).toBeUndefined();
  });

  it("rejects malformed native replies", () => {
    expect(
      parseNativeAnalytics({ analytics: { installId: "x", anchorId: ANCHOR } }),
    ).toBeNull();
    expect(parseNativeAnalytics(null)).toBeNull();
    expect(
      parseNativeAnalytics({
        analytics: { installId: INSTALL, anchorId: ANCHOR },
      }),
    ).toEqual({
      installId: INSTALL,
      anchorId: ANCHOR,
      consent: false,
      platform: null,
      device: null, // no field: off
    });
    expect(
      parseNativeAnalytics({
        analytics: { installId: INSTALL, anchorId: ANCHOR, consent: true },
      })?.consent,
    ).toBe(true);
    expect(
      parseNativeAnalytics({
        analytics: {
          installId: INSTALL,
          anchorId: ANCHOR,
          platform: "ios",
          device: "tablet",
        },
      }),
    ).toMatchObject({ platform: "ios", device: "tablet" });
    expect(
      parseNativeAnalytics({
        analytics: {
          installId: INSTALL,
          anchorId: ANCHOR,
          device: "https://x",
        },
      })?.device,
    ).toBeNull();
  });
});

describe("Safari extension account changes", () => {
  it("lets go of an account the app signed out or deleted, and drops what it recorded meanwhile", async () => {
    const first = setup({ signedIn: true });
    first.bg.onStart();
    await first.settle();
    await first.send(
      {
        kind: ANALYTICS_MESSAGE_KIND,
        action: "track",
        name: "opened",
        props: { where: "popup" },
      },
      PAGE,
    );
    await first.settle();
    // Recorded while signed in: waiting with no person (owner decision 50, no account-id fallback).
    expect(first.events().map((e) => e.event)).toContain("opened");
    expect(first.events().every((e) => e.attributeLater === true)).toBe(true);
    // Next background start: the app reports no account.
    const later = setup({ signedIn: false }, first.local);
    later.bg.onStart();
    await later.settle();
    await later.send(
      {
        kind: ANALYTICS_MESSAGE_KIND,
        action: "track",
        name: "opened",
        props: { where: "popup" },
      },
      PAGE,
    );
    await later.settle();
    // The signed-in use went with the account: it is never given to the anonymous id (a deletion
    // must leave none of it, and signed-in use is never reported as nobody).
    expect(later.events().map((e) => e.event)).toEqual(["opened"]);
    const blocked = later.events()[0]!;
    expect(blocked.attributeLater).toBeUndefined();
    expect(blocked.properties.distinct_id).not.toBe(ACCOUNT);
    expect(blocked.properties.signed_in).toBe(false);
    expect(JSON.stringify(later.events())).not.toContain(ACCOUNT);
  });

  it("an unreadable account status changes nothing", async () => {
    const first = setup({ signedIn: true });
    first.bg.onStart();
    await first.settle();
    await first.send(
      {
        kind: ANALYTICS_MESSAGE_KIND,
        action: "track",
        name: "opened",
        props: { where: "popup" },
      },
      PAGE,
    );
    await first.settle();
    const before = structuredClone(first.local.data);
    const waiting = first.events().length;
    expect(waiting).toBeGreaterThan(0);
    const later = setup({ available: false }, first.local);
    later.bg.onStart();
    await later.settle();
    // Not taken as signed out: what waited for the account is neither dropped nor given to nobody.
    expect(first.local.data).toEqual(before);
    expect(first.events()).toHaveLength(waiting);
    expect(first.events().every((e) => e.attributeLater === true)).toBe(true);
    const state = first.local.data["still:analytics:state"] as {
      userId: string | null;
      held?: boolean;
    };
    expect(state.userId).toBeNull(); // the account id is never the person (owner decision 50)
    expect(state.held).toBe(true);
  });
});

describe("Safari follows the app's account while running", () => {
  it("a sign-out in the app is honoured before the next popup event, without a restart", async () => {
    const { bg, send, settle, events, setSignedIn } = setup({ signedIn: true });
    bg.onStart();
    await settle();
    setSignedIn(false);
    await send(
      {
        kind: ANALYTICS_MESSAGE_KIND,
        action: "track",
        name: "opened",
        props: { where: "popup" },
      },
      PAGE,
    );
    await settle();
    expect(JSON.stringify(events())).not.toContain(ACCOUNT);
    expect(events().find((e) => e.event === "opened")).toBeUndefined();
    await send(
      {
        kind: ANALYTICS_MESSAGE_KIND,
        action: "track",
        name: "opened",
        props: { where: "popup" },
      },
      PAGE,
    );
    await settle();
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
      await settle();
      bg.onActivity();
      await settle();
      const e = events().find((x) => x.event === "active")!;
      expect(e.properties).toMatchObject({
        surface,
        device,
        store: platform === "macos" ? "macos" : "ios",
      });
    });
  }
});

describe("Safari's timed send follows the app's account", () => {
  it("an alarm flush after the app signed out drops the old account's waiting events first", async () => {
    const { bg, send, settle, events, setSignedIn } = setup({ signedIn: true });
    bg.onStart();
    await settle();
    await send(
      {
        kind: ANALYTICS_MESSAGE_KIND,
        action: "track",
        name: "opened",
        props: { where: "popup" },
      },
      PAGE,
    );
    await settle();
    // Waiting for the account (offline), with no person: never the account id (owner decision 50).
    const opened = events().find((e) => e.event === "opened");
    expect(opened).toMatchObject({ attributeLater: true });
    expect(opened!.properties.distinct_id).toBeUndefined();
    expect(JSON.stringify(events())).not.toContain(ACCOUNT);
    setSignedIn(false); // the app signed out while this background slept
    bg.flush(); // the alarm
    await settle();
    await new Promise((r) => setTimeout(r, 30));
    // Dropped with the account, never given to the anonymous id and sent.
    expect(events().find((e) => e.event === "opened")).toBeUndefined();
    expect(events().some((e) => e.attributeLater)).toBe(false);
    expect(JSON.stringify(events())).not.toContain(ACCOUNT);
  });
});

describe("production Safari privacy readiness", () => {
  it("legacy native On alone cannot enable collection when the injected seam is absent", async () => {
    HOST_TEST.inject = false;
    try {
      const { bg, send, settle, events, local, sendNative } = setup({
        consent: true,
        signedIn: true,
      });
      bg.onStart();
      await settle();
      await send(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "popup" },
        },
        PAGE,
      );
      bg.onActivity();
      bg.flush();
      await settle();
      expect(events()).toEqual([]);
      expect(local.data[CONSENT_KEY]).toBeUndefined();
      expect(sendNative).not.toHaveBeenCalled();
    } finally {
      HOST_TEST.inject = true;
    }
  });
});

describe("Safari entry-time authority and bounded bootstrap", () => {
  it("does not perform optional native work on construction or an untrusted/private page", async () => {
    const h = setup();
    expect(h.sendNative).not.toHaveBeenCalled();
    expect(
      h.bg.listener(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "popup" },
        },
        CONTENT,
        () => {},
      ),
    ).toBe(false);
    expect(
      h.bg.listener(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "popup" },
        },
        { ...PAGE, incognito: true },
        () => {},
      ),
    ).toBe(false);
    expect(h.sendNative).not.toHaveBeenCalled();
  });
  it("a held entry cannot acquire a grant made later in the same turn", async () => {
    const local = memory();
    local.data[CONSENT_KEY] = false;
    const h = setup({}, local);
    h.bg.onActivity();
    local.data[CONSENT_KEY] = TEST_PERMISSION;
    await h.settle();
    expect(h.events()).toEqual([]);
    expect(h.sendNative).not.toHaveBeenCalled();
    h.bg.onStart();
    await h.settle();
    h.bg.onActivity();
    await h.settle();
    expect(h.events().map((event) => event.event)).toEqual([
      "setup_step",
      "setup_completed",
      "active",
    ]);
  });
  it("withdrawal/new origin while native metadata waits never backfills the original page event", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setup({ contextWait: pending });
    const event = h.send(
      {
        kind: ANALYTICS_MESSAGE_KIND,
        action: "track",
        name: "opened",
        props: { where: "options" },
      },
      PAGE,
    );
    await Promise.resolve();
    await Promise.resolve();
    h.local.data[CONSENT_KEY] = {
      ...TEST_PERMISSION,
      generation: 2,
      origin: "88888888-8888-4888-8888-888888888888",
    };
    release();
    expect(await event).toBeUndefined();
    expect(h.events()).toEqual([]);
    h.bg.onStart();
    await h.settle();
    expect(
      await h.send(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "popup" },
        },
        PAGE,
      ),
    ).toBe(true);
    expect(
      h.events().find((event) => event.properties.where === "options"),
    ).toBeUndefined();
  });
  it("account A-B-A during a delayed page read never admits the old account generation", async () => {
    const h = setup({ signedIn: true });
    h.bg.onStart();
    await h.settle();
    const original = h.sendNative.getMockImplementation()!;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    h.sendNative.mockImplementation(async (message) => {
      if (message.kind === "getAccountSyncStatus" && first) {
        first = false;
        const captured = await original(message);
        await pending;
        return captured;
      }
      return original(message);
    });
    const old = h.send(
      {
        kind: ANALYTICS_MESSAGE_KIND,
        action: "track",
        name: "opened",
        props: { where: "options" },
      },
      PAGE,
    );
    await h.settle();
    h.setAccount("44444444-4444-4444-8444-444444444444");
    h.bg.onStart();
    await h.settle();
    h.setAccount(ACCOUNT);
    h.bg.onStart();
    await h.settle();
    release();
    expect(await old).toBeUndefined();
    expect(
      h.events().find((event) => event.properties.where === "options"),
    ).toBeUndefined();
    expect(
      await h.send(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "popup" },
        },
        PAGE,
      ),
    ).toBe(true);
  });
  it.each(["native", "platform", "account"] as const)(
    "bounds a hung %s bootstrap and removes every owned timer on stop",
    async (kind) => {
      vi.useFakeTimers();
      const never = new Promise<void>(() => {});
      const h = setup(
        kind === "native"
          ? { contextWait: never }
          : kind === "platform"
            ? { platformWait: never }
            : { accountWait: never },
      );
      const reply = h.send(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "popup" },
        },
        PAGE,
      );
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await reply).toBeUndefined();
      expect(h.events()).toEqual([]);
      h.bg.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("stop during an actual native read resolves the caller, removes its deadline and rejects the late reply", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setup({ contextWait: wait });
    const reply = h.send(
      {
        kind: ANALYTICS_MESSAGE_KIND,
        action: "track",
        name: "opened",
        props: { where: "popup" },
      },
      PAGE,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sendNative).toHaveBeenCalledWith({ kind: "analyticsContext" });
    h.bg.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(await reply).toBeUndefined();
    release();
    await vi.advanceTimersByTimeAsync(0);
    h.bg.onStart();
    h.bg.onActivity();
    expect(h.events()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Safari current capability boundary", () => {
  it.each(PRIVACY_CAPABILITIES)(
    "a missing %s capability prevents all optional native work",
    async (capability) => {
      const capabilities = { ...TEST_PRIVACY_POLICY.capabilities };
      delete capabilities[capability];
      const h = setup({}, memory(), { ...TEST_PRIVACY_POLICY, capabilities });
      h.bg.onStart();
      h.bg.onActivity();
      h.bg.flush();
      await h.send(
        {
          kind: ANALYTICS_MESSAGE_KIND,
          action: "track",
          name: "opened",
          props: { where: "popup" },
        },
        PAGE,
      );
      expect(h.sendNative).not.toHaveBeenCalled();
      expect(h.events()).toEqual([]);
    },
  );
  it("a granted ordinary scope proves hardware metadata once, while each page still checks the native account", async () => {
    const h = setup({ signedIn: true, platform: "macos", device: "desktop" });
    h.bg.onStart();
    await h.settle();
    for (let i = 0; i < 5; i++)
      expect(
        await h.send(
          {
            kind: ANALYTICS_MESSAGE_KIND,
            action: "track",
            name: "opened",
            props: { where: "popup" },
          },
          PAGE,
        ),
      ).toBe(true);
    expect(
      h.sendNative.mock.calls.filter(
        ([message]) => message.kind === "analyticsContext",
      ),
    ).toHaveLength(1);
    expect(
      h.sendNative.mock.calls.filter(
        ([message]) => message.kind === "getAccountSyncStatus",
      ),
    ).toHaveLength(6);
    expect(h.events().filter((event) => event.event === "opened")).toHaveLength(
      5,
    );
    expect(h.events()[0]!.properties).toMatchObject({
      surface: "safari-macos",
      device: "desktop",
      $device_id: TEST_PERMISSION.provider.deviceId,
    });
    // Signed in with no per-device identity: waiting with no person, never the account id.
    expect(h.events()[0]!.attributeLater).toBe(true);
    expect(h.events()[0]!.properties.distinct_id).toBeUndefined();
    expect(JSON.stringify(h.events())).not.toContain(ACCOUNT);
  });
});

it("an unconfigured Safari client performs no optional native work despite synthetic privacy readiness", async () => {
  const h = setup({}, memory(), TEST_PRIVACY_POLICY, {});
  h.bg.onStart();
  h.bg.onActivity();
  h.bg.flush();
  await h.send(
    {
      kind: ANALYTICS_MESSAGE_KIND,
      action: "track",
      name: "opened",
      props: { where: "popup" },
    },
    PAGE,
  );
  expect(h.sendNative).not.toHaveBeenCalled();
  expect(h.events()).toEqual([]);
});

it("native functional IDs never become provider IDs", async () => {
  const installId = "77777777-7777-4777-8777-777777777777";
  const anchorId = "88888888-8888-4888-8888-888888888888";
  const h = setup({ installId, anchorId });
  h.bg.onStart();
  await h.settle();
  expect(
    await h.send(
      {
        kind: ANALYTICS_MESSAGE_KIND,
        action: "track",
        name: "opened",
        props: { where: "popup" },
      },
      PAGE,
    ),
  ).toBe(true);
  expect(
    h.events().find((event) => event.event === "opened")?.properties,
  ).toMatchObject({
    $device_id: TEST_PERMISSION.provider.deviceId,
    distinct_id: TEST_PERMISSION.provider.anonymousId,
  });
  expect(JSON.stringify(h.events())).not.toContain(installId);
  expect(JSON.stringify(h.events())).not.toContain(anchorId);
});

it("withdrawal during an actual native metadata read retires the original event", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = setup({ contextWait: wait });
  const reply = h.send(
    {
      kind: ANALYTICS_MESSAGE_KIND,
      action: "track",
      name: "opened",
      props: { where: "popup" },
    },
    PAGE,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sendNative).toHaveBeenCalledWith({ kind: "analyticsContext" });
  h.local.data[CONSENT_KEY] = false;
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(await reply).toBeUndefined();
  expect(h.events()).toEqual([]);
  expect(
    h.sendNative.mock.calls.filter(
      ([message]) => message.kind === "getAccountSyncStatus",
    ),
  ).toHaveLength(0);
  h.bg.stop();
  expect(vi.getTimerCount()).toBe(0);
});
