import { describe, expect, it, vi } from "vitest";
import { NativeBridge } from "../../native/bridge.js";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
import { createAppAnalytics } from "../apple-app.js";
import { QUEUE_KEY } from "../client.js";
import { readAnalyticsPermission, type AnalyticsPermission } from "../consent.js";
import { USAGE_PERMISSION_VERSION, createDefaultOnAppAnalytics } from "../default-on.js";
import type { AnalyticsKeyValue } from "../identity.js";

// A V3 build: the default-on basis is compiled in (build-basis.ts reads the build flags).
vi.mock("../build-basis.js", () => ({ USAGE_ON_BY_DEFAULT_BUILD: true }));

/** The App Group's one consent slot, as AnalyticsIdentityStore keeps it: unset, a 2.1 Boolean, or
 * the permission record. Behind the real NativeBridge, so its parsing is exercised too. */
function fakeNative(initial?: boolean | AnalyticsPermission) {
  const native = { slot: initial as boolean | AnalyticsPermission | undefined, noticeSeen: false };
  const record = () => (typeof native.slot === "object" ? native.slot : null);
  const permissionReply = () => ({ ok: true, permission: record() ?? (native.slot === false ? false : null) });
  const consent = () => (record() ? record()!.state === "granted" : native.slot !== false);
  const port = {
    postMessage: vi.fn(async (message: Record<string, unknown>): Promise<unknown> => {
      switch (message.kind) {
        case "analyticsPermission":
          return permissionReply();
        case "commitAnalyticsPermission": {
          const value = message.permission;
          if (value === false) {
            const current = record();
            if (current?.state === "granted")
              native.slot = { ...current, state: "stopped", generation: current.generation + 1 };
            else if (!current) native.slot = false;
          } else {
            const parsed = readAnalyticsPermission(value);
            if (!parsed) return { ok: false };
            native.slot = parsed;
          }
          return permissionReply();
        }
        case "analyticsContext":
          return {
            platform: "ios",
            appVersion: "3.0.0",
            installId: "11111111-1111-4111-8111-111111111111",
            anchorId: "22222222-2222-4222-8222-222222222222",
            created: true,
            returning: false,
            previousVersion: null,
            consent: consent(),
            consentAnswered: native.slot !== undefined,
            noticeSeen: native.noticeSeen,
            extensionEnabled: null,
            device: "phone",
          };
        case "acknowledgeAnalyticsNotice":
          native.noticeSeen = true;
          return { ok: true };
        default:
          throw new Error(`unexpected ${String(message.kind)}`);
      }
    }),
  };
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: port } } };
  return { native, record, bridge: new NativeBridge(win) };
}

function memory(): AnalyticsKeyValue & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return { data, get: async (k) => structuredClone(data[k]) ?? null, set: async (k, v) => void (data[k] = structuredClone(v)) };
}

function setup(initial?: boolean | AnalyticsPermission, defaultOn = true) {
  const host = fakeNative(initial);
  const store = memory();
  const fetch = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 200 }));
  let n = 0;
  const app = (defaultOn ? createDefaultOnAppAnalytics : createAppAnalytics)({
    bridge: host.bridge,
    config: { key: "phc_test", host: "https://us.i.posthog.com" },
    envelope: { build_channel: "test" },
    store,
    fetch: fetch as unknown as typeof globalThis.fetch,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  const sent = () =>
    fetch.mock.calls.flatMap((call) =>
      (JSON.parse(String((call[1] as RequestInit).body)) as { batch: { event: string }[] }).batch.map((e) => e.event),
    );
  const queue = () => ((store.data[QUEUE_KEY] as { event: string }[] | undefined) ?? []).map((e) => e.event);
  return { ...host, app, fetch, sent, queue };
}

/** A launch as main.ts runs it: the account check finds nobody, and the launch events go out. */
async function launch(t: ReturnType<typeof setup>) {
  await t.app.accountAbsent();
  await t.app.start();
}

describe("root cause: without the default-on wiring the Apple app reports nothing and shows no switch", () => {
  it("has no usage-sharing state and sends nothing, although native reads sharing as on", async () => {
    const t = setup(undefined, false);
    await launch(t);
    expect(await t.app.ui.sharing!()).toBeNull();
    expect(t.fetch).not.toHaveBeenCalled();
  });
});

describe("V3 Apple app: on by default, with the existing notice and switch", () => {
  it("grants in the App Group at the first launch, reports it, and shows the one-time notice", async () => {
    const t = setup();
    await launch(t);
    expect(t.record()).toMatchObject({ state: "granted", version: USAGE_PERMISSION_VERSION });
    expect(t.sent()).toEqual(["installed", "setup_step", "opened", "active"]);
    expect(String((t.fetch.mock.calls[0]![1] as RequestInit).body)).toContain('"surface":"app-ios"');
    expect(await t.app.ui.sharing!()).toEqual({ enabled: true, noticeNeeded: true });
    t.app.ui.acknowledgeNotice!();
    await Promise.resolve();
    expect(t.native.noticeSeen).toBe(true);
  });

  it("the switch: off stops it in the App Group and discards what waits; on starts again", async () => {
    const t = setup();
    await launch(t);
    const first = t.record()!;
    t.fetch.mockClear();

    t.app.ui.track("opened", { where: "app" });
    expect(await t.app.ui.setSharing!(false)).toBe(false);
    expect(t.record()).toMatchObject({ state: "stopped", origin: first.origin });
    expect(t.queue()).toEqual([]);
    expect(await t.app.ui.sharing!()).toMatchObject({ enabled: false });
    t.app.ui.track("opened", { where: "app" });
    await t.app.start();
    expect(t.fetch).not.toHaveBeenCalled();

    expect(await t.app.ui.setSharing!(true)).toBe(true);
    expect(t.record()).toMatchObject({ state: "granted" });
    expect(t.record()!.origin).not.toBe(first.origin);
    expect(await t.app.ui.sharing!()).toMatchObject({ enabled: true });
    t.app.ui.track("opened", { where: "app" });
    await t.app.recheckSetup();
    await t.app.start(); // the next send goes out without waiting for another launch
    expect(t.sent()).toEqual(expect.arrayContaining(["analytics_choice_made", "opened"]));
  });

  it("after a relaunch with sharing off, the switch is still there (showing off) and turns it back on", async () => {
    const before = setup();
    await launch(before);
    await before.app.ui.setSharing!(false);
    const stopped = before.record()!;

    const t = setup(stopped); // the next launch finds the stop in the App Group
    await launch(t);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(await t.app.ui.sharing!()).toEqual({ enabled: false, noticeNeeded: false });
    expect(await t.app.ui.setSharing!(true)).toBe(true);
    expect(t.record()).toMatchObject({ state: "granted" });
    await t.app.start();
    expect(t.sent()).toEqual(expect.arrayContaining(["analytics_choice_made", "opened"]));
  });

  it("an upgrade from 2.1 keeps a 2.1 off, and keeps the 2.1 default on", async () => {
    const off = setup(false);
    await launch(off);
    expect(off.fetch).not.toHaveBeenCalled();
    expect(off.native.slot).toBe(false);

    const on = setup(true);
    await launch(on);
    expect(on.record()?.state).toBe("granted");
    expect(on.fetch).toHaveBeenCalled();
  });
});
