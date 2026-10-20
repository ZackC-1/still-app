import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentScriptHandle } from "../index.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";
import { createModernShippingContentEntry } from "../modern-shipping-entry.js";
import { PACKAGED_RULE_SET_V2 } from "../../rules/packaged.js";
import { FACEBOOK_REELS_RULES } from "../../rules/facebook.js";
import { ruleSet } from "../../rules/__tests__/format2-fixtures.js";

const scripts: ContentScriptHandle[] = [];
const bundle = { ...ruleSet, services: { facebook: FACEBOOK_REELS_RULES } };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});
function host(file = "facebook.html", href = "https://www.facebook.com/") {
  return createFormat2EntryHost(bundle, file, href, scripts);
}

const hidden = (id: string) =>
  getComputedStyle(document.getElementById(id)!).display === "none";
describe("captured Facebook Reels through maintained extension entry and atomic settings authority", () => {
  it("legacy entry keeps settings watch after hydration and normal stop releases its resources", async () => {
    const h = await host("facebook.html");
    const player = document.getElementById("keep-sponsored-post")!;
    let release!: () => void;
    h.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const script = await h.start(false);
    expect(h.listeners.size).toBe(2);
    release();
    await tick();
    expect(h.listeners.size).toBe(4);
    expect(document.getElementById("keep-sponsored-post")).toBe(player);
    script.stop();
    expect(h.listeners.size).toBe(0);
  });
  it("actual writer feature/master/service Off restore owned targets, ordinary card listeners and nodes survive", async () => {
    const h = await host();
    const normal = document.getElementById("keep-article")!;
    const click = vi.fn();
    normal.addEventListener("click", click);
    const before = normal.outerHTML;
    const script = await h.start();
    expect(hidden("reel-article")).toBe(true);
    expect(hidden("keep-article")).toBe(false);
    for (const path of [
      "sites.facebook.reels",
      "globalOn",
      "services.facebook",
    ] as const) {
      await h.authority.commitIntent({
        path,
        value: false,
        updatedAt: Date.now(),
      });
      expect(hidden("reel-article")).toBe(false);
      await h.authority.commitIntent({
        path,
        value: true,
        updatedAt: Date.now(),
      });
      expect(hidden("reel-article")).toBe(true);
    }
    expect(normal.outerHTML).toBe(before);
    normal.dispatchEvent(new MouseEvent("click"));
    expect(click).toHaveBeenCalledOnce();
    script.stop();
    expect(hidden("reel-article")).toBe(false);
    expect(h.listeners.size).toBe(0);
    expect(document.querySelector("#keep-article")).toBe(normal);
  });
  it("saved Off and a route changed during delayed read never redirect a stale Reel target", async () => {
    const h = await host(
      "facebook.html",
      "https://www.facebook.com/reels/old/?chosen=1",
    );
    await h.authority.commitIntent({
      path: "sites.facebook.reels",
      value: false,
      updatedAt: 2,
    });
    let release!: () => void;
    h.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await h.start();
    expect(document.querySelector("style")).toBeNull();
    h.setHref("https://www.facebook.com/messages/?chosen=1");
    release();
    await tick();
    expect(h.replace).not.toHaveBeenCalled();
    expect(hidden("reel-article")).toBe(false);
    expect(await h.authority.get()).toMatchObject({
      settings: { sites: { "facebook.reels": false } },
    });
  });
  it("stop while reading storage fences all late owned DOM effects and resources", async () => {
    const h = await host();
    let release!: () => void;
    h.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const script = await h.start();
    script.stop();
    release();
    await tick();
    expect(hidden("reel-article")).toBe(false);
    expect(h.listeners.size).toBe(0);
    expect(document.querySelector("style")).toBeNull();
  });
  it("an actual writer Off during a held older read wins before the first owned DOM effect", async () => {
    const h = await host();
    let release!: () => void;
    h.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await h.start();
    await h.authority.commitIntent({
      path: "sites.facebook.reels",
      value: false,
      updatedAt: 2,
    });
    release();
    await tick();
    expect(await h.authority.get()).toMatchObject({
      settings: { sites: { "facebook.reels": false } },
    });
    expect(hidden("reel-article")).toBe(false);
  });
  it("failed actual storage read holds effects and releases the entry's owned access listeners", async () => {
    const h = await host();
    h.failRead();
    await h.start();
    await tick();
    expect(hidden("reel-article")).toBe(false);
    expect(h.listeners.size).toBe(0);
    expect(document.querySelector("style")).toBeNull();
  });
  it("a late unsigned legacy entitlement does not overwrite saved feature Off or grant optional effects", async () => {
    const h = await host();
    await h.authority.commitIntent({
      path: "sites.facebook.reels",
      value: false,
      updatedAt: 2,
    });
    await h.start();
    await chrome.storage.local.set({
      "still:entitlement": { entitled: true, updatedAt: Date.now() },
    });
    await tick();
    expect(hidden("reel-article")).toBe(false);
    expect(await h.authority.get()).toMatchObject({
      settings: { sites: { "facebook.reels": false } },
    });
  });
  it("the current hidden-media adapter quiets only owned playing media and never autoplays recycled or restored content", async () => {
    const h = await host();
    function player(id: string) {
      const video = document.createElement("video");
      let paused = false;
      Object.defineProperty(video, "paused", { get: () => paused });
      video.currentTime = 7;
      video.volume = 0.4;
      video.muted = true;
      const pause = vi.spyOn(video, "pause").mockImplementation(() => {
        paused = true;
      });
      const play = vi.spyOn(video, "play").mockResolvedValue();
      document.getElementById(id)!.append(video);
      return {
        video,
        pause,
        play,
        resume: () => {
          paused = false;
        },
      };
    }
    const reel = player("reel-article"),
      normal = player("keep-article");
    const script = await h.start();
    reel.video.dispatchEvent(new Event("playing"));
    normal.video.dispatchEvent(new Event("playing"));
    expect(hidden("reel-article")).toBe(true);
    expect(reel.pause).toHaveBeenCalled();
    expect(normal.pause).not.toHaveBeenCalled();
    expect(reel.video.currentTime).toBe(7);
    expect(reel.video.volume).toBe(0.4);
    expect(reel.video.muted).toBe(true);
    expect(reel.play).not.toHaveBeenCalled();
    document
      .querySelector("#reel-article > a")!
      .setAttribute("href", "/story.php?story_fbid=ordinary");
    reel.resume();
    reel.pause.mockClear();
    reel.video.dispatchEvent(new Event("playing"));
    expect(hidden("reel-article")).toBe(false);
    expect(reel.pause).not.toHaveBeenCalled();
    document
      .querySelector("#reel-article > a")!
      .setAttribute("href", "/reel/recycled/");
    reel.video.dispatchEvent(new Event("playing"));
    expect(reel.pause).toHaveBeenCalled();
    await h.authority.commitIntent({
      path: "sites.facebook.reels",
      value: false,
      updatedAt: 2,
    });
    expect(hidden("reel-article")).toBe(false);
    expect(reel.play).not.toHaveBeenCalled();
    reel.resume();
    reel.pause.mockClear();
    reel.video.dispatchEvent(new Event("playing"));
    expect(reel.pause).not.toHaveBeenCalled();
    script.stop();
    expect(h.listeners.size).toBe(0);
    expect(reel.video.isConnected).toBe(true);
    expect(normal.play).not.toHaveBeenCalled();
  });
});

