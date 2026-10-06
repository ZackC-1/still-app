import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type SignedRuleSet, type SignedRuleSetV2, type StillSettings } from "@still/shared-types";
import seed from "../../../core/rules/seed.json";
import {
  createTiktokBlockedRoute,
  TIKTOK_ROUTE,
  type TiktokCommittedSnapshot,
  type TiktokRouteReply,
  type TiktokRouteSender,
} from "../../../core/src/content/tiktok-blocked-route.js";
// The background route (core) over the real Chromium/Firefox adapter and the real core one-tab
// owner, exactly as entrypoints/background.ts wires them.
import { createChromeTiktokTabAuthority, isTiktokRouteMessage } from "../tiktok-tab-authority.js";
import {
  afterPlatformAnswer,
  askRuntimePlatform,
  gatedDocumentVerification,
  tabAllowancePlatformGate,
  type PlatformGate,
  type RuntimePlatform,
} from "../runtime-platform.js";

const ORIGIN = "chrome-extension://still/";
const PAGE = `${ORIGIN}tiktok-blocked.html`;
const TIKTOK = "https://www.tiktok.com/@fixture/video/123?share=1";
const ruleSet = seed as unknown as SignedRuleSet;

afterEach(() => {
  vi.useRealTimers();
});

interface Tab {
  id: number;
  url: string;
  document: string;
}

function host(
  options: {
    tiktok?: boolean;
    canVerify?: boolean;
    limits?: Parameters<typeof createTiktokBlockedRoute>[0]["limits"];
    /** The Firefox build's platform gate, wired exactly as entrypoints/background.ts wires it. */
    gate?: PlatformGate;
  } = {},
) {
  const session = new Map<string, unknown>();
  const tabs = new Map<number, Tab>();
  let documents = 0;
  const open = (id: number, url: string) => {
    tabs.set(id, { id, url, document: `document-${++documents}` });
  };
  const removed = new Set<(id: number) => void>();
  const replaced = new Set<(added: number, removed: number) => void>();
  let settings: StillSettings = Object.freeze({
    ...DEFAULT_SETTINGS,
    services: Object.freeze({ ...DEFAULT_SETTINGS.services, tiktok: options.tiktok ?? true }),
  }) as StillSettings;
  const saved = () => settings;
  const readCommitted = vi.fn(async (): Promise<TiktokCommittedSnapshot | null> => ({ settings, options: { pro: true } }));
  const sessionArea = {
    get: vi.fn(async (key: string) => (session.has(key) ? { [key]: structuredClone(session.get(key)) } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) session.set(key, structuredClone(value));
    }),
    remove: vi.fn(async (key: string) => {
      session.delete(key);
    }),
  };
  const update = vi.fn(async (id: number, properties: { url: string }) => {
    open(id, properties.url);
    return {};
  });
  const tabApi = {
    get: async (id: number) => {
      const tab = tabs.get(id);
      if (!tab) throw new Error("No tab");
      // Like Chromium without "tabs": extension-page URLs are redacted, TikTok URLs are visible.
      return tab.url.startsWith(ORIGIN) ? { id } : { id, url: tab.url };
    },
    update,
    onRemoved: {
      addListener: (fn: (id: number) => void) => void removed.add(fn),
      removeListener: (fn: (id: number) => void) => void removed.delete(fn),
    },
    onReplaced: {
      addListener: (fn: (added: number, removed: number) => void) => void replaced.add(fn),
      removeListener: (fn: (added: number, removed: number) => void) => void replaced.delete(fn),
    },
  };
  const contexts = vi.fn(async () =>
    [...tabs.values()].map((tab) => ({
      contextType: "TAB",
      documentId: tab.document,
      tabId: tab.id,
      frameId: 0,
      documentUrl: tab.url,
    })),
  );
  const confirmWrapper = { calls: 0 };
  function create(overrides: { session?: typeof sessionArea; replaceHistory?: boolean } = {}) {
    const area = overrides.session ?? sessionArea;
    return createTiktokBlockedRoute({
      replaceHistory: overrides.replaceHistory,
      runtimeId: "still",
      extensionOrigin: ORIGIN,
      pageUrl: PAGE,
      session: area,
      tabs: tabApi,
      ruleSet,
      readCommitted,
      get canVerifyDocuments() {
        const browserCanVerify = options.canVerify ?? true;
        return options.gate ? gatedDocumentVerification(browserCanVerify, options.gate) : browserCanVerify;
      },
      limits: options.limits,
      randomId: () => `request-${++documents}-fixture`,
      createAuthority: (hooks) =>
        createChromeTiktokTabAuthority({
          browser: {
            runtime: { id: "still", getURL: (path) => `${ORIGIN}${path}`, getContexts: contexts },
            storage: { session: hooks.session },
            tabs: tabApi,
          },
          ruleSet: ruleSet as unknown as SignedRuleSetV2,
          readCommitted: hooks.readCommitted,
          blockedPagePath: "tiktok-blocked.html",
          resolveOriginalTarget: hooks.resolveOriginalTarget,
          confirm: (context) => {
            confirmWrapper.calls += 1;
            return hooks.confirm(context);
          },
        }),
    });
  }
  const content = (id: number, frameId = 0): TiktokRouteSender => ({
    id: "still",
    url: tabs.get(id)!.url,
    frameId,
    tab: { id },
  });
  const screen = (id: number): TiktokRouteSender => ({
    id: "still",
    url: tabs.get(id)!.url,
    frameId: 0,
    documentId: tabs.get(id)!.document,
    tab: { id },
  });
  return {
    session,
    sessionArea,
    tabs,
    open,
    update,
    removed,
    replaced,
    readCommitted,
    contexts,
    confirmWrapper,
    saved,
    setSettings(next: StillSettings) {
      settings = next;
    },
    create,
    content,
    screen,
  };
}

