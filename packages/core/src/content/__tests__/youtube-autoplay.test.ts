import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import seed from "../../../rules/seed.json";
import { FEATURE_REGISTRY, PAID_TIER_ENABLED, type BenefitAccessSnapshot, type BenefitId, type SettingsV2, type SignedRuleSet } from "@still/shared-types";
import { IMPLEMENTED_PRO_FEATURES, accessCapabilities, accessCapabilitiesForTest, initialAccessSnapshot, packagedAccessContext } from "../../entitlement/access-policy.js";
import { SettingsCache } from "../../storage/cache.js";
import { InMemoryStorageAdapter } from "../../storage/adapter.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../../rules/packaged.js";
import { createEnginePageSession } from "../../rules/engine.js";
import { DEFAULT_SETTINGS_V2 } from "../../rules/__tests__/format2-fixtures.js";
import { extrasFixture } from "../../rules/__tests__/extras-fixtures.js";
import { createContentScript, type ContentScriptHandle } from "../index.js";
import { createYouTubeAutoplayGuard, type YouTubeAutoplayGuard } from "../youtube-autoplay.js";

// YouTube Autoplay prevention (youtube.autoplay): the guard on its own, then through the real
// content script and packaged rule set. Paid-on cases reach it only through the explicit test
// seams; the shipped paid-off defaults must leave it inert.

const WATCH = "https://www.youtube.com/watch?v=inv300001";
const PLAYLIST = "https://www.youtube.com/watch?v=inv300003&list=PLinvented03&index=2";

function render(): void {
  document.body.innerHTML = new DOMParser().parseFromString(extrasFixture("yt-autoplay.html"), "text/html").body.innerHTML;
}
const video = () => document.getElementById("player-video") as HTMLVideoElement;
const overlay = () => document.getElementById("keep-autonav-overlay")!;
const nextLink = () => overlay().querySelector<HTMLAnchorElement>("#keep-autonav-next")!;
const counters = () => {
  const counts = { cancel: 0, toggle: 0 };
  document.getElementById("keep-autonav-cancel")!.addEventListener("click", () => counts.cancel++);
  document.getElementById("keep-autoplay-toggle")!.addEventListener("click", () => counts.toggle++);
  return counts;
};
const end = (target: HTMLMediaElement = video()) => target.dispatchEvent(new Event("ended"));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let pause: ReturnType<typeof vi.spyOn>;
let play: ReturnType<typeof vi.spyOn>;
const guards: YouTubeAutoplayGuard[] = [];
function guard(url = WATCH): YouTubeAutoplayGuard {
  const created = createYouTubeAutoplayGuard(document, new URL(url));
  guards.push(created);
  return created;
}

beforeEach(() => {
  document.head.innerHTML = "";
  render();
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  for (const created of guards.splice(0)) created.stop();
  for (const script of scripts.splice(0)) script.stop();
  vi.restoreAllMocks();
});

