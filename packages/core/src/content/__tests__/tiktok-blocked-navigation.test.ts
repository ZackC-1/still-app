import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionContentEntry } from "../extension-entry.js";
import type { ContentScriptHandle } from "../index.js";
import {
  createTikTokBlockedNavigation,
  TIKTOK_HOLD_STYLE_ID,
  type TikTokBlockedNavigationDeps,
} from "../tiktok-blocked-navigation.js";
import { TIKTOK_ROUTE } from "../tiktok-blocked-route.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";
import { ruleSet } from "../../rules/__tests__/format2-fixtures.js";

const scripts: ContentScriptHandle[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const target = "https://www.tiktok.com/@fixture/video/123";

afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

const hidden = () => document.getElementById(TIKTOK_HOLD_STYLE_ID) !== null;
const placeholder = () => document.getElementById("still-placeholder");
const feed = () => document.getElementById("tiktok-feed");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function adapter(overrides: Partial<TikTokBlockedNavigationDeps> = {}) {
  const reply = deferred<unknown>();
  const send = vi.fn((_message: { kind: string; traversal?: true }) => reply.promise);
  const navigation = createTikTokBlockedNavigation({ doc: document, send, ...overrides });
  return { navigation, send, reply };
}

async function start(
  href: string,
  tiktokBlockedPage: ReturnType<typeof adapter>["navigation"] | undefined,
  modern = false,
  before?: (h: Awaited<ReturnType<typeof createFormat2EntryHost>>) => Promise<unknown>,
) {
  const h = await createFormat2EntryHost(ruleSet, "tiktok.html", href, scripts);
  await before?.(h);
  await createExtensionContentEntry({
    storage: { get: async () => ({}) },
    bundledRuleSetV2: modern ? ruleSet : undefined,
    prod: false,
    earlyRedirect: false,
    win: h.win,
    doc: document,
    tiktokBlockedPage,
    onScriptCreated: (script) => scripts.push(script),
  })();
  await tick();
  return h;
}

describe("TikTok blocked navigation (content script half)", () => {
  it("asks the background once with a body that names nothing, keeping TikTok hidden meanwhile", async () => {
    const a = adapter();
    expect(a.navigation.current()).toBe("owned");
    expect(a.navigation.current()).toBe("owned");
    expect(a.navigation.consume(new URL(target))).toBe(true);
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(a.send.mock.calls[0]![0]).toStrictEqual({ kind: TIKTOK_ROUTE.blocked });
    expect(hidden()).toBe(true);
  });

  it("an allowed tab is left untouched and its in-tab navigations are not consumed", async () => {
    const a = adapter();
    a.navigation.current();
    a.reply.resolve({ status: "allowed" });
    await tick();
    expect(hidden()).toBe(false);
    expect(a.navigation.current()).toBe("allowed");
    expect(a.navigation.consume(new URL("https://www.tiktok.com/foryou"))).toBe(false);
    expect(placeholder()).toBeNull();
  });

  it.each([
    ["held", { status: "held" }],
    ["unknown reply", { status: "allowed-ish" }],
    ["empty reply", undefined],
  ])("%s falls back to the in-page block, never to an open TikTok", async (_name, reply) => {
    document.body.innerHTML = '<div id="tiktok-feed"></div>';
    const a = adapter();
    a.navigation.current();
    a.reply.resolve(reply);
    await tick();
    expect(hidden()).toBe(false);
    expect(placeholder()).not.toBeNull();
    expect(feed()).toBeNull();
    expect(a.navigation.current()).toBe("fallback");
    expect(a.navigation.consume(new URL(target))).toBe(true);
  });

  it("a rejected or throwing send falls back immediately", async () => {
    document.body.innerHTML = '<div id="tiktok-feed"></div>';
    const throwing = createTikTokBlockedNavigation({
      doc: document,
      send: () => {
        throw new Error("Extension context invalidated");
      },
    });
    expect(throwing.current()).toBe("fallback");
    expect(placeholder()).not.toBeNull();
    document.body.innerHTML = '<div id="tiktok-feed"></div>';
    const rejecting = createTikTokBlockedNavigation({ doc: document, send: () => Promise.reject(new Error("x")) });
    rejecting.current();
    await tick();
    expect(rejecting.current()).toBe("fallback");
    expect(placeholder()).not.toBeNull();
  });

  it("no answer within the bound falls back; a redirect that never leaves falls back after its grace", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="tiktok-feed"></div>';
    const silent = adapter({ timeoutMs: 1_000 });
    silent.navigation.current();
    await vi.advanceTimersByTimeAsync(999);
    expect(hidden()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(placeholder()).not.toBeNull();
    expect(hidden()).toBe(false);
    // A late "allowed" can no longer reopen a page that was already blocked here.
    silent.reply.resolve({ status: "allowed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(silent.navigation.current()).toBe("fallback");

    document.body.innerHTML = '<div id="tiktok-feed"></div>';
    const moving = adapter({ redirectGraceMs: 2_000 });
    moving.navigation.current();
    moving.reply.resolve({ status: "redirected" });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(hidden()).toBe(true);
    expect(placeholder()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(hidden()).toBe(false);
    expect(placeholder()).not.toBeNull();
  });

  it("Back/Forward entries tell the background so it never re-sends the person forward", async () => {
    const a = adapter({ traversal: () => true });
    a.navigation.current();
    expect(a.send.mock.calls[0]![0]).toStrictEqual({ kind: TIKTOK_ROUTE.blocked, traversal: true });
  });

  it("a redirected page restored from the back/forward cache shows the in-page block at once", async () => {
    document.body.innerHTML = '<div id="tiktok-feed"></div>';
    const a = adapter();
    a.navigation.current();
    a.reply.resolve({ status: "redirected" });
    await tick();
    expect(hidden()).toBe(true);
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(hidden()).toBe(false);
    expect(placeholder()).not.toBeNull();
  });

  it("stop while waiting never leaves the page hidden or open", async () => {
    document.body.innerHTML = '<div id="tiktok-feed"></div>';
    const a = adapter();
    a.navigation.current();
    a.navigation.stop();
    expect(hidden()).toBe(false);
    expect(placeholder()).not.toBeNull();
    a.reply.resolve({ status: "allowed" });
    await tick();
    expect(placeholder()).not.toBeNull();
  });
});

describe("legacy content lane with the TikTok blocked page host", () => {
  it("hands a blocked TikTok document to the host instead of the in-page block", async () => {
    const a = adapter();
    await start(target, a.navigation);
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(placeholder()).toBeNull();
    expect(hidden()).toBe(true);
    a.reply.resolve({ status: "allowed" });
    await tick();
    scripts[0]!.reapply();
    expect(hidden()).toBe(false);
    expect(feed()).not.toBeNull();
    expect(placeholder()).toBeNull();
    expect(a.send).toHaveBeenCalledTimes(1);
  });

  it("a host failure keeps the existing in-page block", async () => {
    const a = adapter();
    await start(target, a.navigation);
    a.reply.resolve({ status: "held" });
    await tick();
    scripts[0]!.reapply();
    expect(document.body.textContent).toContain("This site is blocked.");
    expect(feed()).toBeNull();
  });

  it("TikTok Off, Still Off or a non-TikTok page never asks the host", async () => {
    const youtube = adapter();
    await start("https://www.youtube.com/", youtube.navigation);
    expect(youtube.send).not.toHaveBeenCalled();
    for (const path of ["services.tiktok", "globalOn"] as const) {
      const off = adapter();
      await start(target, off.navigation, false, (h) =>
        h.authority.commitIntent({ path, value: false, updatedAt: Date.now() }));
      scripts.at(-1)!.reapply();
      expect(off.send).not.toHaveBeenCalled();
      expect(feed()).not.toBeNull();
      expect(hidden()).toBe(false);
    }
  });

  it("without a host the legacy lane keeps the in-page block exactly as before", async () => {
    await start(target, undefined);
    expect(document.body.textContent).toContain("This site is blocked.");
    expect(feed()).toBeNull();
  });

  it("the format-2 lane uses the same host as its blocked-navigation port", async () => {
    const a = adapter();
    const h = await start(target, a.navigation, true);
    expect(a.send).toHaveBeenCalledTimes(1);
    a.reply.resolve({ status: "allowed" });
    await tick();
    h.win.history.pushState(null, "", "/@fixture/video/456");
    expect(h.win.location.href).toBe("https://www.tiktok.com/@fixture/video/456");
    expect(feed()).not.toBeNull();
    expect(h.replace).not.toHaveBeenCalled();
  });
});
