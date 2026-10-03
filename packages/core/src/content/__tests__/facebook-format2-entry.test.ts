import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { createExtensionContentEntry } from "../extension-entry.js";
import type { ContentScriptHandle, StillWindow } from "../index.js";
import { ChromeStorageAdapter } from "../../storage/chrome-adapter.js";
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
async function host(
  file = "facebook.html",
  href = "https://www.facebook.com/",
) {
  const values: Record<string, unknown> = {};
  const listeners = new Set<
    (changes: Record<string, { newValue: unknown }>, area: string) => void
  >();
  let delay: Promise<void> | null = null;
  let nextReadFailure = false;
  vi.stubGlobal("chrome", {
    runtime: { getURL: () => "chrome-extension://fixture/" },
    storage: {
      local: {
        async get(key: string) {
          if (nextReadFailure && key === "still:settings") {
            nextReadFailure = false;
            throw new Error("Read unavailable");
          }
          const snapshot = structuredClone(values);
          if (delay && key === "still:settings") {
            const pending = delay;
            delay = null;
            await pending;
          }
          return snapshot;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(values, structuredClone(items));
          for (const listener of listeners)
            listener(
              Object.fromEntries(
                Object.entries(items).map(([key, newValue]) => [
                  key,
                  { newValue },
                ]),
              ),
              "local",
            );
        },
      },
      onChanged: {
        addListener: (
          fn: (
            changes: Record<string, { newValue: unknown }>,
            area: string,
          ) => void,
        ) => listeners.add(fn),
        removeListener: (
          fn: (
            changes: Record<string, { newValue: unknown }>,
            area: string,
          ) => void,
        ) => listeners.delete(fn),
      },
    },
  });
  const authority = new ChromeStorageAdapter({ authority: true });
  await authority.set({
    settings: { ...DEFAULT_SETTINGS, updatedAt: 1 },
    syncMetadata: null,
  });
  await authority.initializeAtomic("never-linked");
  let current = href;
  const replace = vi.fn((url: string) => {
    current = url;
  });
  const win: StillWindow = {
    location: {
      get href() {
        return current;
      },
      replace,
    },
    history: {
      pushState: (_data, _unused, url) => {
        if (url) current = new URL(url, current).href;
      },
      replaceState: (_data, _unused, url) => {
        if (url) current = new URL(url, current).href;
      },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    MutationObserver: window.MutationObserver,
  };
  const html = readFileSync(resolve("../../tests/fixtures", file), "utf8");
  document.body.innerHTML = new DOMParser().parseFromString(
    html,
    "text/html",
  ).body.innerHTML;
  return {
    authority,
    values,
    listeners,
    win,
    replace,
    setHref: (href: string) => {
      current = href;
    },
    hold: (pending: Promise<void>) => {
      delay = pending;
    },
    failRead: () => {
      nextReadFailure = true;
    },
    async start(modern = true) {
      await createExtensionContentEntry({
        storage: { get: async () => ({}) },
        bundledRuleSetV2: modern ? bundle : undefined,
        prod: false,
        earlyRedirect: true,
        win,
        doc: document,
        onScriptCreated: (script) => scripts.push(script),
      })();
      await tick();
      return scripts[scripts.length - 1]!;
    },
  };
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
    expect(h.listeners.size).toBe(3);
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