describe("the Autoplay guard", () => {
  it("cancels this up-next countdown once when the video ends, and never pauses, plays, toggles or navigates", async () => {
    const counts = counters();
    const g = guard();
    g.reconcile(true, new URL(WATCH));
    end();
    await settle();
    expect(counts.cancel).toBe(1);
    expect(counts.toggle).toBe(0);
    expect(document.getElementById("keep-autoplay-toggle")!.getAttribute("aria-checked")).toBe("true");
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    end();
    await settle();
    expect(counts.cancel, "a second ended event in the same state re-cancels only a NEW countdown").toBe(1);
  });

  it("does nothing while inactive, and Off mid-countdown never clicks or starts playback", async () => {
    const counts = counters();
    const g = guard();
    end();
    g.reconcile(false, new URL(WATCH));
    end();
    await settle();
    expect(counts.cancel).toBe(0);
    // On, the video ends, but the countdown is not shown yet; then the control turns Off.
    overlay().style.display = "none";
    g.reconcile(true, new URL(WATCH));
    end();
    g.reconcile(false, new URL(WATCH));
    overlay().style.display = "";
    await settle();
    expect(counts.cancel).toBe(0);
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it("enforces for the whole ended state: a countdown shown later is cancelled too", async () => {
    const counts = counters();
    overlay().style.display = "none";
    const g = guard();
    g.reconcile(true, new URL(WATCH));
    end();
    await settle();
    expect(counts.cancel).toBe(0);
    overlay().style.display = "";
    await settle();
    expect(counts.cancel).toBe(1);
    // YouTube hides it, then shows a new countdown in the same ended state: cancelled again.
    overlay().style.display = "none";
    await settle();
    overlay().style.display = "";
    await settle();
    expect(counts.cancel).toBe(2);
  });

  it("Replay (the video plays again) ends the ended state; stale and foreign events are ignored", async () => {
    const counts = counters();
    overlay().style.display = "none";
    const g = guard();
    g.reconcile(true, new URL(WATCH));
    end();
    video().dispatchEvent(new Event("play"));
    overlay().style.display = "";
    await settle();
    expect(counts.cancel, "after Replay, a countdown with no new end is left alone").toBe(0);
    // A video outside the main player (an inline preview) ending is never this video's end.
    overlay().style.display = "none";
    document.body.insertAdjacentHTML("beforeend", '<div id="inline-preview"><video id="preview-video"></video></div>');
    end(document.getElementById("preview-video") as HTMLVideoElement);
    overlay().style.display = "";
    await settle();
    expect(counts.cancel).toBe(0);
    // Leaving the page drops the ended state: a countdown on the next page needs its own end.
    overlay().style.display = "none";
    end();
    g.reconcile(true, new URL("https://www.youtube.com/watch?v=inv399999"));
    overlay().style.display = "";
    await settle();
    expect(counts.cancel).toBe(0);
  });

  it("a deliberately started playlist continues to its next item; a recommendation after it ends is cancelled", async () => {
    const counts = counters();
    const g = guard(PLAYLIST); // a full page load is the person's own choice
    g.reconcile(true, new URL(PLAYLIST));
    nextLink().href = "/watch?v=inv300004&list=PLinvented03&index=3";
    end();
    await settle();
    expect(counts.cancel, "next playlist item continues").toBe(0);
    // The playlist's last item: the up-next is a recommendation outside it.
    video().dispatchEvent(new Event("play"));
    nextLink().href = "/watch?v=inv300099";
    end();
    await settle();
    expect(counts.cancel, "a recommendation taking over after the playlist is cancelled").toBe(1);
  });

  it("a list id the page added on its own is not a choice; one the person opened is", async () => {
    const counts = counters();
    const g = guard();
    g.reconcile(true, new URL(WATCH));
    // The page moved itself into an automatic Mix: same list in the up-next, but never chosen.
    const mix = new URL("https://www.youtube.com/watch?v=inv300010&list=RDinvented10");
    g.navigated(mix, "page");
    g.reconcile(true, mix);
    nextLink().href = "/watch?v=inv300011&list=RDinvented10";
    end();
    await settle();
    expect(counts.cancel).toBe(1);
    // The person opens that Mix deliberately (a link they activated): it continues.
    const chosen = new URL("https://www.youtube.com/watch?v=inv300012&list=RDinvented10");
    g.navigated(chosen, "deliberate");
    g.reconcile(true, chosen);
    end();
    await settle();
    expect(counts.cancel).toBe(1);
    // A deliberate move to an ordinary video ends the chosen playlist.
    const single = new URL("https://www.youtube.com/watch?v=inv300013");
    g.navigated(single, "deliberate");
    g.reconcile(true, single);
    end();
    await settle();
    expect(counts.cancel).toBe(2);
  });

  it("stop removes every listener and observer", async () => {
    const counts = counters();
    overlay().style.display = "none";
    const g = guard();
    g.reconcile(true, new URL(WATCH));
    end();
    g.stop();
    overlay().style.display = "";
    end();
    await settle();
    expect(counts.cancel).toBe(0);
  });
});

const scripts: ContentScriptHandle[] = [];
const ALL_ON: SettingsV2 = { ...DEFAULT_SETTINGS_V2, sites: { ...DEFAULT_SETTINGS_V2.sites, "youtube.autoplay": true } };
function paidOn(): { access: BenefitAccessSnapshot; capabilities: ReadonlySet<BenefitId> } {
  const capabilities = accessCapabilitiesForTest({ paidMode: true, host: "chromium" }, IMPLEMENTED_PRO_FEATURES);
  const base = initialAccessSnapshot({ paidMode: true, supported: capabilities });
  const pro = FEATURE_REGISTRY.filter((feature) => feature.tier === "pro").map((feature) => [feature.id, "purchased"]);
  return { access: { ...base, states: { ...base.states, ...Object.fromEntries(pro) } }, capabilities };
}
/** Exactly what the shipped Chromium build wires: its host's packaged capabilities and access. */
function shippedChromium(): { access: BenefitAccessSnapshot; capabilities: ReadonlySet<BenefitId> } {
  return { access: initialAccessSnapshot(packagedAccessContext("chromium")),
    capabilities: accessCapabilities({ paidMode: PAID_TIER_ENABLED, host: "chromium" }) };
}
async function contentScript(settings: SettingsV2, paid: boolean) {
  const cache = new SettingsCache(new InMemoryStorageAdapter(null), { initial: settings as never });
  const seam = paid ? paidOn() : shippedChromium();
  const entitlement = {
    currentAccessSnapshot: () => seam.access, current: () => paid, hydrate: () => Promise.resolve(),
    refreshAccess: () => Promise.resolve(seam.access), watch: () => () => {}, subscribeAccess: () => () => {}, subscribe: () => () => {},
  };
  const win = { location: { href: WATCH, replace: vi.fn(), assign: vi.fn() }, history: { pushState: vi.fn(), replaceState: vi.fn() },
    addEventListener: vi.fn(), removeEventListener: vi.fn(), MutationObserver: window.MutationObserver, requestAnimationFrame: vi.fn() };
  const script = createContentScript({ win, doc: document, ruleSet: seed as unknown as SignedRuleSet,
    ruleSetV2: admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!, cache, entitlement: entitlement as never, capabilities: seam.capabilities });
  scripts.push(script);
  await script.start();
  return { script, cache, win };
}

describe("Autoplay through the real content script and packaged rules", () => {
  it("the engine reports youtube.autoplay effective only with paid on, and it adds no CSS or class", () => {
    const packaged = admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!;
    const shipped = createEnginePageSession(packaged);
    shipped.applyDom(ALL_ON, new URL(WATCH), document, shippedChromium());
    expect(shipped.effectiveFeatures!()).not.toContain("youtube.autoplay");
    shipped.stop!();
    const on = createEnginePageSession(packaged);
    on.applyDom(ALL_ON, new URL(WATCH), document, paidOn());
    expect(on.effectiveFeatures!()).toContain("youtube.autoplay");
    expect(document.documentElement.className).not.toMatch(/youtube-autoplay/);
    expect([...document.querySelectorAll("style")].map((style) => style.textContent).join("\n")).not.toMatch(/autoplay|autonav/);
    expect(on.evaluate(ALL_ON, new URL(WATCH), paidOn())).toEqual({ kind: "apply" });
    on.stop!();
  });

  it("dormant with the shipped Chromium wiring (paid off): a saved On never cancels anything", async () => {
    const counts = counters();
    const { win } = await contentScript(ALL_ON, false);
    end();
    await settle();
    expect(counts.cancel).toBe(0);
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  it("paid on: cancels the countdown without pausing, playing or navigating", async () => {
    const counts = counters();
    const { win } = await contentScript(ALL_ON, true);
    end();
    await settle();
    expect(counts.cancel).toBe(1);
    expect(counts.toggle).toBe(0);
    expect(win.location.replace).not.toHaveBeenCalled();
    expect(win.location.assign).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it("paid on with the control saved Off: nothing is cancelled", async () => {
    const counts = counters();
    await contentScript({ ...ALL_ON, sites: { ...ALL_ON.sites, "youtube.autoplay": false } }, true);
    end();
    await settle();
    expect(counts.cancel).toBe(0);
  });

  it("paid on, stopping the content script detaches the guard", async () => {
    const counts = counters();
    const { script } = await contentScript(ALL_ON, true);
    script.stop();
    end();
    await settle();
    expect(counts.cancel).toBe(0);
  });
});
