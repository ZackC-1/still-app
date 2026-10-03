import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentScriptHandle } from "../index.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";
import { INSTAGRAM_REELS_RULES } from "../../rules/instagram.js";
import { ruleSet } from "../../rules/__tests__/format2-fixtures.js";

const scripts: ContentScriptHandle[] = [];
const bundle = { ...ruleSet, services: { instagram: INSTAGRAM_REELS_RULES } };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});
function host(
  file = "instagram-home.html",
  href = "https://www.instagram.com/",
) {
  return createFormat2EntryHost(bundle, file, href, scripts);
}

const hidden = (id: string) =>
  getComputedStyle(document.getElementById(id)!).display === "none";
describe("captured Reels through maintained extension entry and atomic settings authority", () => {
  it("legacy entry keeps settings watch after hydration and normal stop releases its resources", async () => {
    const h = await host("instagram-home.html");
    const player = document.getElementById("keep-sponsored-post-video")!;
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
    expect(document.getElementById("keep-sponsored-post-video")).toBe(player);
    script.stop();
    expect(h.listeners.size).toBe(0);
  });
  it("actual writer feature/master/service Off restore owned targets, ordinary card listeners and nodes survive", async () => {
    const h = await host();
    const normal = document.getElementById("keep-video-post-with-audio")!;
    const click = vi.fn();
    normal.addEventListener("click", click);
    const before = normal.outerHTML;
    const script = await h.start();
    expect(hidden("reel-post")).toBe(true);
    expect(hidden("keep-video-post-with-audio")).toBe(false);
    for (const path of [
      "sites.instagram.reels",
      "globalOn",
      "services.instagram",
    ] as const) {
      await h.authority.commitIntent({
        path,
        value: false,
        updatedAt: Date.now(),
      });
      expect(hidden("reel-post")).toBe(false);
      await h.authority.commitIntent({
        path,
        value: true,
        updatedAt: Date.now(),
      });
      expect(hidden("reel-post")).toBe(true);
    }
    expect(normal.outerHTML).toBe(before);
    normal.dispatchEvent(new MouseEvent("click"));
    expect(click).toHaveBeenCalledOnce();
    script.stop();
    expect(hidden("reel-post")).toBe(false);
    expect(h.listeners.size).toBe(0);
    expect(document.querySelector("#keep-video-post-with-audio")).toBe(normal);
  });
  it("saved Off and a route changed during delayed read never redirect a stale Reel target", async () => {
    const h = await host(
      "instagram-home.html",
      "https://www.instagram.com/reels/old/?chosen=1",
    );
    await h.authority.commitIntent({
      path: "sites.instagram.reels",
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
    h.setHref("https://www.instagram.com/direct/inbox/?chosen=1");
    release();
    await tick();
    expect(h.replace).not.toHaveBeenCalled();
    expect(hidden("reel-post")).toBe(false);
    expect(await h.authority.get()).toMatchObject({
      settings: { sites: { "instagram.reels": false } },
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
    expect(hidden("reel-post")).toBe(false);
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
      path: "sites.instagram.reels",
      value: false,
      updatedAt: 2,
    });
    release();
    await tick();
    expect(await h.authority.get()).toMatchObject({
      settings: { sites: { "instagram.reels": false } },
    });
    expect(hidden("reel-post")).toBe(false);
  });
  it("failed actual storage read holds effects and releases the entry's owned access listeners", async () => {
    const h = await host();
    h.failRead();
    await h.start();
    await tick();
    expect(hidden("reel-post")).toBe(false);
    expect(h.listeners.size).toBe(0);
    expect(document.querySelector("style")).toBeNull();
  });
  it("a late unsigned legacy entitlement does not overwrite saved feature Off or grant optional effects", async () => {
    const h = await host();
    await h.authority.commitIntent({
      path: "sites.instagram.reels",
      value: false,
      updatedAt: 2,
    });
    await h.start();
    await chrome.storage.local.set({
      "still:entitlement": { entitled: true, updatedAt: Date.now() },
    });
    await tick();
    expect(hidden("reel-post")).toBe(false);
    expect(await h.authority.get()).toMatchObject({
      settings: { sites: { "instagram.reels": false } },
    });
  });
});