type Route = ReturnType<ReturnType<typeof host>["create"]>;

function send(
  route: Route,
  message: unknown,
  sender: TiktokRouteSender,
  gate?: PlatformGate,
): Promise<TiktokRouteReply | "unhandled"> {
  const listener = gate ? afterPlatformAnswer(route.listener, gate, isTiktokRouteMessage) : route.listener;
  return new Promise((resolve) => {
    if (!listener(message, sender, resolve)) resolve("unhandled");
  });
}

/** Content script at a blocked TikTok address in tab `id`, sent to the blocked page. */
async function block(h: ReturnType<typeof host>, route: Route, id: number, url = TIKTOK) {
  h.open(id, url);
  expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(id))).toEqual({ status: "redirected" });
  expect(h.tabs.get(id)!.url).toMatch(/^chrome-extension:\/\/still\/tiktok-blocked\.html\?r=request-\d+-fixture$/);
}

async function grant(h: ReturnType<typeof host>, route: Route, id: number) {
  expect(await send(route, { kind: TIKTOK_ROUTE.screen }, h.screen(id))).toEqual({ status: "blocked", tab: id });
  expect(await send(route, { kind: TIKTOK_ROUTE.request }, h.screen(id))).toEqual({ status: "confirming" });
  expect(await send(route, { kind: TIKTOK_ROUTE.confirm }, h.screen(id))).toEqual({ status: "granted" });
}

