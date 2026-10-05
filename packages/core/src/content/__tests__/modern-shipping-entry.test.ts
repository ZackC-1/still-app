import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { createShippingContentEntry, type ShippingContentLane } from "../extension-entry.js";
import type { ContentScriptHandle } from "../index.js";
import type { NavigationEventLike } from "../redirect.js";
import {
  createCoreRouteClassifier,
  createModernShippingContentEntry,
  type ModernContentContext,
} from "../modern-shipping-entry.js";
import { PENDING_COVER_CLASS, type PendingCoverPhase, type PendingCoverRelease } from "../pending-cover.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../../rules/packaged.js";

// U7-W3: the V3 shipping entry's early redirect for every core route, and Safari's pending cover
// (V3-D-052 settings-loading cover plus the redirect-in-flight cover). Storage reads can be held
// and released in rounds, like format2-early-redirect.test.ts; the cover's timers are injected.

const scripts: ContentScriptHandle[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
type Host = Awaited<ReturnType<typeof createFormat2EntryHost>>;
type Area = { get(key: string): Promise<Record<string, unknown>> };
const local = () => (globalThis as unknown as { chrome: { storage: { local: Area } } }).chrome.storage.local;
const covered = () => document.documentElement.classList.contains(PENDING_COVER_CLASS);
let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  visibility = "visible";
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

const FIXTURE: Record<string, string> = {
  "www.youtube.com": "youtube.html",
  "m.youtube.com": "youtube-mobile.html",
  "www.instagram.com": "instagram-home.html",
  "www.facebook.com": "facebook.html",
  "www.tiktok.com": "tiktok.html",
};

interface Options {
  readonly pendingCover?: boolean;
  readonly earlyRedirect?: boolean;
  readonly factory?: typeof createModernShippingContentEntry | typeof createShippingContentEntry;
  /** Hold every storage read until a round is released. */
  readonly held?: boolean;
  readonly arrange?: (h: Host) => unknown;
  readonly navigation?: boolean;
}

async function open(href: string, options: Options = {}) {
  const h = await createFormat2EntryHost(PACKAGED_RULE_SET_V2 as never, FIXTURE[new URL(href).host]!, href, scripts);
  await options.arrange?.(h);
  const area = local();
  const original = area.get.bind(area);
  let queue: Array<() => void> = [];
  const settingsReads: string[] = [];
  vi.spyOn(area, "get").mockImplementation((key: string) => {
    if (key === "still:settings") settingsReads.push(key);
    if (!options.held) return original(key);
    return new Promise((resolve, reject) => queue.push(() => original(key).then(resolve, reject)));
  });
  // What the page looked like at each navigation Still issued.
  const coveredAtReplace: boolean[] = [];
  const navigate = h.replace.getMockImplementation()!;
  h.replace.mockImplementation((url: string) => {
    coveredAtReplace.push(covered());
    navigate(url);
  });
  const assign = vi.fn((url: string) => h.setHref(url));
  Object.assign(h.win.location, { assign });
  const navigateListeners: Array<(event?: NavigationEventLike) => void> = [];
  if (options.navigation)
    Object.assign(h.win, {
      navigation: {
        addEventListener: (type: string, listener: (event?: NavigationEventLike) => void) => {
          if (type === "navigate") navigateListeners.push(listener);
        },
        removeEventListener: () => {},
      },
    });
  const ceilings: Array<() => void> = [];
  const releases: Array<[PendingCoverRelease, PendingCoverPhase]> = [];
  let invalidate: (() => void) | null = null;
  const context: ModernContentContext = { onInvalidated: (listener) => { invalidate = listener; } };
  const lanes: ShippingContentLane[] = [];
  // The original entry ignores the cover fields; it shares the rest of the deps.
  const factory = (options.factory ?? createModernShippingContentEntry) as typeof createModernShippingContentEntry;
  const loading = factory({
    storage: area,
    prod: false,
    earlyRedirect: options.earlyRedirect ?? true,
    pendingCover: options.pendingCover ?? true,
    coverTiming: {
      now: () => 0,
      setTimer: (callback) => (ceilings.push(callback), ceilings.length),
      clearTimer: () => {},
      onRelease: (why, phase) => releases.push([why, phase]),
    },
    win: h.win,
    doc: document,
    onLane: (lane) => lanes.push(lane),
    onScriptCreated: (script) => scripts.push(script),
  })(context);
  const coveredAtCall = covered();
  const releaseRound = async () => {
    await tick();
    const round = queue;
    queue = [];
    for (const resolve of round) resolve();
    await tick();
    await tick();
  };
  const finish = async () => {
    if (options.held) for (let round = 0; round < 8; round++) await releaseRound();
    await loading;
    await tick();
    await tick();
  };
  return {
    h, loading, coveredAtCall, coveredAtReplace, settingsReads, releaseRound, finish, releases, lanes, assign,
    navigateListeners, invalidate: () => invalidate?.(),
    /** Run every armed ceiling timer (each guards its own token). */
    expire: () => { for (const run of ceilings.splice(0)) run(); },
  };
}

const CORE: ReadonlyArray<readonly [string, string]> = [
  ["https://www.youtube.com/shorts/abc123", "https://www.youtube.com/watch?v=abc123"],
  ["https://m.youtube.com/shorts/xyz789?feature=share", "https://m.youtube.com/watch?feature=share&v=xyz789"],
  ["https://www.instagram.com/reels/", "https://www.instagram.com/"],
  ["https://www.instagram.com/reels/C0de12/", "https://www.instagram.com/reel/C0de12/"],
  ["https://www.facebook.com/reels/", "https://www.facebook.com/"],
  ["https://www.facebook.com/watch/reels/", "https://www.facebook.com/"],
];
const NEVER: readonly string[] = [
  "https://www.instagram.com/",
  "https://www.instagram.com/explore/",
  "https://www.instagram.com/stories/someone/123/",
  "https://www.instagram.com/popular/cats/",
  "https://www.instagram.com/reel/C0de12/",
  "https://www.instagram.com/reels/audio/123/",
  "https://www.instagram.com/someone/reels/",
  "https://www.youtube.com/",
  "https://www.youtube.com/watch?v=abc123",
  "https://www.youtube.com/results?search_query=shorts",
  "https://www.youtube.com/@channel/shorts",
  "https://www.facebook.com/watch/",
  "https://www.facebook.com/reel/123",
  "https://www.facebook.com/somepage/reels/",
  "https://www.tiktok.com/foryou",
];
const OFF: Record<string, readonly string[]> = {
  youtube: ["globalOn", "services.youtube", "sites.youtube.shorts"],
  instagram: ["globalOn", "services.instagram", "sites.instagram.reels"],
  facebook: ["globalOn", "services.facebook", "sites.facebook.reels"],
};
const off = (path: string) => (h: Host) =>
  h.authority.commitIntent({ path: path as "globalOn", value: false, updatedAt: Date.now() });

describe("core route classifier", () => {
  const classify = createCoreRouteClassifier(admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!);

  it.each(CORE)("classifies %s as a core route to %s", (from, to) => {
    expect(classify(new URL(from))).toBe(to);
  });

  it.each(NEVER)("never classifies %s (optional, preserved or other routes)", (href) => {
    expect(classify(new URL(href))).toBeNull();
  });

  it.each(CORE)("never sends %s somewhere it would send again (no self loop)", (from) => {
    expect(classify(new URL(classify(new URL(from))!))).toBeNull();
  });
});

describe("Safari pending cover on the V3 entry", () => {
  it.each(CORE)("%s is covered at document_start, before any await", async (href) => {
    const r = await open(href, { held: true });
    expect(r.coveredAtCall).toBe(true);
    await r.finish();
  });

  it.each(NEVER)("%s is never covered", async (href) => {
    const r = await open(href, { held: true });
    expect(r.coveredAtCall).toBe(false);
    await r.finish();
    expect(covered()).toBe(false);
    expect(r.releases).toEqual([]);
  });

  it.each(CORE)("saved On: %s redirects once, covered, and the cover stays through the navigation", async (href, to) => {
    const r = await open(href);
    await r.finish();
    expect(r.h.replace).toHaveBeenCalledTimes(1);
    expect(r.h.replace).toHaveBeenCalledWith(to);
    expect(r.coveredAtReplace).toEqual([true]);
    expect(covered()).toBe(true); // committed: no release while the navigation is in flight
    r.expire();
    expect(covered()).toBe(false);
    expect(r.releases).toEqual([["ceiling", "pending"]]);
  });

  it.each(CORE.flatMap(([href]) => OFF[new URL(href).hostname.split(".").at(-2)!]!.map((path) => [href, path] as const)))(
    "saved Off: %s with %s off is uncovered as soon as settings are read, and never redirected",
    async (href, path) => {
      const r = await open(href, { held: true, arrange: off(path) });
      expect(r.coveredAtCall).toBe(true);
      await r.releaseRound();
      expect(covered()).toBe(false);
      await r.finish();
      expect(r.h.replace).not.toHaveBeenCalled();
      expect(r.releases).toEqual([["allowed", "pending"]]);
    },
  );

  it("unreadable settings remove the cover and nothing is redirected", async () => {
    const r = await open("https://www.instagram.com/reels/", {
      arrange: () => {
        const area = local();
        const original = area.get.bind(area);
        vi.spyOn(area, "get").mockImplementation((key: string) =>
          key === "still:settings" ? Promise.reject(new Error("unavailable")) : original(key));
      },
    });
    await r.finish();
    expect(covered()).toBe(false);
    expect(r.h.replace).not.toHaveBeenCalled();
    expect(r.lanes).toEqual([{ kind: "legacy", reason: "settings-unreadable" }]);
  });

  it("an SPA move away during the read removes the cover and cancels the redirect", async () => {
    const r = await open("https://www.youtube.com/shorts/abc123", { held: true });
    r.h.setHref("https://www.youtube.com/watch?v=chosen");
    await r.finish();
    expect(r.h.replace).not.toHaveBeenCalled();
    expect(covered()).toBe(false);
  });

  it("a redirect that throws removes the cover at once and is not retried", async () => {
    const r = await open("https://www.instagram.com/reels/");
    r.h.replace.mockImplementation(() => { throw new Error("navigation refused"); });
    await r.finish();
    expect(covered()).toBe(false);
    expect(r.releases).toEqual([["redirect-failed", "pending"]]);
    expect(r.h.replace).toHaveBeenCalledTimes(1);
  });

  it("legacy lane (schema-1 settings): no cover, and the legacy Shorts redirect is unchanged", async () => {
    const legacy = (h: Host) => { h.values["still:settings"] = { settings: { ...DEFAULT_SETTINGS, updatedAt: 5 }, syncMetadata: null }; };
    const r = await open("https://www.youtube.com/shorts/abc123", { held: true, arrange: legacy });
    await r.releaseRound();
    expect(covered()).toBe(false);
    await r.finish();
    expect(r.lanes).toEqual([{ kind: "legacy", reason: "settings-not-schema2" }]);
    expect(r.h.replace).toHaveBeenCalledTimes(1);
    expect(r.h.replace).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc123");
    expect(r.coveredAtReplace).toEqual([false]);
  });

  it("a legacy Instagram Reels page is uncovered and not redirected", async () => {
    const legacy = (h: Host) => { h.values["still:settings"] = { settings: { ...DEFAULT_SETTINGS, updatedAt: 5 }, syncMetadata: null }; };
    const r = await open("https://www.instagram.com/reels/", { arrange: legacy });
    await r.finish();
    expect(covered()).toBe(false);
    expect(r.h.replace).not.toHaveBeenCalled();
  });

  it("invalidation stops the cover with the script", async () => {
    const r = await open("https://www.youtube.com/shorts/abc123", { held: true });
    expect(covered()).toBe(true);
    r.invalidate();
    expect(covered()).toBe(false);
    await r.finish();
  });

  it("a late correction (App Group reconcile turns Reels back on) covers the redirect it causes", async () => {
    const r = await open("https://www.instagram.com/reels/", { arrange: off("sites.instagram.reels") });
    await r.finish();
    expect(covered()).toBe(false);
    await r.h.authority.commitIntent({ path: "sites.instagram.reels", value: true, updatedAt: Date.now() });
    await tick();
    expect(r.h.replace).toHaveBeenCalledWith("https://www.instagram.com/");
    expect(r.coveredAtReplace).toEqual([true]);
    expect(covered()).toBe(true);
    expect(r.releases).toEqual([["allowed", "pending"]]);
  });

  it("without the Navigation API, a page-driven move into Reels is covered before Still sends it home", async () => {
    const r = await open("https://www.instagram.com/");
    await r.finish();
    expect(covered()).toBe(false);
    r.h.setHref("https://www.instagram.com/reels/");
    await new Promise((resolve) => setTimeout(resolve, 400)); // the 250 ms URL watch
    expect(r.h.replace).toHaveBeenCalledWith("https://www.instagram.com/");
    expect(r.coveredAtReplace).toEqual([true]);
  });

  it.each([
    ["a consumed link (push)", "push", "assign"],
    ["a consumed traversal (replace)", "traverse", "replace"],
  ] as const)("with the Navigation API, %s leaves the ordinary page uncovered", async (_name, navigationType, method) => {
    const r = await open("https://www.instagram.com/someone/", { navigation: true });
    await r.finish();
    const preventDefault = vi.fn();
    for (const listener of r.navigateListeners)
      listener({
        destination: { url: "https://www.instagram.com/reels/" },
        isTrusted: true,
        cancelable: true,
        defaultPrevented: false,
        navigationType,
        userInitiated: true,
        preventDefault,
      });
    expect(preventDefault).toHaveBeenCalled();
    const called = method === "assign" ? r.assign : r.h.replace;
    expect(called).toHaveBeenCalledWith("https://www.instagram.com/");
    expect(covered()).toBe(false);
    expect(r.releases).toEqual([]);
  });
});

describe("early redirect for every core route (Firefox and Safari)", () => {
  it.each(CORE)("%s redirects after one storage round, before the content script hydrates", async (href, to) => {
    const r = await open(href, { held: true, pendingCover: false });
    await r.releaseRound();
    expect(r.h.replace).toHaveBeenCalledWith(to);
    await r.finish();
    expect(r.h.replace).toHaveBeenCalledTimes(1); // the hydrated script never replaces again
    expect(covered()).toBe(false); // no cover without the Safari switch
  });

  it("the original shipping entry leaves Instagram Reels to the hydrated script (the gap this closes)", async () => {
    const r = await open("https://www.instagram.com/reels/", { held: true, pendingCover: false, factory: createShippingContentEntry });
    await r.releaseRound();
    expect(r.h.replace).not.toHaveBeenCalled();
    await r.finish();
    expect(r.h.replace).toHaveBeenCalledTimes(1);
  });

  it("YouTube Shorts costs exactly the settings reads it did before; Reels pay one early read", async () => {
    const reads = async (href: string, factory: Options["factory"]) => {
      const r = await open(href, { factory, pendingCover: false });
      await r.finish();
      for (const script of scripts.splice(0)) script.stop();
      document.documentElement.className = "";
      return r.settingsReads.length;
    };
    const shorts = "https://www.youtube.com/shorts/abc123";
    expect(await reads(shorts, createModernShippingContentEntry)).toBe(await reads(shorts, createShippingContentEntry));
    const reels = "https://www.instagram.com/reels/";
    expect(await reads(reels, createModernShippingContentEntry)).toBe(await reads(reels, createShippingContentEntry) + 1);
  });

  it("Chromium (no content early redirect) keeps leaving hard loads to the hydrated script", async () => {
    const r = await open("https://www.instagram.com/reels/", { held: true, pendingCover: false, earlyRedirect: false });
    await r.releaseRound();
    expect(r.h.replace).not.toHaveBeenCalled();
    await r.finish();
    expect(r.h.replace).toHaveBeenCalledTimes(1);
  });
});
