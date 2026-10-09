import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignedRuleSetV2 } from "@still/shared-types";
import type { MarkerAdapter } from "../../rules/extras.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../../rules/packaged.js";
import { PACKAGED_MARKERS, SHORTS_CHIP_MARKER, admittedMarkers, createMarkerHook } from "../markers.js";
import { INSTAGRAM_EXTRAS } from "../../rules/instagram-extras.js";
import { YOUTUBE_EXTRAS } from "../../rules/youtube-extras.js";
import type { MarkerHook } from "../markers.js";
import type { ContentScriptHandle } from "../index.js";
import { createFormat2EntryHost } from "./format2-entry-host.js";

// The marker hook: data-still-* attributes exist only while their feature is effective, and Off,
// another service or teardown removes them. Only unsupported structural fallbacks observe DOM.

const packaged = admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!;
const synthetic: MarkerAdapter = {
  feature: "youtube.comments", attribute: "data-still-synthetic-comments", candidates: ".candidate",
  ruleSelector: "[data-still-synthetic-comments]", owns: (element) => element.classList.contains("owned"),
};
const scripts: ContentScriptHandle[] = [];
const hooks: MarkerHook[] = [];

beforeEach(() => {
  document.body.innerHTML = '<div class="candidate owned" id="a"></div><div class="candidate" id="b"></div><div class="other owned" id="c"></div>';
});
afterEach(() => {
  for (const script of scripts.splice(0)) script.stop();
  for (const hook of hooks.splice(0)) hook.stop();
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
    expect(admittedMarkers(packaged)).toEqual([SHORTS_CHIP_MARKER, ...YOUTUBE_EXTRAS.markers, ...INSTAGRAM_EXTRAS.markers]);
    expect(admittedMarkers(packaged, [synthetic])).toEqual([]);
    const withSynthetic = structuredClone(packaged) as SignedRuleSetV2 & { services: { youtube: { surfaces: unknown[] } } };
    withSynthetic.services.youtube.surfaces.push({ id: "synthetic", feature: "youtube.related", action: "hide", selectors: [synthetic.ruleSelector] });
    expect(admittedMarkers(withSynthetic, [synthetic])).toEqual([]); // wrong feature
    withSynthetic.services.youtube.surfaces.push({ id: "synthetic-2", feature: "youtube.comments", action: "hide", selectors: [synthetic.ruleSelector] });
    expect(admittedMarkers(withSynthetic, [synthetic])).toEqual([synthetic]);
    expect(PACKAGED_MARKERS).toEqual([SHORTS_CHIP_MARKER, ...YOUTUBE_EXTRAS.markers, ...INSTAGRAM_EXTRAS.markers]);
  });
});

describe("structural comments fallback", () => {
  const adapter = YOUTUBE_EXTRAS.markers[0]!;
  const markup = '<ytm-engagement-panel id="panel"><ytm-engagement-panel-section-list-renderer class="engagement-panel-comments-section"></ytm-engagement-panel-section-list-renderer></ytm-engagement-panel>';
  const delivery = async () => { await Promise.resolve(); await Promise.resolve(); };
  const start = (owned: MarkerAdapter = adapter) => {
    const hook = createMarkerHook(document, [owned]); hooks.push(hook); return hook;
  };
  it.each(["supports", "query"])("omits the fallback when the primary selector is supported via %s", (lane) => {
    vi.stubGlobal("CSS", lane === "supports" ? { supports: vi.fn(() => true) } : undefined);
    document.body.innerHTML = markup;
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    start().reconcile(["youtube.comments"]);
    expect(document.querySelector(`[${adapter.attribute}]`)).toBeNull();
    expect(observe).not.toHaveBeenCalled();
  });
  it("owns only a panel with one element child that is the comments section", () => {
    document.body.innerHTML = markup;
    const panel = document.getElementById("panel")!;
    expect(adapter.owns(panel)).toBe(true);
    panel.appendChild(document.createTextNode(" "));
    expect(adapter.owns(panel)).toBe(true);
    panel.appendChild(document.createElement("button"));
    expect(adapter.owns(panel)).toBe(false);
    expect(adapter.owns(panel.firstElementChild!)).toBe(false);
    panel.lastElementChild!.remove();
    panel.firstElementChild!.className = "engagement-panel-other-section";
    expect(adapter.owns(panel)).toBe(false);
  });
  it("uses querySelector syntax detection when CSS.supports is absent", () => {
    vi.stubGlobal("CSS", undefined);
    document.body.innerHTML = markup;
    const query = document.querySelector.bind(document);
    vi.spyOn(document, "querySelector").mockImplementation(selector => {
      if (selector === adapter.structuralFallback) throw new DOMException("Unsupported selector", "SyntaxError");
      return query(selector);
    });
    const hook = start();
    hook.reconcile(["youtube.comments"]);
    expect(document.getElementById("panel")!.hasAttribute(adapter.attribute)).toBe(true);
  });
  it("observes only while admitted and effective; refreshes affected panels without marker-write loops", async () => {
    vi.stubGlobal("CSS", { supports: () => false });
    document.body.innerHTML = markup + '<div id="ordinary"></div>';
    const owns = vi.fn(adapter.owns);
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const hook = start({ ...adapter, owns });
    hook.reconcile(["youtube.shorts"]);
    expect(observe).not.toHaveBeenCalled();
    hook.reconcile(["youtube.comments"]);
    expect(observe).toHaveBeenCalledExactlyOnceWith(document,
      { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    const panel = document.getElementById("panel")!;
    expect(panel.hasAttribute(adapter.attribute)).toBe(true);
    await delivery();
    expect(owns).toHaveBeenCalledTimes(1); // our marker write did not schedule a second pass
    document.getElementById("ordinary")!.className = "unrelated";
    document.getElementById("ordinary")!.innerHTML = "<button>Chosen action</button>";
    await delivery();
    expect(owns).toHaveBeenCalledTimes(1);
    panel.firstElementChild!.className = "engagement-panel-other-section";
    await delivery();
    expect(panel.hasAttribute(adapter.attribute)).toBe(false);
    panel.firstElementChild!.className = "engagement-panel-comments-section";
    await delivery();
    expect(panel.hasAttribute(adapter.attribute)).toBe(true);
    const container = document.createElement("div");
    container.innerHTML = markup.replace('id="panel"', 'id="late"');
    document.body.appendChild(container);
    await delivery();
    const late = container.firstElementChild!;
    expect(late.hasAttribute(adapter.attribute)).toBe(true);
    container.remove();
    await delivery();
    expect(late.hasAttribute(adapter.attribute)).toBe(false);
    hook.reconcile(["instagram.reels"]); // another service has no effective YouTube comments
    expect(panel.hasAttribute(adapter.attribute)).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
    owns.mockClear();
    panel.firstElementChild!.className = "engagement-panel-comments-section";
    await delivery();
    expect(owns).not.toHaveBeenCalled();
    hook.reconcile(["youtube.comments"]);
    expect(panel.hasAttribute(adapter.attribute)).toBe(true);
    panel.remove(); // Stop before observer delivery must also clear a detached panel.
    hook.stop();
    expect(panel.hasAttribute(adapter.attribute)).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(2);
    owns.mockClear();
    document.body.innerHTML = markup;
    await delivery();
    hook.reconcile(["youtube.comments"]);
    expect(owns).not.toHaveBeenCalled();
    expect(document.querySelector(`[${adapter.attribute}]`)).toBeNull();
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
