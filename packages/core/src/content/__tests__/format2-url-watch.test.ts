import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, FEATURE_REGISTRY, type SettingsField, type BenefitId, type SignedRuleSet, type SignedRuleSetV2 } from "@still/shared-types";
import { AtomicSettingsWriter } from "../../storage/atomic-settings.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { SettingsCache } from "../../storage/cache.js";
import { createContentScript, type ContentScriptHandle } from "../index.js";
import { createNavigationIntentTracker, URL_WATCH_INTERVAL_MS, type NavigationIntentTracker, type StillWindow } from "../redirect.js";
import { createCoreRouteClassifier, createCoveredWindow, createReelContinuationProbe } from "../modern-shipping-entry.js";
import { createPendingCover, PENDING_COVER_CLASS, type PendingCover } from "../pending-cover.js";
import { ruleSet } from "../../rules/__tests__/format2-fixtures.js";
import seed from "../../../rules/seed.json";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../../rules/packaged.js";
import { ACCESS_BENEFITS, accessCapabilities, initialAccessSnapshot } from "../../entitlement/access-policy.js";
import type { EntitlementCache } from "../../entitlement/cache.js";

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
/** Paid ON inside the test only: the real packaged set and implementation table, Instagram extras purchased. */
function paidOnDeps() {
  const base = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  const snapshot = { ...base, states: { ...base.states, "instagram.explore": "purchased", "instagram.stories": "purchased", "instagram.suggested": "purchased", "instagram.threads": "purchased" } } as typeof base;
  const entitlement = {
    current: () => true, currentAccessSnapshot: () => snapshot, subscribeAccess: () => () => {}, subscribe: () => () => {},
    watch: () => () => {}, refreshAccess: async () => {}, hydrate: async () => {},
  } as unknown as EntitlementCache;
  return { ruleSetV2: admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!, capabilities: accessCapabilities({ paidMode: true, host: "firefox" }), entitlement };
}

/**
 * The SHIPPED defaults: the real packaged set, NO capabilities (so the engine's packaged paid-off
 * capabilities apply), and an access snapshot that nevertheless claims every Still Pro benefit is
 * purchased. Only the dormancy gate stands between these settings and an effective extra.
 */
function shippedDefaultsAllPurchased() {
  const base = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  const pro = FEATURE_REGISTRY.filter((feature) => feature.tier === "pro").map((feature) => [feature.id, "purchased"]);
  const snapshot = { ...base, states: { ...base.states, ...Object.fromEntries(pro) } } as typeof base;
  const entitlement = {
    current: () => true, currentAccessSnapshot: () => snapshot, subscribeAccess: () => () => {}, subscribe: () => () => {},
    watch: () => () => {}, refreshAccess: async () => {}, hydrate: async () => {},
  } as unknown as EntitlementCache;
  return { ruleSetV2: admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!, capabilities: undefined, entitlement };
}