// ISS-0084 (iPhone Safari, 19 Oct 2026): a live Off brought a Page's Reels tab back, a live On did
// not hide it again until a reload. This drives the iPhone path end to end: Safari's V3 shipping
// entry, the packaged rule set and the captured mobile Page tab row, with each live switch the
// popup can make.
describe("mobile Facebook Page Reels tab through Safari's shipping entry (ISS-0084)", () => {
  const tab = "fb-mobile-page-tab-reels";
  it.each([
    ["https://m.facebook.com/stilltestpage/", "services.facebook"],
    ["https://m.facebook.com/stilltestpage/", "sites.facebook.reels"],
    ["https://m.facebook.com/stilltestpage/", "globalOn"],
    ["https://www.facebook.com/stilltestpage/", "services.facebook"],
    ["https://www.facebook.com/stilltestpage/reels/", "services.facebook"],
  ] as const)("%s: live Off shows the tab, live On hides it again without a reload (%s)", async (href, path) => {
    const h = await createFormat2EntryHost(PACKAGED_RULE_SET_V2 as never, "facebook-mobile-page.html", href, scripts);
    const storage = (globalThis as unknown as { chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } } }).chrome.storage.local;
    await createModernShippingContentEntry({
      host: "safari",
      storage,
      prod: false,
      earlyRedirect: true,
      pendingCover: true,
      win: h.win,
      doc: document,
      onScriptCreated: (script) => scripts.push(script),
    })({ onInvalidated: () => {} });
    await tick();
    await tick();
    const row = document.getElementById("fb-mobile-page-tabs")!.outerHTML;
    expect(hidden(tab)).toBe(true);
    for (let round = 0; round < 2; round++) {
      await h.authority.commitIntent({ path, value: false, updatedAt: Date.now() });
      await tick();
      expect(hidden(tab)).toBe(false);
      await h.authority.commitIntent({ path, value: true, updatedAt: Date.now() });
      await tick();
      expect(hidden(tab)).toBe(true);
    }
    // Repeated Ons add one owned stylesheet, never a second, and nothing is written into the row.
    expect(document.querySelectorAll("style")).toHaveLength(1);
    expect(document.getElementById("fb-mobile-page-tabs")!.outerHTML).toBe(row);
    for (const id of ["keep-fb-mobile-page-tab-all", "keep-fb-mobile-page-tab-photos", "keep-fb-mobile-page-tab-mentions"])
      expect(hidden(id)).toBe(false);
  });
});

