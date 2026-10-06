import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignedRuleSetV2 } from "@still/shared-types";
import type { MarkerAdapter } from "../../rules/extras.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../../rules/packaged.js";
import { PACKAGED_MARKERS, SHORTS_CHIP_MARKER, admittedMarkers, createMarkerHook } from "../markers.js";
import { INSTAGRAM_EXTRAS } from "../../rules/instagram-extras.js";
import type { ContentScriptHandle } from "../index.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";

// The marker hook: data-still-* attributes exist only while their feature is effective, and Off,
// another service or teardown removes them. It installs no listeners or observers of its own.

const packaged = admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!;
const synthetic: MarkerAdapter = {
  feature: "youtube.comments", attribute: "data-still-synthetic-comments", candidates: ".candidate",
  ruleSelector: "[data-still-synthetic-comments]", owns: (element) => element.classList.contains("owned"),
};
const scripts: ContentScriptHandle[] = [];

beforeEach(() => {
  document.body.innerHTML = '<div class="candidate owned" id="a"></div><div class="candidate" id="b"></div><div class="other owned" id="c"></div>';
});
afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

const marked = () => [...document.querySelectorAll(`[${synthetic.attribute}]`)].map((element) => element.id);

describe("marker hook", () => {
  it("marks owned candidates only while the feature is effective, and Off removes every mark", () => {
    const hook = createMarkerHook(document, [synthetic]);
    hook.reconcile(["youtube.shorts"]);
    expect(marked()).toEqual([]);
    hook.reconcile(["youtube.shorts", "youtube.comments"]);
    expect(marked()).toEqual(["a"]);
    // A recycled node that no longer qualifies loses its stale mark on the next pass.
    document.getElementById("a")!.classList.remove("owned");
    document.getElementById("b")!.classList.add("owned");
    hook.reconcile(["youtube.comments"]);
    expect(marked()).toEqual(["b"]);
    hook.reconcile([]);
    expect(marked()).toEqual([]);
  });

  it("teardown removes every attribute an adapter owns and fences later reconciles", () => {
    const hook = createMarkerHook(document, [synthetic]);
    hook.reconcile(["youtube.comments"]);
    document.getElementById("c")!.setAttribute(synthetic.attribute, "");
    hook.stop();
    expect(marked()).toEqual([]);
    hook.reconcile(["youtube.comments"]);
    expect(marked()).toEqual([]);
  });

  it("adds no listeners or observers", () => {
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const hook = createMarkerHook(document, [synthetic]);
    hook.reconcile(["youtube.comments"]);
    hook.stop();
    expect(add).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("admits only adapters whose exact rule selector a same-feature hide surface carries", () => {
    // The free Shorts chip, then each shipped Still Pro marker (Instagram's search-entry mark).
    expect(admittedMarkers(packaged)).toEqual([SHORTS_CHIP_MARKER, ...INSTAGRAM_EXTRAS.markers]);
    expect(admittedMarkers(packaged, [synthetic])).toEqual([]);
    const withSynthetic = structuredClone(packaged) as SignedRuleSetV2 & { services: { youtube: { surfaces: unknown[] } } };
    withSynthetic.services.youtube.surfaces.push({ id: "synthetic", feature: "youtube.related", action: "hide", selectors: [synthetic.ruleSelector] });
    expect(admittedMarkers(withSynthetic, [synthetic])).toEqual([]); // wrong feature
    withSynthetic.services.youtube.surfaces.push({ id: "synthetic-2", feature: "youtube.comments", action: "hide", selectors: [synthetic.ruleSelector] });
    expect(admittedMarkers(withSynthetic, [synthetic])).toEqual([synthetic]);
    expect(PACKAGED_MARKERS).toEqual([SHORTS_CHIP_MARKER, ...INSTAGRAM_EXTRAS.markers]);
  });
});

describe("the format-2 Shorts chip through the hook", () => {
  const SEARCH = "https://www.youtube.com/results?search_query=example";
  it("committed Off removes the chip marker, On restores it, stop removes it", async () => {
    const h = await createFormat2EntryHost(packaged, "youtube-shorts-filter.html", SEARCH, scripts);
    const script = await h.start();
    const chip = () => document.getElementById("shorts")!.hasAttribute("data-still-shorts-chip");
    expect(chip()).toBe(true);
    await h.authority.commitIntent({ path: "sites.youtube.shorts", value: false, updatedAt: Date.now() });
    expect(chip()).toBe(false);
    await h.authority.commitIntent({ path: "sites.youtube.shorts", value: true, updatedAt: Date.now() });
    expect(chip()).toBe(true);
    script.stop();
    expect(chip()).toBe(false);
  });
});
