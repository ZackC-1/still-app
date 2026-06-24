import { describe, it, expect, beforeEach, vi } from "vitest";
import seed from "../../../rules/seed.json";
import type { SignedRuleSet, StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { createContentScript } from "../index.js";
import { ROOT_ACTIVE_CLASS } from "../../rules/engine.js";

const ruleSet = seed as unknown as SignedRuleSet;
const sync = (cb: () => void) => cb();

/** A controllable fake window: real DOM via the jsdom document, scriptable location + history. */
function makeWin(href: string) {
  const listeners: Record<string, Array<() => void>> = {};
  const location = {
    get href() {
      return current;
    },
    replace: vi.fn((u: string) => {
      current = u;
    }),
  };
  let current = href;
  const history = {
    pushState: (_s: unknown, _t: string, url?: string) => {
      if (url) current = new URL(url, current).toString();
    },
    replaceState: (_s: unknown, _t: string, url?: string) => {
      if (url) current = new URL(url, current).toString();
    },
  };
  const win = {
    location,
    history,
    navigation: undefined as undefined | { _cb?: () => void; addEventListener: (t: string, cb: () => void) => void; removeEventListener: () => void },
    addEventListener: (type: string, cb: () => void) => {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener: (type: string, cb: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== cb);
    },
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame?.bind(window),
    setHref: (u: string) => {
      current = u;
    },
    dispatch: (type: string) => {
      for (const l of listeners[type] ?? []) l();
    },
  };
  return win;
}

function cacheWith(settings: StillSettings | null) {
  const adapter = new InMemoryStorageAdapter(settings);
  return new SettingsCache(adapter, { now: () => Date.now() });
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

describe("content script — redirect + SPA navigation (U7)", () => {
  it("redirects a Shorts URL with an id to the watch page after hydrate (AE1)", async () => {
    const win = makeWin("https://www.youtube.com/shorts/abc123");
    const redirectPort = { replace: vi.fn() };
    const cs = createContentScript({ win, doc: document, ruleSet, cache: cacheWith(null), redirectPort, schedule: sync });
    await cs.start();
    expect(redirectPort.replace).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc123");
    cs.stop();
  });

  it("shows the placeholder (no redirect) for a Shorts URL with no id (AE2)", async () => {
    const win = makeWin("https://www.youtube.com/shorts/");
    const redirectPort = { replace: vi.fn() };
    const cs = createContentScript({ win, doc: document, ruleSet, cache: cacheWith(null), redirectPort, schedule: sync });
    await cs.start();
    expect(redirectPort.replace).not.toHaveBeenCalled();
    expect(document.querySelector("#still-placeholder")).not.toBeNull();
    cs.stop();
  });

  it("re-fires the redirect on a pushState into a Short", async () => {
    const win = makeWin("https://www.youtube.com/feed/subscriptions");
    const redirectPort = { replace: vi.fn() };
    const cs = createContentScript({ win, doc: document, ruleSet, cache: cacheWith(null), redirectPort, schedule: sync });
    await cs.start();
    expect(redirectPort.replace).not.toHaveBeenCalled(); // normal page → apply
    win.history.pushState({}, "", "https://www.youtube.com/shorts/zzz");
    expect(redirectPort.replace).toHaveBeenCalledWith("https://www.youtube.com/watch?v=zzz");
    cs.stop();
  });

  it("re-fires on a Navigation API navigate event", async () => {
    const win = makeWin("https://www.youtube.com/feed/subscriptions");
    let navCb: (() => void) | undefined;
    win.navigation = {
      addEventListener: (_t, cb) => {
        navCb = cb;
      },
      removeEventListener: () => {},
    };
    const redirectPort = { replace: vi.fn() };
    const cs = createContentScript({ win, doc: document, ruleSet, cache: cacheWith(null), redirectPort, schedule: sync });
    await cs.start();
    win.setHref("https://www.youtube.com/shorts/nav1");
    navCb?.();
    expect(redirectPort.replace).toHaveBeenCalledWith("https://www.youtube.com/watch?v=nav1");
    cs.stop();
  });

  it("does not loop: a popstate back to a normal page issues no second redirect", async () => {
    const win = makeWin("https://www.youtube.com/shorts/abc");
    const redirectPort = { replace: vi.fn() };
    const cs = createContentScript({ win, doc: document, ruleSet, cache: cacheWith(null), redirectPort, schedule: sync });
    await cs.start();
    expect(redirectPort.replace).toHaveBeenCalledTimes(1);
    win.setHref("https://www.youtube.com/watch?v=abc");
    win.dispatch("popstate");
    expect(redirectPort.replace).toHaveBeenCalledTimes(1); // no extra redirect
    cs.stop();
  });

  it("off-user: the root class is absent at document_start AND after hydration (no flash)", async () => {
    const off: StillSettings = {
      ...DEFAULT_SETTINGS,
      services: { youtube: false, instagram: true, tiktok: true, facebook: true },
      updatedAt: 1,
    };
    const win = makeWin("https://www.youtube.com/feed/subscriptions");
    const cs = createContentScript({ win, doc: document, ruleSet, cache: cacheWith(off), schedule: sync });
    const pending = cs.start();
    expect(document.documentElement.classList.contains(ROOT_ACTIVE_CLASS)).toBe(false); // pre-hydrate
    await pending;
    expect(document.documentElement.classList.contains(ROOT_ACTIVE_CLASS)).toBe(false); // youtube off
    cs.stop();
  });

  it("on-user: adds the root class and applies after hydration", async () => {
    const win = makeWin("https://www.youtube.com/feed/subscriptions");
    const cs = createContentScript({ win, doc: document, ruleSet, cache: cacheWith(null), schedule: sync });
    await cs.start();
    expect(document.documentElement.classList.contains(ROOT_ACTIVE_CLASS)).toBe(true);
    cs.stop();
  });
});