// ISS-0084, continued: what a live On does when the page itself touches Still's two root effects
// (the feature class on <html> and Still's <style>). Fresh-load-only reapply triggers
// (DOMContentLoaded, hydration) mask a page that rewrites <html class> or prunes <head> during its
// own boot; a live On has no such later trigger, so these drive the page's writes at each point
// of the owner's sequence.
describe("Still's root class and stylesheet survive the page's own writes (ISS-0084)", () => {
  const tab = "fb-mobile-page-tab-reels";
  const path = "services.facebook";
  const stillClasses = () => [...document.documentElement.classList].filter((name) => name.startsWith("still-"));
  /** What a page does when it sets its own root classes wholesale (className = "..."). */
  const rewriteRootClass = () => { document.documentElement.className = "ssr fab sai usf dpr-spacing unselectable"; };
  const dropStyles = () => { for (const style of document.querySelectorAll("style")) style.remove(); };
  async function safariPage(href = "https://m.facebook.com/stilltestpage/") {
    const h = await createFormat2EntryHost(PACKAGED_RULE_SET_V2 as never, "facebook-mobile-page.html", href, scripts);
    const storage = (globalThis as unknown as { chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } } }).chrome.storage.local;
    await createModernShippingContentEntry({
      host: "safari", storage, prod: false, earlyRedirect: true, pendingCover: true,
      win: h.win, doc: document, onScriptCreated: (script) => scripts.push(script),
    })({ onInvalidated: () => {} });
    await tick();
    await tick();
    expect(hidden(tab)).toBe(true);
    const set = async (value: boolean) => {
      await h.authority.commitIntent({ path, value, updatedAt: Date.now() });
      await tick();
    };
    return { h, set };
  }

  it("the page rewriting <html class> between a live Off and On: On hides the tab again", async () => {
    const { set } = await safariPage();
    await set(false);
    rewriteRootClass();
    await set(true);
    expect(hidden(tab)).toBe(true);
  });

  it("the page pruning <head> between a live Off and On: On hides the tab again", async () => {
    const { set } = await safariPage();
    await set(false);
    dropStyles();
    await set(true);
    expect(hidden(tab)).toBe(true);
  });

  it("the page redrawing its tab row on the Off's resize: On hides the redrawn tab", async () => {
    const { set } = await safariPage();
    let redraws = 0;
    const redraw = () => {
      const row = document.getElementById("fb-mobile-page-tabs")!;
      row.replaceWith(row.cloneNode(true));
      redraws++;
    };
    window.addEventListener("resize", redraw);
    try {
      await set(false);
      expect(redraws).toBe(1);
      expect(hidden(tab)).toBe(false);
      await set(true);
      expect(hidden(tab)).toBe(true);
    } finally {
      window.removeEventListener("resize", redraw);
    }
  });

  it("the page rewriting <html class> after a live On (the popup closing): the tab stays hidden", async () => {
    const { set } = await safariPage();
    await set(false);
    await set(true);
    expect(hidden(tab)).toBe(true);
    rewriteRootClass();
    await tick();
    expect(hidden(tab)).toBe(true);
    expect(document.documentElement.classList.contains("dpr-spacing")).toBe(true); // the page's own classes stay
  });

  it("the page pruning <head> after a live On: the tab stays hidden with one Still stylesheet", async () => {
    const { set } = await safariPage();
    await set(false);
    await set(true);
    dropStyles();
    await tick();
    expect(hidden(tab)).toBe(true);
    expect(document.querySelectorAll("style")).toHaveLength(1);
  });

  it("the page rewriting <html class> after the first apply: the tab stays hidden", async () => {
    await safariPage();
    rewriteRootClass();
    await tick();
    expect(hidden(tab)).toBe(true);
  });

  it("a live Off still removes everything, and the page's writes while Off never bring it back", async () => {
    const { set } = await safariPage();
    await set(false);
    expect(stillClasses()).toEqual([]);
    expect(document.querySelectorAll("style")).toHaveLength(0);
    rewriteRootClass();
    document.head.append(document.createElement("meta"));
    await tick();
    expect(hidden(tab)).toBe(false);
    expect(stillClasses()).toEqual([]);
    expect(document.querySelectorAll("style")).toHaveLength(0);
  });

  it("a page that strips Still's class on every write gets a bounded number of re-asserts", async () => {
    const { set } = await safariPage();
    await set(true);
    let strips = 0;
    const fighter = new MutationObserver(() => {
      if (stillClasses().length === 0) return;
      strips++;
      for (const name of stillClasses()) document.documentElement.classList.remove(name);
    });
    fighter.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    try {
      rewriteRootClass();
      for (let i = 0; i < 5; i++) await tick();
      expect(strips).toBeGreaterThan(0);
      expect(strips).toBeLessThanOrEqual(20);
    } finally {
      fighter.disconnect();
    }
  });
});