describe("TikTok blocked page route over the real one-tab authority", () => {
  it("sends a blocked top-level TikTok tab to the extension page, binding only that tab's destination", async () => {
    const h = host();
    const route = h.create();
    const before = h.saved();
    await block(h, route, 7);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0]![1]).toEqual({ url: h.tabs.get(7)!.url });
    expect([...h.session.keys()]).toEqual(["still:tiktok-origin:7"]);
    expect(h.session.get("still:tiktok-origin:7")).toEqual({ request: expect.any(String), target: TIKTOK });
    expect(h.saved()).toBe(before);
    await route.stop();
  });

  it("Firefox replaces the blocked TikTok history entry so Back leaves TikTok", async () => {
    const h = host();
    const route = h.create({ replaceHistory: true });
    await block(h, route, 3);
    expect(h.update.mock.calls[0]![1]).toEqual({ url: h.tabs.get(3)!.url, loadReplace: true });
    await route.stop();
  });

  it("TikTok Off, Still Off or a non-blocked address is never redirected and writes nothing", async () => {
    for (const settings of [
      { ...DEFAULT_SETTINGS, services: { ...DEFAULT_SETTINGS.services, tiktok: false } },
      { ...DEFAULT_SETTINGS, globalOn: false },
    ]) {
      const h = host();
      h.setSettings(settings);
      const route = h.create();
      h.open(7, TIKTOK);
      expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7))).toEqual({ status: "held" });
      expect(h.update).not.toHaveBeenCalled();
      expect(h.session.size).toBe(0);
      await route.stop();
    }
    const h = host();
    h.readCommitted.mockResolvedValue(null);
    const route = h.create();
    h.open(7, TIKTOK);
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7))).toEqual({ status: "held" });
    expect(h.update).not.toHaveBeenCalled();
    await route.stop();
  });

  it("ignores forged, iframe, other-extension, non-TikTok and body-carrying requests", async () => {
    const h = host();
    const route = h.create();
    h.open(7, TIKTOK);
    const page = h.content(7);
    for (const [message, sender] of [
      [{ kind: TIKTOK_ROUTE.blocked }, { ...page, id: "other" }],
      [{ kind: TIKTOK_ROUTE.blocked }, { ...page, frameId: 1 }],
      [{ kind: TIKTOK_ROUTE.blocked }, { ...page, tab: undefined }],
      [{ kind: TIKTOK_ROUTE.blocked }, { ...page, url: "https://www.tiktok.com.example.com/" }],
      [{ kind: TIKTOK_ROUTE.blocked }, { ...page, url: `${ORIGIN}options.html` }],
      [{ kind: TIKTOK_ROUTE.blocked, url: "https://www.tiktok.com/chosen" }, page],
      [{ kind: TIKTOK_ROUTE.blocked, tabId: 9 }, page],
      // A content script can never reach the blocked page's actions.
      [{ kind: TIKTOK_ROUTE.request }, page],
      [{ kind: TIKTOK_ROUTE.confirm }, page],
      [{ kind: TIKTOK_ROUTE.open }, page],
      [{ kind: "still:tiktok-unknown" }, page],
    ] as const)
      expect(await send(route, message, sender as TiktokRouteSender)).toBe("unhandled");
    expect(h.update).not.toHaveBeenCalled();
    expect(h.session.size).toBe(0);
    await route.stop();
  });

  it("confirmation is required: allows only after request then confirm from the same page document", async () => {
    const h = host();
    const route = h.create();
    await block(h, route, 7);
    // Showing the page, asking to reopen, or confirming with nothing open grants nothing.
    expect(await send(route, { kind: TIKTOK_ROUTE.screen }, h.screen(7))).toEqual({ status: "blocked", tab: 7 });
    expect(await send(route, { kind: TIKTOK_ROUTE.open }, h.screen(7))).toEqual({ status: "failed" });
    expect(await send(route, { kind: TIKTOK_ROUTE.confirm }, h.screen(7))).toEqual({ status: "failed" });
    expect(h.session.has("still:tiktok-tab:7")).toBe(false);
    // A request alone leaves the tab closed until the same document confirms.
    expect(await send(route, { kind: TIKTOK_ROUTE.request }, h.screen(7))).toEqual({ status: "confirming" });
    expect(h.session.has("still:tiktok-tab:7")).toBe(false);
    expect(await send(route, { kind: TIKTOK_ROUTE.cancel }, h.screen(7))).toEqual({ status: "cancelled" });
    expect(await send(route, { kind: TIKTOK_ROUTE.request }, h.screen(7))).toEqual({ status: "confirming" });
    expect(await send(route, { kind: TIKTOK_ROUTE.confirm }, { ...h.screen(7), documentId: "other-document" })).toEqual({
      status: "failed",
    });
    expect(h.session.has("still:tiktok-tab:7")).toBe(false);
    expect(await send(route, { kind: TIKTOK_ROUTE.confirm }, h.screen(7))).toEqual({ status: "granted" });
    expect(h.session.get("still:tiktok-tab:7")).toBe(true);
    // A second confirm cannot reuse the settled confirmation.
    expect(await send(route, { kind: TIKTOK_ROUTE.confirm }, h.screen(7))).toEqual({ status: "failed" });
    await route.stop();
  });

  it("a granted page reopens its own bound destination, and that one living tab stays allowed", async () => {
    const h = host();
    const route = h.create();
    const before = h.saved();
    await block(h, route, 7);
    await grant(h, route, 7);
    expect(await send(route, { kind: TIKTOK_ROUTE.screen }, h.screen(7))).toEqual({ status: "granted", tab: 7 });
    expect(await send(route, { kind: TIKTOK_ROUTE.open }, h.screen(7))).toEqual({ status: "open", url: TIKTOK });
    h.open(7, TIKTOK);
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7))).toEqual({ status: "allowed" });
    // Same-tab navigation elsewhere on TikTok stays allowed.
    h.open(7, "https://www.tiktok.com/foryou");
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7))).toEqual({ status: "allowed" });
    expect(h.saved()).toBe(before);
    await route.stop();
  });

  it("the allowance never leaks to another tab, and closing or replacing the tab clears it", async () => {
    const h = host();
    const route = h.create();
    await block(h, route, 7);
    await grant(h, route, 7);
    h.open(8, TIKTOK);
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(8))).toEqual({ status: "redirected" });
    h.open(7, TIKTOK);
    for (const listener of h.replaced) listener(9, 7);
    await vi.waitFor(() => expect(h.session.has("still:tiktok-tab:7")).toBe(false));
    expect(h.session.has("still:tiktok-origin:7")).toBe(false);
    h.open(9, TIKTOK);
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(9))).toEqual({ status: "redirected" });
    for (const listener of h.removed) listener(8);
    await vi.waitFor(() => expect(h.session.has("still:tiktok-origin:8")).toBe(false));
    await route.stop();
  });

  it("a confirmation left open by a page that has gone never delays or outlives a later block of that tab", async () => {
    vi.useFakeTimers();
    const h = host();
    const route = h.create();
    h.open(7, TIKTOK);
    const first = send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7));
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toEqual({ status: "redirected" });
    const page = h.screen(7);
    const requested = send(route, { kind: TIKTOK_ROUTE.request }, page);
    await vi.advanceTimersByTimeAsync(0);
    expect(await requested).toEqual({ status: "confirming" });
    // The blocked page goes away (the person navigates the tab to another TikTok address).
    h.open(7, "https://www.tiktok.com/@other");
    const again = send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7));
    await vi.advanceTimersByTimeAsync(0);
    expect(await again).toEqual({ status: "redirected" });
    expect(h.update).toHaveBeenCalledTimes(2);
    // The retired confirmation can no longer be answered, and nothing acts minutes later.
    expect(await send(route, { kind: TIKTOK_ROUTE.confirm }, page)).toEqual({ status: "failed" });
    await vi.advanceTimersByTimeAsync(130_000);
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.session.has("still:tiktok-tab:7")).toBe(false);
    await route.stop();
  });

  it("a tab that leaves TikTok before the redirect is never redirected and keeps no address", async () => {
    const h = host();
    const route = h.create();
    h.open(7, TIKTOK);
    const set = h.sessionArea.set.getMockImplementation()!;
    h.sessionArea.set.mockImplementationOnce(async (items) => {
      await set(items);
      // The person navigates away between validation and the redirect.
      h.open(7, "https://example.com/elsewhere");
    });
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7))).toEqual({ status: "held" });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.session.has("still:tiktok-origin:7")).toBe(false);
    await route.stop();
  });

  it("an answer whose budget expires during the address write never redirects, though the tab is still on TikTok", async () => {
    vi.useFakeTimers();
    const h = host({ limits: { contentAnswerMs: 5_000, waitMs: 4_000 } });
    const route = h.create();
    h.open(7, TIKTOK);
    const read = h.readCommitted.getMockImplementation()!;
    const set = h.sessionArea.set.getMockImplementation()!;
    // Two settings reads (allowance check, blocked check) end at 2 s, so the pre-write check
    // passes inside the budget. The write itself (inside its own 4 s bound) then ends at 5.5 s:
    // only the deadline of the post-write re-check stands between it and a late redirect.
    h.readCommitted.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return read();
    });
    let wroteAt = -1;
    h.sessionArea.set.mockImplementationOnce(async (items) => {
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      wroteAt = Date.now();
      await set(items);
    });
    const started = Date.now();
    const reply = send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await reply).toEqual({ status: "held" });
    expect(wroteAt - started).toBeGreaterThan(5_000);
    expect(h.tabs.get(7)!.url).toBe(TIKTOK);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.session.has("still:tiktok-origin:7")).toBe(false);
    await route.stop();
  });

  it("an unreadable tab after the address write, or a failed or stalled redirect, keeps no address", async () => {
    // The post-write tab read fails.
    let h = host();
    let route = h.create();
    h.open(7, TIKTOK);
    const set = h.sessionArea.set.getMockImplementation()!;
    h.sessionArea.set.mockImplementationOnce(async (items) => {
      await set(items);
      h.tabs.delete(7); // tabs.get now rejects ("No tab")
    });
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7))).toEqual({ status: "held" });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.session.has("still:tiktok-origin:7")).toBe(false);
    await route.stop();

    // tabs.update rejects.
    h = host();
    route = h.create();
    h.open(7, TIKTOK);
    h.update.mockRejectedValueOnce(new Error("Tab navigation refused"));
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7))).toEqual({ status: "held" });
    expect(h.session.has("still:tiktok-origin:7")).toBe(false);
    await route.stop();

    // tabs.update never answers.
    vi.useFakeTimers();
    h = host({ limits: { waitMs: 1_000 } });
    route = h.create();
    h.open(7, TIKTOK);
    h.update.mockImplementationOnce(() => new Promise(() => {}));
    const reply = send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await reply).toEqual({ status: "held" });
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.session.has("still:tiktok-origin:7")).toBe(false);
    await route.stop();
  });

  it("an older request that fails never removes a newer request's stored address for the same tab", async () => {
    const h = host();
    const route = h.create();
    h.open(7, TIKTOK);
    const newer = { request: "newer-request-fixture", target: TIKTOK };
    h.update.mockImplementationOnce(async () => {
      // A newer redirect of the same tab records its own address while this older one is still
      // in flight, then this older redirect fails.
      h.session.set("still:tiktok-origin:7", structuredClone(newer));
      throw new Error("Tab navigation refused");
    });
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7))).toEqual({ status: "held" });
    expect(h.session.get("still:tiktok-origin:7")).toEqual(newer);
    await route.stop();
  });

  it("a successful reopen clears the stored address at once; the tab keeps its allowance", async () => {
    const h = host();
    const route = h.create();
    await block(h, route, 7);
    await grant(h, route, 7);
    expect(h.session.has("still:tiktok-origin:7")).toBe(true);
    expect(await send(route, { kind: TIKTOK_ROUTE.open }, h.screen(7))).toEqual({ status: "open", url: TIKTOK });
    expect(h.session.has("still:tiktok-origin:7")).toBe(false);
    expect([...h.session.values()]).not.toContain(TIKTOK);
    h.open(7, TIKTOK);
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7))).toEqual({ status: "allowed" });
    await route.stop();
  });

  it("cancel keeps TikTok closed; a cancel after the confirm cannot revoke it", async () => {
    const h = host();
    const route = h.create();
    await block(h, route, 7);
    expect(await send(route, { kind: TIKTOK_ROUTE.request }, h.screen(7))).toEqual({ status: "confirming" });
    expect(await send(route, { kind: TIKTOK_ROUTE.cancel }, h.screen(7))).toEqual({ status: "cancelled" });
    expect(await send(route, { kind: TIKTOK_ROUTE.confirm }, h.screen(7))).toEqual({ status: "failed" });
    expect(h.session.has("still:tiktok-tab:7")).toBe(false);
    await grant(h, route, 7);
    expect(await send(route, { kind: TIKTOK_ROUTE.cancel }, h.screen(7))).toEqual({ status: "cancelled" });
    expect(h.session.get("still:tiktok-tab:7")).toBe(true);
    await route.stop();
  });

  it("an unanswered confirmation times out as not allowed, so the tab queue and stop() never hang", async () => {
    vi.useFakeTimers();
    const h = host({ limits: { confirmMs: 60_000 } });
    const route = h.create();
    h.open(7, TIKTOK);
    const redirected = send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7));
    await vi.runAllTimersAsync();
    expect(await redirected).toEqual({ status: "redirected" });
    const requested = send(route, { kind: TIKTOK_ROUTE.request }, h.screen(7));
    await vi.advanceTimersByTimeAsync(0);
    expect(await requested).toEqual({ status: "confirming" });
    expect(await send(route, { kind: TIKTOK_ROUTE.confirming }, h.screen(7))).toEqual({ status: "confirming" });
    // The person never answers. Without the bound, this tab's queue (and stop) would wait forever.
    let isAllowed: boolean | undefined;
    void route.authority.allow(h.screen(7)).then((value) => (isAllowed = value));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(isAllowed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(isAllowed).toBe(false);
    expect(await send(route, { kind: TIKTOK_ROUTE.confirming }, h.screen(7))).toEqual({ status: "idle" });
    expect(await send(route, { kind: TIKTOK_ROUTE.confirm }, h.screen(7))).toEqual({ status: "failed" });
    expect(h.session.has("still:tiktok-tab:7")).toBe(false);
    let stopped = false;
    void route.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
  });

  it("stop() during an open confirmation settles it as not allowed and ignores later messages", async () => {
    const h = host();
    const route = h.create();
    await block(h, route, 7);
    expect(await send(route, { kind: TIKTOK_ROUTE.request }, h.screen(7))).toEqual({ status: "confirming" });
    await route.stop();
    expect(await send(route, { kind: TIKTOK_ROUTE.confirm }, h.screen(7))).toBe("unhandled");
    expect(h.session.has("still:tiktok-tab:7")).toBe(false);
    expect(h.removed.size).toBe(0);
    expect(h.replaced.size).toBe(0);
  });

  it("worker restart: a completed allowance survives in session storage, an open confirmation does not", async () => {
    const h = host();
    const first = h.create();
    await block(h, first, 7);
    await grant(h, first, 7);
    await block(h, first, 8);
    expect(await send(first, { kind: TIKTOK_ROUTE.request }, h.screen(8))).toEqual({ status: "confirming" });
    await first.stop();
    const second = h.create();
    expect(await send(second, { kind: TIKTOK_ROUTE.confirm }, h.screen(8))).toEqual({ status: "failed" });
    expect(await send(second, { kind: TIKTOK_ROUTE.open }, h.screen(7))).toEqual({ status: "open", url: TIKTOK });
    h.open(7, TIKTOK);
    expect(await send(second, { kind: TIKTOK_ROUTE.blocked }, h.content(7))).toEqual({ status: "allowed" });
    h.open(8, TIKTOK);
    expect(await send(second, { kind: TIKTOK_ROUTE.blocked }, h.content(8))).toEqual({ status: "redirected" });
    await second.stop();
  });

  it("stalled storage or settings answers end as held/unavailable within the bound", async () => {
    vi.useFakeTimers();
    const h = host({ limits: { waitMs: 1_000 } });
    const stalled = {
      get: vi.fn(() => new Promise<Record<string, unknown>>(() => {})),
      set: vi.fn(() => new Promise<void>(() => {})),
      remove: vi.fn(() => new Promise<void>(() => {})),
    };
    const route = h.create({ session: stalled });
    h.open(7, TIKTOK);
    const blocked = send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await blocked).toEqual({ status: "held" });
    expect(h.update).not.toHaveBeenCalled();
    h.open(7, `${PAGE}?r=request-1-fixture`);
    const screen = send(route, { kind: TIKTOK_ROUTE.screen }, h.screen(7));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await screen).toEqual({ status: "unavailable", tab: 7 });
    h.readCommitted.mockImplementation(() => new Promise(() => {}));
    h.open(7, TIKTOK);
    const pending = send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ status: "held" });
    let stopped = false;
    void route.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stopped).toBe(true);
  });

  it("the destination resolver is idempotent and bound to the newest blocked page of that tab", async () => {
    const h = host();
    const route = h.create();
    await block(h, route, 7);
    const old = h.screen(7);
    expect(await send(route, { kind: TIKTOK_ROUTE.screen }, old)).toEqual({ status: "blocked", tab: 7 });
    expect(await send(route, { kind: TIKTOK_ROUTE.screen }, old)).toEqual({ status: "blocked", tab: 7 });
    // A later block in the same tab rebinds it; the older page (e.g. reached by Back) can't act.
    await block(h, route, 7, "https://www.tiktok.com/@other");
    expect(await send(route, { kind: TIKTOK_ROUTE.screen }, { ...old, documentId: h.tabs.get(7)!.document })).toEqual({
      status: "unavailable",
      tab: 7,
    });
    await grant(h, route, 7);
    expect(await send(route, { kind: TIKTOK_ROUTE.open }, h.screen(7))).toEqual({
      status: "open",
      url: "https://www.tiktok.com/@other",
    });
    await route.stop();
  });

  it("Back/Forward into a blocked TikTok entry is not sent forward again, but an allowed tab stays allowed", async () => {
    const h = host();
    const route = h.create();
    h.open(7, TIKTOK);
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked, traversal: true }, h.content(7))).toEqual({ status: "held" });
    expect(h.update).not.toHaveBeenCalled();
    await block(h, route, 7);
    await grant(h, route, 7);
    h.open(7, TIKTOK);
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked, traversal: true }, h.content(7))).toEqual({ status: "allowed" });
    await route.stop();
  });

  it("without a provable page document the page shows the block with opening unavailable", async () => {
    for (const variant of ["no-document", "no-contexts"] as const) {
      const h = host({ canVerify: variant !== "no-contexts" });
      const route = h.create();
      await block(h, route, 7);
      const sender = variant === "no-document" ? { ...h.screen(7), documentId: undefined } : h.screen(7);
      expect(await send(route, { kind: TIKTOK_ROUTE.screen }, sender)).toEqual({ status: "unavailable", tab: 7 });
      expect(await send(route, { kind: TIKTOK_ROUTE.request }, sender)).toEqual({ status: "failed" });
      expect(h.session.has("still:tiktok-tab:7")).toBe(false);
      await route.stop();
    }
  });
});

