import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignedRuleSetV2 } from "@still/shared-types";
import type { ContentScriptHandle } from "../index.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../../rules/packaged.js";

// The YouTube Shorts-filter recovery on the format-2 lane: a plain-text Shorts search chip is
// marked and hidden by packaged data, and a Shorts-only search is left once through its own All
// tab, so an emptied result list cannot keep YouTube fetching (see the youtube-shorts-search
// continuation-loop solution). Committed Off never clicks; stop removes the marker.

const scripts: ContentScriptHandle[] = [];
const SEARCH = "https://www.youtube.com/results?search_query=example";
const packaged = admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

async function host(bundle: SignedRuleSetV2 = packaged) {
  const h = await createFormat2EntryHost(bundle, "youtube-shorts-filter.html", SEARCH, scripts);
  const allClicks = vi.fn();
  document.querySelector("#all button")!.addEventListener("click", allClicks);
  return { ...h, allClicks };
}
const hidden = (id: string) => getComputedStyle(document.getElementById(id)!).display === "none";

describe("format-2 YouTube Shorts-filter recovery", () => {
  it("hides the plain-text Shorts chip and leaves a Shorts-only search through All exactly once", async () => {
    const h = await host();
    const script = await h.start();
    expect(document.getElementById("shorts")!.hasAttribute("data-still-shorts-chip")).toBe(true);
    expect(hidden("shorts")).toBe(true);
    expect(hidden("all")).toBe(false);
    expect(hidden("videos")).toBe(false);
    expect(h.allClicks).toHaveBeenCalledTimes(1);
    script.reapply();
    script.reapply();
    expect(h.allClicks).toHaveBeenCalledTimes(1);
    expect((document.getElementById("search") as HTMLInputElement).value).toBe("example search");
  });

  it("committed Off shows the chip and never clicks; On restores the hide and recovery", async () => {
    const h = await host();
    await h.authority.commitIntent({ path: "sites.youtube.shorts", value: false, updatedAt: Date.now() });
    await h.start();
    expect(hidden("shorts")).toBe(false);
    expect(h.allClicks).not.toHaveBeenCalled();
    await h.authority.commitIntent({ path: "globalOn", value: false, updatedAt: Date.now() });
    await h.authority.commitIntent({ path: "sites.youtube.shorts", value: true, updatedAt: Date.now() });
    expect(hidden("shorts")).toBe(false);
    expect(h.allClicks).not.toHaveBeenCalled();
    await h.authority.commitIntent({ path: "globalOn", value: true, updatedAt: Date.now() });
    expect(hidden("shorts")).toBe(true);
    expect(h.allClicks).toHaveBeenCalledTimes(1);
  });

  it("a chip bar rendered after the URL commits is handled on YouTube's navigate-finish event", async () => {
    const h = await host();
    const bar = document.querySelector("yt-chip-cloud-renderer")!;
    bar.remove();
    await h.start();
    expect(h.allClicks).not.toHaveBeenCalled();
    document.body.prepend(bar);
    expect(hidden("shorts")).toBe(false); // no observer: nothing happens until a lifecycle event
    document.dispatchEvent(new Event("yt-navigate-finish"));
    expect(hidden("shorts")).toBe(true);
    expect(h.allClicks).toHaveBeenCalledTimes(1);
  });

  it("stop removes the marker and the listener, so the chip and later events are left alone", async () => {
    const h = await host();
    const script = await h.start();
    expect(hidden("shorts")).toBe(true);
    script.stop();
    expect(document.querySelector("[data-still-shorts-chip]")).toBeNull();
    expect(hidden("shorts")).toBe(false);
    document.dispatchEvent(new Event("yt-navigate-finish"));
    expect(document.querySelector("[data-still-shorts-chip]")).toBeNull();
    expect(h.allClicks).toHaveBeenCalledTimes(1);
  });

  it("rule data without the marker selector keeps the helper off (downloaded overrides win)", async () => {
    const youtube = packaged.services.youtube!;
    const withoutMarker: SignedRuleSetV2 = {
      ...packaged,
      services: {
        ...packaged.services,
        youtube: {
          ...youtube,
          surfaces: youtube.surfaces.map((surface) =>
            surface.action === "hide"
              ? { ...surface, selectors: surface.selectors.filter((s) => !s.includes("data-still-shorts-chip")) }
              : surface,
          ),
        },
      },
    };
    const h = await host(withoutMarker);
    await h.start();
    await tick();
    expect(document.querySelector("[data-still-shorts-chip]")).toBeNull();
    expect(h.allClicks).not.toHaveBeenCalled();
  });
});