async function host(href: string, intents: NavigationIntentTracker | null = createNavigationIntentTracker(),
  paid?: { ruleSetV2: SignedRuleSetV2; capabilities: ReadonlySet<BenefitId> | undefined; entitlement: EntitlementCache },
  overrides: {
    MutationObserver?: typeof MutationObserver;
    /** Optional view of the window the script gets (the Safari V3 entry's covered window). */
    wrapWin?: (win: StillWindow) => StillWindow;
  } = {}) {
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
    MutationObserver: overrides.MutationObserver ?? window.MutationObserver,
    // Deliberately no `navigation`: this is the fallback's whole precondition.
  };
  const script = createContentScript({
    win: overrides.wrapWin ? overrides.wrapWin(win) : win,
    doc: document,
    ruleSet: seed as unknown as SignedRuleSet,
    ruleSetV2: paid ? paid.ruleSetV2 : allCores,
    capabilities: paid ? paid.capabilities : cores,
    entitlement: paid?.entitlement,
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

  it("a Still Pro extra alone (Reels Off) still follows in-page moves: Explore routes and the search-entry mark tracks the address", async () => {
    fake();
    window.history.replaceState(null, "", "/");
    const h = await host("https://www.instagram.com/", createNavigationIntentTracker(), paidOnDeps());
    await h.writer.commit({ path: "sites.instagram.reels", value: false, updatedAt: 2 });
    await h.writer.commit({ path: "sites.instagram.explore", value: true, updatedAt: 3 });
    await h.cache.rereadAuthority?.();
    h.script.reapply();
    const move = async (path: string) => {
      h.pagePush(path);
      window.history.replaceState(null, "", path); // the document's own address, which the marker reads
      await tickWatch();
    };
    const marked = () => document.documentElement.hasAttribute("data-still-instagram-search-entry");
    await move("/explore/?hl=fr");
    expect(h.replace).toHaveBeenCalledWith("https://www.instagram.com/explore/search/?hl=fr");
    await move("/explore/search/");
    expect(marked(), "the no-query search entry is marked").toBe(true);
    await move("/explore/search/keyword/?q=%23cats");
    expect(marked(), "a deliberate results page is never marked, even after an in-page move").toBe(false);
    await move("/explore/search/");
    expect(marked()).toBe(true);
    h.script.stop();
    expect(marked(), "stop removes the mark").toBe(false);
    window.history.replaceState(null, "", "/");
  });

  it("the search-entry mark clears when Instagram renders its own results, before they are painted, not a poll later", async () => {
    fake();
    window.history.replaceState(null, "", "/explore/search/");
    const observers = { connected: 0, disconnected: 0 };
    const Real = window.MutationObserver;
    const paid = paidOnDeps();
    const h = await host("https://www.instagram.com/explore/search/", createNavigationIntentTracker(), paid, {
      MutationObserver: class extends Real {
        override observe(target: Node, options?: MutationObserverInit) { observers.connected++; super.observe(target, options); }
        override disconnect() { observers.disconnected++; super.disconnect(); }
      },
    });
    await h.writer.commit({ path: "sites.instagram.reels", value: false, updatedAt: 2 });
    await h.writer.commit({ path: "sites.instagram.explore", value: true, updatedAt: 3 });
    await h.cache.rereadAuthority?.();
    h.script.reapply();
    const marked = () => document.documentElement.hasAttribute("data-still-instagram-search-entry");
    expect(marked(), "the empty search entry is marked").toBe(true);
    expect(observers.connected - observers.disconnected, "the address observer runs while marked").toBe(1);
    // Instagram's own move to a deliberate results page: the address changes, then it renders.
    h.pagePush("/explore/search/keyword/?q=%23cats");
    window.history.replaceState(null, "", "/explore/search/keyword/?q=%23cats");
    const results = document.createElement("div");
    results.innerHTML = '<a href="/p/X1/">An invented result</a>';
    document.body.append(results);
    await Promise.resolve(); // the mutation callback (a microtask, before any paint); no timer runs
    expect(marked(), "a results page is never painted under the search entry's mark").toBe(false);
    expect(observers.connected - observers.disconnected, "the observer stops with the mark").toBe(0);
    // Back to the empty search entry: the poll (unchanged) marks it again and the observer returns.
    h.pagePush("/explore/search/");
    window.history.replaceState(null, "", "/explore/search/");
    await tickWatch();
    expect(marked()).toBe(true);
    expect(observers.connected - observers.disconnected).toBe(1);
    h.script.stop();
    expect(marked()).toBe(false);
    expect(observers.connected - observers.disconnected, "stop disconnects it").toBe(0);
    results.remove();
    window.history.replaceState(null, "", "/");
  });

  describe("paid-off pin: shipped defaults never let an extra drive the URL watch, mark or routes", () => {
    const IG_EXTRAS = ["instagram.explore", "instagram.stories", "instagram.suggested", "instagram.threads"];
    const FB_EXTRAS = ["facebook.stories", "facebook.videos", "facebook.sponsored"];
    const pages = [
      ["instagram", "https://www.instagram.com/"],
      ["instagram", "https://www.instagram.com/explore/search/"],
      ["instagram", "https://www.instagram.com/explore/?hl=fr"],
      ["facebook", "https://www.facebook.com/"],
    ] as const;
    const bools = [true, false];
    const combos = bools.flatMap((globalOn) => bools.flatMap((service) => bools.flatMap((reels) =>
      bools.flatMap((igExtras) => bools.map((fbExtras) => ({ globalOn, service, reels, igExtras, fbExtras }))))));

    it.each(pages)("%s %s: listener attached exactly when Reels is effective; no mark; never redirected", async (service, href) => {
      expect(combos).toHaveLength(32);
      fake();
      const mark = () => document.documentElement.hasAttribute("data-still-instagram-search-entry");
      for (const combo of combos) {
        const label = `${href} ${JSON.stringify(combo)}`;
        window.history.replaceState(null, "", new URL(href).pathname + new URL(href).search);
        let observed = 0;
        const Real = window.MutationObserver;
        const h = await host(href, createNavigationIntentTracker(), shippedDefaultsAllPurchased(), {
          MutationObserver: class extends Real {
            override observe(target: Node, options?: MutationObserverInit) { observed++; super.observe(target, options); }
          },
        });
        let at = 2;
        const commit = (path: string, value: boolean) => h.writer.commit({ path: path as SettingsField, value, updatedAt: at++ });
        await commit("globalOn", combo.globalOn);
        await commit(`services.${service}`, combo.service);
        await commit(`sites.${service}.reels`, combo.reels);
        for (const id of IG_EXTRAS) await commit(`sites.${id}`, combo.igExtras);
        for (const id of FB_EXTRAS) await commit(`sites.${id}`, combo.fbExtras);
        await h.cache.rereadAuthority?.();
        h.script.reapply();
        const reelsEffective = combo.globalOn && combo.service && combo.reels;
        expect(h.listeners.get("hashchange")?.size ?? 0, `${label}: hashchange listener`).toBe(reelsEffective ? 1 : 0);
        expect(vi.getTimerCount() > 0, `${label}: poll timer`).toBe(reelsEffective);
        expect(mark(), `${label}: no search-entry mark`).toBe(false);
        if (service === "instagram") {
          // An in-page move to the Explore hub (only seen by the poll when it runs) is never routed.
          h.pagePush("/explore/?hl=fr");
          window.history.replaceState(null, "", "/explore/?hl=fr");
          h.fire("hashchange");
          await tickWatch();
          expect(mark(), `${label}: no mark after a move`).toBe(false);
        }
        expect(observed, `${label}: no address observer while paid is off`).toBe(0);
        expect(h.replace, `${label}: never redirected`).not.toHaveBeenCalled();
        expect(h.assign, label).not.toHaveBeenCalled();
        h.script.stop();
        scripts.splice(scripts.indexOf(h.script), 1);
        expect(vi.getTimerCount(), `${label}: stop clears the poll`).toBe(0);
      }
      window.history.replaceState(null, "", "/");
    });
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

// U7-W3 x the Instagram extras URL watch: on Safari V3 builds the content script gets the covered
// window. The watch follows extras too, but only core short-form redirects are ever covered.
describe("Safari cover on URL-watch redirects (V3-D-052: core only, never extras)", () => {
  const packaged = admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!;
  const routes = { destination: createCoreRouteClassifier(packaged), continuationHome: createReelContinuationProbe(packaged) };
  const covered = () => document.documentElement.classList.contains(PENDING_COVER_CLASS);
  const covers: PendingCover[] = [];
  afterEach(() => { for (const cover of covers.splice(0)) cover.stop(); });
  /** The covered window, observing whether the page was covered at each replacement Still made. */
  function coveredView(seen: boolean[]) {
    return (win: StillWindow): StillWindow => {
      const cover = createPendingCover({ doc: document, win: window });
      covers.push(cover);
      const observed: StillWindow = {
        ...win,
        location: {
          get href() { return win.location.href; },
          replace: (url) => { seen.push(covered()); win.location.replace(url); },
          assign: (url) => win.location.assign!(url),
        },
      };
      return createCoveredWindow(observed, cover, routes);
    };
  }

  it("Explore routed by the watch (extra alone, Reels Off) is never covered", async () => {
    fake();
    window.history.replaceState(null, "", "/");
    const seen: boolean[] = [];
    const h = await host("https://www.instagram.com/", createNavigationIntentTracker(), paidOnDeps(), { wrapWin: coveredView(seen) });
    await h.writer.commit({ path: "sites.instagram.reels", value: false, updatedAt: 2 });
    await h.writer.commit({ path: "sites.instagram.explore", value: true, updatedAt: 3 });
    await h.cache.rereadAuthority?.();
    h.script.reapply();
    h.pagePush("/explore/?hl=fr");
    await tickWatch();
    expect(h.replace).toHaveBeenCalledWith("https://www.instagram.com/explore/search/?hl=fr");
    expect(seen).toEqual([false]);
    expect(covered()).toBe(false);
    window.history.replaceState(null, "", "/");
  });

  it("with Reels and Explore both on, a move into Reels is covered and a move into Explore is not", async () => {
    fake();
    window.history.replaceState(null, "", "/");
    const seen: boolean[] = [];
    const h = await host("https://www.instagram.com/", createNavigationIntentTracker(), paidOnDeps(), { wrapWin: coveredView(seen) });
    await h.writer.commit({ path: "sites.instagram.explore", value: true, updatedAt: 2 });
    await h.cache.rereadAuthority?.();
    h.script.reapply();
    h.pagePush("/explore/?hl=fr");
    await tickWatch();
    h.pagePush("/reels/");
    await tickWatch();
    expect(h.replace.mock.calls.map(([url]) => url)).toEqual([
      "https://www.instagram.com/explore/search/?hl=fr",
      "https://www.instagram.com/",
    ]);
    expect(seen).toEqual([false, true]);
    window.history.replaceState(null, "", "/");
  });
});
