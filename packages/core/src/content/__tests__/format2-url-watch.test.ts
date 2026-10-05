import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type BenefitId, type SignedRuleSet, type SignedRuleSetV2 } from "@still/shared-types";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { createContentScript, type ContentScriptHandle } from "../index.js";
import { createNavigationIntentTracker, URL_WATCH_INTERVAL_MS, type NavigationIntentTracker } from "../redirect.js";
import { ruleSet } from "../../rules/__tests__/format2-fixtures.js";
import seed from "../../../rules/seed.json";

// Browsers without the Navigation API (Safari before 26.2, Firefox ESR). The content script
// lives in an isolated world: it can wrap ITS view of history.pushState, but the page's own
// pushState runs in the main world and never reaches that wrapper. This fake models exactly
// that: `pagePush` changes the URL and history without calling the (wrapped) win.history.

const scripts: ContentScriptHandle[] = [];
const cores = new Set<BenefitId>(["youtube.shorts", "instagram.reels", "facebook.reels", "tiktok.all"]);
const allCores: SignedRuleSetV2 = {
  ...ruleSet,
  services: {
    ...ruleSet.services,
    facebook: {
      matches: ["*://*.facebook.com/*"],
      surfaces: [{ id: "fixture-only-fb", feature: "facebook.reels", action: "hide", selectors: [".fixture-only-reel"] }],
    },
  },
};

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
};

afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  setVisibility("visible");
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.className = "";
  document.head.innerHTML = "";
});

/** `intents: null` leaves the script's own tracker in place (no test seam). */
async function host(href: string, intents: NavigationIntentTracker | null = createNavigationIntentTracker()) {
  const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
  const writer = new AtomicSettingsWriter(storage);
  await writer.initialize("never-linked");
  const cache = new SettingsCache(storage);
  let current = href;
  const entries = [href];
  let cursor = 0;
  const listeners = new Map<string, Set<() => void>>();
  const replace = vi.fn((url: string) => { current = url; entries[cursor] = url; });
  const assign = vi.fn((url: string) => { current = url; entries.splice(++cursor); entries.push(url); });
  const isolatedPush = vi.fn();
  const win = {
    location: { get href() { return current; }, replace, assign },
    // The isolated world's history view. The page never calls these.
    history: { pushState: isolatedPush, replaceState: vi.fn() },
    addEventListener: (name: string, cb: () => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(cb);
    },
    removeEventListener: (name: string, cb: () => void) => { listeners.get(name)?.delete(cb); },
    MutationObserver: window.MutationObserver,
    // Deliberately no `navigation`: this is the fallback's whole precondition.
  };
  const script = createContentScript({
    win,
    doc: document,
    ruleSet: seed as unknown as SignedRuleSet,
    ruleSetV2: allCores,
    capabilities: cores,
    cache,
    navigationIntents: intents ?? undefined,
  });
  scripts.push(script);
  await script.start();
  return {
    win, writer, cache, script, replace, assign, entries, intents: intents!, isolatedPush, listeners,
    /** Fires a window event the way the browser would (hashchange is not a traversal). */
    fire: (name: string) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(); },
    /** The page's own main-world pushState: invisible to the content script's wrapper. */
    pagePush: (path: string) => {
      current = new URL(path, current).href;
      entries.splice(++cursor);
      entries.push(current);
    },
    back: () => {
      current = entries[--cursor]!;
      for (const listener of listeners.get("popstate") ?? []) listener();
      return current;
    },
  };
}

const tickWatch = () => vi.advanceTimersByTimeAsync(URL_WATCH_INTERVAL_MS + 10);
const fake = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });

