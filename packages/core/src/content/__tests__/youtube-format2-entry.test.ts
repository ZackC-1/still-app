import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { createExtensionContentEntry } from "../extension-entry.js";
import type { ContentScriptHandle, StillWindow } from "../index.js";
import { ChromeStorageAdapter } from "../../storage/chrome-adapter.js";
import { YOUTUBE_SHORTS_RULES } from "../../rules/youtube.js";
import { ruleSet } from "../../rules/__tests__/format2-fixtures.js";

const scripts: ContentScriptHandle[] = [];
const bundle = { ...ruleSet, services: { youtube: YOUTUBE_SHORTS_RULES } };
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
  file = "youtube-mobile.html",
  href = "https://m.youtube.com/",
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
describe("captured Shorts through maintained extension entry and atomic settings authority", () => {
  it("legacy entry keeps settings watch after hydration and normal stop releases its resources", async () => {
    const h = await host("youtube-watch.html");
    const player = document.getElementById("keep-player")!;
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
    expect(document.getElementById("keep-player")).toBe(player);
    script.stop();
    expect(h.listeners.size).toBe(0);
  });
  it("actual writer feature/master/service Off restore owned targets, ordinary card listeners and nodes survive", async () => {
    const h = await host();
    const normal = document.getElementById("keep-mobile-video")!;
    const click = vi.fn();
    normal.addEventListener("click", click);
    const before = normal.outerHTML;
    const script = await h.start();
    expect(hidden("mobile-shorts-card")).toBe(true);
    expect(hidden("keep-mobile-video")).toBe(false);
    for (const path of [
      "sites.youtube.shorts",
      "globalOn",
      "services.youtube",
    ] as const) {
      await h.authority.commitIntent({
        path,
        value: false,
        updatedAt: Date.now(),
      });
      expect(hidden("mobile-shorts-card")).toBe(false);
      await h.authority.commitIntent({
        path,
        value: true,
        updatedAt: Date.now(),
      });
      expect(hidden("mobile-shorts-card")).toBe(true);
    }
    expect(normal.outerHTML).toBe(before);
    normal.dispatchEvent(new MouseEvent("click"));
    expect(click).toHaveBeenCalledOnce();
    script.stop();
    expect(hidden("mobile-shorts-card")).toBe(false);
    expect(h.listeners.size).toBe(0);
    expect(document.querySelector("#keep-mobile-video")).toBe(normal);
  });
  it("saved Off and a route changed during delayed read never redirect a stale Shorts target", async () => {
    const h = await host(
      "youtube.html",
      "https://www.youtube.com/shorts/old?list=chosen",
    );
    await h.authority.commitIntent({
      path: "sites.youtube.shorts",
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
    h.setHref("https://www.youtube.com/watch?v=chosen&list=queue");
    release();
    await tick();
    expect(h.replace).not.toHaveBeenCalled();
    expect(hidden("shelf")).toBe(false);
    expect(await h.authority.get()).toMatchObject({
      settings: { sites: { "youtube.shorts": false } },
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
    expect(hidden("mobile-shorts-card")).toBe(false);
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
      path: "sites.youtube.shorts",
      value: false,
      updatedAt: 2,
    });
    release();
    await tick();
    expect(await h.authority.get()).toMatchObject({
      settings: { sites: { "youtube.shorts": false } },
    });
    expect(hidden("mobile-shorts-card")).toBe(false);
  });
  it("failed actual storage read holds effects and releases the entry's owned access listeners", async () => {
    const h = await host();
    h.failRead();
    await h.start();
    await tick();
    expect(hidden("mobile-shorts-card")).toBe(false);
    expect(h.listeners.size).toBe(0);
    expect(document.querySelector("style")).toBeNull();
  });
  it("a late unsigned legacy entitlement does not overwrite saved feature Off or grant optional effects", async () => {
    const h = await host();
    await h.authority.commitIntent({
      path: "sites.youtube.shorts",
      value: false,
      updatedAt: 2,
    });
    await h.start();
    await chrome.storage.local.set({
      "still:entitlement": { entitled: true, updatedAt: Date.now() },
    });
    await tick();
    expect(hidden("mobile-shorts-card")).toBe(false);
    expect(await h.authority.get()).toMatchObject({
      settings: { sites: { "youtube.shorts": false } },
    });
  });
});