describe("Firefox build platform gate on the TikTok route (as wired in the background)", () => {
  const firefoxGate = (platform: Promise<RuntimePlatform>) => tabAllowancePlatformGate(true, platform);

  it("Firefox for Android: the blocked page is told opening is unavailable, and a request fails", async () => {
    const gate = firefoxGate(Promise.resolve("android"));
    const h = host({ gate });
    const route = h.create();
    await block(h, route, 7);
    expect(await send(route, { kind: TIKTOK_ROUTE.screen }, h.screen(7), gate)).toEqual({ status: "unavailable", tab: 7 });
    expect(await send(route, { kind: TIKTOK_ROUTE.request }, h.screen(7), gate)).toEqual({ status: "failed" });
    expect(h.session.has("still:tiktok-tab:7")).toBe(false);
    await route.stop();
  });

  it("desktop Firefox: the same page is capable and can complete the allowance", async () => {
    const gate = firefoxGate(Promise.resolve("desktop"));
    const h = host({ gate });
    const route = h.create();
    await block(h, route, 7);
    expect(await send(route, { kind: TIKTOK_ROUTE.screen }, h.screen(7), gate)).toEqual({ status: "blocked", tab: 7 });
    expect(await send(route, { kind: TIKTOK_ROUTE.request }, h.screen(7), gate)).toEqual({ status: "confirming" });
    expect(await send(route, { kind: TIKTOK_ROUTE.confirm }, h.screen(7), gate)).toEqual({ status: "granted" });
    await route.stop();
  });

  it("a desktop page whose messages arrive while the platform answer is pending waits for it", async () => {
    let answer!: (platform: RuntimePlatform) => void;
    const gate = firefoxGate(new Promise<RuntimePlatform>((resolve) => (answer = resolve)));
    const h = host({ gate });
    const route = h.create();
    // The content script's blocked message is one of the route's own, so it is held too.
    h.open(7, TIKTOK);
    let blocked: TiktokRouteReply | "unhandled" | undefined;
    void send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7), gate).then((reply) => (blocked = reply));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(blocked).toBeUndefined(); // held
    expect(h.update).not.toHaveBeenCalled();
    answer("desktop");
    await vi.waitFor(() => expect(blocked).toEqual({ status: "redirected" }));
    expect(h.tabs.get(7)!.url).toMatch(/^chrome-extension:\/\/still\/tiktok-blocked\.html\?r=request-\d+-fixture$/);
    // Once the answer is in, the blocked page is capable, not told "unavailable".
    expect(await send(route, { kind: TIKTOK_ROUTE.screen }, h.screen(7), gate)).toEqual({ status: "blocked", tab: 7 });
    // Messages that are not the route's own are never held.
    const never = firefoxGate(new Promise<RuntimePlatform>(() => {}));
    expect(await send(route, { kind: "not-tiktok" }, h.screen(7), never)).toBe("unhandled");
    await route.stop();
  });

  // The gate as the background builds it: askRuntimePlatform's bounded and eventual answers.
  const backgroundGate = (getPlatformInfo: () => Promise<{ os: string }>, limitMs = 30) => {
    const answer = askRuntimePlatform({ getPlatformInfo }, limitMs);
    return tabAllowancePlatformGate(true, answer.bounded, answer.eventual);
  };

  it("an answer that never arrives fails closed: held messages are then told opening is unavailable", async () => {
    const gate = backgroundGate(() => new Promise(() => {}));
    const h = host({ gate });
    const route = h.create();
    h.open(7, TIKTOK);
    // The block itself still happens; only the one-tab allowance is withheld.
    expect(await send(route, { kind: TIKTOK_ROUTE.blocked }, h.content(7), gate)).toEqual({ status: "redirected" });
    expect(gate).toMatchObject({ known: true, open: false });
    expect(await send(route, { kind: TIKTOK_ROUTE.screen }, h.screen(7), gate)).toEqual({ status: "unavailable", tab: 7 });
    expect(await send(route, { kind: TIKTOK_ROUTE.request }, h.screen(7), gate)).toEqual({ status: "failed" });
    expect(h.session.has("still:tiktok-tab:7")).toBe(false);
    await route.stop();
  });

  it("a late answer reopens the allowance only when it says desktop", async () => {
    for (const os of ["mac", "android"]) {
      let late!: (info: { os: string }) => void;
      const gate = backgroundGate(() => new Promise((resolve) => (late = resolve)));
      const h = host({ gate });
      const route = h.create();
      await block(h, route, 7);
      // Past the limit with no answer: closed.
      expect(await send(route, { kind: TIKTOK_ROUTE.screen }, h.screen(7), gate)).toEqual({ status: "unavailable", tab: 7 });
      late({ os });
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The next blocked page sees the late answer.
      await block(h, route, 8);
      if (os === "mac") {
        expect(gate.open).toBe(true);
        expect(await send(route, { kind: TIKTOK_ROUTE.screen }, h.screen(8), gate)).toEqual({ status: "blocked", tab: 8 });
        expect(await send(route, { kind: TIKTOK_ROUTE.request }, h.screen(8), gate)).toEqual({ status: "confirming" });
      } else {
        expect(gate.open).toBe(false);
        expect(await send(route, { kind: TIKTOK_ROUTE.screen }, h.screen(8), gate)).toEqual({ status: "unavailable", tab: 8 });
      }
      await route.stop();
    }
  });
});