describe("format-2 URL watch fallback (no Navigation API)", () => {
  it("R6: an in-app push into Facebook's Watch Reels feed goes home", async () => {
    fake();
    const h = await host("https://www.facebook.com/stillapp");
    h.pagePush("/watch/reels/?ref=nav");
    await tickWatch();
    expect(h.replace).toHaveBeenCalledWith("https://www.facebook.com/");
    expect(h.isolatedPush).not.toHaveBeenCalled(); // the wrapper never saw the page's push
    expect(h.entries).toEqual(["https://www.facebook.com/stillapp", "https://www.facebook.com/"]);
  });

  it.each([
    ["Instagram", "https://www.instagram.com/reel/A1/", "/reel/B2/", "https://www.instagram.com/"],
    ["Instagram plural", "https://www.instagram.com/reel/A1/", "/reels/B2/", "https://www.instagram.com/"],
    ["Facebook", "https://www.facebook.com/reel/111", "/reel/222", "https://www.facebook.com/"],
  ])("R7: %s continuation into another Reel goes home", async (_name, origin, next, home) => {
    fake();
    const h = await host(origin);
    h.pagePush(next);
    await tickWatch();
    expect(h.replace).toHaveBeenCalledTimes(1);
    expect(h.replace).toHaveBeenCalledWith(home);
    expect(h.entries).toEqual([origin, home]); // Back returns to the Reel that was opened
  });

  it.each(["instagram", "facebook"])("a bare %s /reels/ SPA move goes home", async (service) => {
    fake();
    const h = await host(`https://www.${service}.com/`);
    h.pagePush("/reels/");
    await tickWatch();
    expect(h.replace).toHaveBeenCalledWith(`https://www.${service}.com/`);
  });

  it("R11a: moving between Reels inside one profile's modal is profile browsing", async () => {
    fake();
    const h = await host("https://www.instagram.com/some.user/reel/A1/");
    h.pagePush("/some.user/reel/B2/");
    await tickWatch();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("R11c: a link activation still counts for the page's push 2 s later", async () => {
    fake();
    const h = await host("https://www.instagram.com/reel/A1/");
    h.intents.recordLink(new URL("https://www.instagram.com/reel/B2/"));
    await vi.advanceTimersByTimeAsync(2_000);
    h.pagePush("/reel/B2/");
    await tickWatch();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("R11: a link activation to B does not cover a page push to C", async () => {
    fake();
    const h = await host("https://www.instagram.com/reel/A1/");
    h.intents.recordLink(new URL("https://www.instagram.com/reel/B2/"));
    h.pagePush("/reel/C3/");
    await tickWatch();
    expect(h.replace).toHaveBeenCalledWith("https://www.instagram.com/");
  });

  it("R11c: after the 2.5 s window the page's push is the viewer continuing", async () => {
    fake();
    const h = await host("https://www.instagram.com/reel/A1/");
    h.intents.recordLink(new URL("https://www.instagram.com/reel/B2/"));
    await vi.advanceTimersByTimeAsync(2_600);
    h.pagePush("/reel/B2/");
    await tickWatch();
    expect(h.replace).toHaveBeenCalledWith("https://www.instagram.com/");
  });

  it("Back/forward is deliberate: popstate into another Reel is not stopped", async () => {
    fake();
    const h = await host("https://www.facebook.com/reel/111");
    h.intents.recordLink(new URL("https://www.facebook.com/reel/222"));
    h.pagePush("/reel/222");
    await tickWatch();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.back()).toBe("https://www.facebook.com/reel/111");
    await tickWatch();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it.each([
    ["sites.instagram.reels"],
    ["services.instagram"],
    ["globalOn"],
  ] as const)("Off at %s stops the timer and leaves moves alone", async (path) => {
    fake();
    const h = await host("https://www.instagram.com/reel/A1/");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await h.writer.commit({ path, value: false, updatedAt: 2 });
    await h.cache.rereadAuthority?.();
    h.script.reapply();
    expect(vi.getTimerCount()).toBe(0);
    h.pagePush("/reel/B2/");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("stop clears the timer", async () => {
    fake();
    const h = await host("https://www.facebook.com/reel/111");
    expect(vi.getTimerCount()).toBe(1);
    h.script.stop();
    expect(vi.getTimerCount()).toBe(0);
    h.pagePush("/reel/222");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("a hidden tab pauses the timer; visible again resumes it", async () => {
    fake();
    const h = await host("https://www.facebook.com/reel/111");
    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    setVisibility("visible");
    expect(vi.getTimerCount()).toBe(1);
    h.pagePush("/reel/222");
    await tickWatch();
    expect(h.replace).toHaveBeenCalledWith("https://www.facebook.com/");
  });

  it("YouTube keeps its own lifecycle path: no URL timer runs there", async () => {
    fake();
    await host("https://www.youtube.com/results?search_query=x");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("with the Navigation API present no timer runs at all", async () => {
    fake();
    const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
    await new AtomicSettingsWriter(storage).initialize("never-linked");
    const script = createContentScript({
      win: {
        location: { href: "https://www.facebook.com/reel/111", replace: vi.fn(), assign: vi.fn() },
        history: { pushState: vi.fn(), replaceState: vi.fn() },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        MutationObserver: window.MutationObserver,
        navigation: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      },
      doc: document,
      ruleSet: seed as unknown as SignedRuleSet,
      ruleSetV2: allCores,
      capabilities: cores,
      cache: new SettingsCache(storage),
    });
    scripts.push(script);
    await script.start();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ADV-1: the hooks' trusted link listener feeds the same tracker the URL watch reads", async () => {
    fake();
    const added = vi.spyOn(document, "addEventListener");
    // No injected tracker: the script's own hooks and URL watch must share theirs.
    const h = await host("https://www.instagram.com/reel/A1/", null);
    const onLink = added.mock.calls.find(([type, , capture]) => type === "click" && capture === true)?.[1] as
      | ((event: Event) => void)
      | undefined;
    expect(onLink).toBeDefined();
    const anchor = document.createElement("a");
    anchor.href = "https://www.instagram.com/reel/B2/";
    document.body.append(anchor);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    // jsdom cannot create a trusted event; force only isTrusted (and the path), as the browser would.
    const trusted = new Proxy(click, {
      get(target, key) {
        if (key === "isTrusted") return true;
        if (key === "composedPath") return () => [anchor, document.body, document];
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    onLink!(trusted);
    expect(click.defaultPrevented).toBe(false); // the site routes the click itself
    await vi.advanceTimersByTimeAsync(2_000);
    h.pagePush("/reel/B2/");
    await tickWatch();
    expect(h.replace).not.toHaveBeenCalled();
    anchor.remove();
  });

  it("ADV-2: a Back taken while the tab is hidden is not mistaken for the page advancing", async () => {
    fake();
    const h = await host("https://www.facebook.com/reel/111");
    h.intents.recordLink(new URL("https://www.facebook.com/reel/222"));
    h.pagePush("/reel/222");
    await tickWatch(); // seen as the deliberate move
    expect(h.replace).not.toHaveBeenCalled();
    setVisibility("hidden");
    expect(h.back()).toBe("https://www.facebook.com/reel/111");
    setVisibility("visible");
    await tickWatch();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("ADV-3: re-enabling starts from the current URL, not a move made while Off", async () => {
    fake();
    const h = await host("https://www.instagram.com/reel/A1/");
    await h.writer.commit({ path: "sites.instagram.reels", value: false, updatedAt: 2 });
    h.script.reapply();
    h.pagePush("/reel/B2/");
    await tickWatch();
    await h.writer.commit({ path: "sites.instagram.reels", value: true, updatedAt: 3 });
    h.script.reapply();
    await tickWatch();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("hashchange reports the move at once while the tab is visible", async () => {
    fake();
    const h = await host("https://www.facebook.com/reel/111");
    h.pagePush("/reel/222#next");
    h.fire("hashchange"); // no timer tick: the event alone reports it
    expect(h.replace).toHaveBeenCalledWith("https://www.facebook.com/");
  });

  it("hashchange still reports while the tab is hidden (only the timer pauses)", async () => {
    fake();
    const h = await host("https://www.facebook.com/reel/111");
    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    h.pagePush("/reel/222#next");
    h.fire("hashchange");
    expect(h.replace).toHaveBeenCalledWith("https://www.facebook.com/");
  });

  it("popstate and hashchange listeners are removed after Off and again after stop", async () => {
    fake();
    const count = (h: Awaited<ReturnType<typeof host>>) => [h.listeners.get("popstate")?.size ?? 0, h.listeners.get("hashchange")?.size ?? 0];
    const h = await host("https://www.instagram.com/reel/A1/");
    expect(h.listeners.get("hashchange")?.size).toBe(1);
    expect(h.listeners.get("popstate")?.size).toBeGreaterThan(0);
    await h.writer.commit({ path: "services.instagram", value: false, updatedAt: 2 });
    await h.cache.rereadAuthority?.();
    h.script.reapply();
    expect(h.listeners.get("hashchange")?.size ?? 0).toBe(0);
    // A later hashchange can no longer move anything.
    h.pagePush("/reel/B2/#x");
    h.fire("hashchange");
    expect(h.replace).not.toHaveBeenCalled();
    h.script.stop();
    expect(count(h)).toEqual([0, 0]);
  });

  it("stop removes every history listener the watch added", async () => {
    fake();
    const h = await host("https://www.facebook.com/reel/111");
    expect(h.listeners.get("hashchange")?.size).toBe(1);
    h.script.stop();
    expect(h.listeners.get("popstate")?.size ?? 0).toBe(0);
    expect(h.listeners.get("hashchange")?.size ?? 0).toBe(0);
  });
});
