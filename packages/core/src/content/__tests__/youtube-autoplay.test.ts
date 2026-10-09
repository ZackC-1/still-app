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
import { createNavigationIntentTracker } from "../redirect.js";

// YouTube Autoplay prevention (youtube.autoplay): the guard on its own, then through the real
// content script and packaged rule set. Paid-on cases reach it only through the explicit test
// seams; the shipped paid-off defaults must leave it inert.

const WATCH = "https://www.youtube.com/watch?v=inv300001";
const PLAYLIST = "https://www.youtube.com/watch?v=inv300003&list=PLinvented03&index=2";

function render(file = "yt-autoplay.html"): void {
  document.body.innerHTML = new DOMParser().parseFromString(extrasFixture(file), "text/html").body.innerHTML;
}
const video = () => document.getElementById("player-video") as HTMLVideoElement;
const overlay = () => document.getElementById("keep-autonav-overlay")!;
const nextLink = () => overlay().querySelector<HTMLAnchorElement>("#keep-autonav-next")!;
const counters = () => {
  const counts = { cancel: 0, toggle: 0 };
  document.getElementById("keep-autonav-cancel")!.addEventListener("click", () => counts.cancel++);
  document.getElementById("keep-autoplay-toggle")!.addEventListener("click", () => counts.toggle++);
  // Controls Still must never press: Play now and the phone card's top dismiss (when present).
  for (const id of ["keep-autonav-play", "keep-autonav-dismiss"]) document.getElementById(id)?.addEventListener("click", (event) => {
    event.preventDefault();
    throw new Error(`${id} must never be pressed`);
  });
  return counts;
};
/** YouTube's own toggle state as the fixture renders it (desktop aria-checked, phone aria-label). */
const toggleState = () => {
  const toggle = document.getElementById("keep-autoplay-toggle")!;
  return toggle.getAttribute("aria-checked") ?? toggle.getAttribute("aria-label");
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

describe.each([
  { name: "desktop", origin: "https://www.youtube.com", file: "yt-autoplay.html" },
  { name: "mobile observed countdown", origin: "https://m.youtube.com", file: "yt-m-autoplay.html" },
])("the Autoplay guard: $name", ({ origin, file }) => {
  const WATCH = `${origin}/watch?v=inv300001`;
  const PLAYLIST = `${origin}/watch?v=inv300003&list=PLinvented03&index=2`;
  beforeEach(() => render(file));
  it("cancels this up-next countdown once when the video ends, and never pauses, plays, toggles or navigates", async () => {
    const counts = counters();
    const toggle = toggleState();
    expect(toggle).toMatch(/^(true|Autoplay is on)$/);
    const g = guard(WATCH);
    g.reconcile(true, new URL(WATCH));
    end();
    await settle();
    expect(counts.cancel).toBe(1);
    expect(counts.toggle).toBe(0);
    expect(toggleState()).toBe(toggle);
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    end();
    await settle();
    expect(counts.cancel, "a second ended event in the same state re-cancels only a NEW countdown").toBe(1);
  });

  it("does nothing while inactive, and Off mid-countdown never clicks or starts playback", async () => {
    const counts = counters();
    const g = guard(WATCH);
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
    const g = guard(WATCH);
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
    const g = guard(WATCH);
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
    g.reconcile(true, new URL(`${origin}/watch?v=inv399999`));
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
    const g = guard(WATCH);
    g.reconcile(true, new URL(WATCH));
    // The page moved itself into an automatic Mix: same list in the up-next, but never chosen.
    const mix = new URL(`${origin}/watch?v=inv300010&list=RDinvented10`);
    g.navigated(mix, "page");
    g.reconcile(true, mix);
    nextLink().href = "/watch?v=inv300011&list=RDinvented10";
    end();
    await settle();
    expect(counts.cancel).toBe(1);
    // The person opens that Mix deliberately (a link they activated): it continues.
    const chosen = new URL(`${origin}/watch?v=inv300012&list=RDinvented10`);
    g.navigated(chosen, "deliberate");
    g.reconcile(true, chosen);
    end();
    await settle();
    expect(counts.cancel).toBe(1);
    // A deliberate move to an ordinary video ends the chosen playlist.
    const single = new URL(`${origin}/watch?v=inv300013`);
    g.navigated(single, "deliberate");
    g.reconcile(true, single);
    end();
    await settle();
    expect(counts.cancel).toBe(2);
  });

  it("a deliberate click that stays on the current video (a timestamp or chapter) keeps the chosen playlist", async () => {
    const counts = counters();
    const g = guard(PLAYLIST);
    g.reconcile(true, new URL(PLAYLIST));
    for (const link of [
      `${origin}/watch?v=inv300003&t=90s`,
      `${origin}/watch?v=inv300003&t=1m30s&index=2`,
    ]) g.navigated(new URL(link), "deliberate");
    nextLink().href = "/watch?v=inv300004&list=PLinvented03&index=3";
    end();
    await settle();
    expect(counts.cancel, "the next item of the chosen playlist continues").toBe(0);
    // A deliberate click on a DIFFERENT video with no list still ends the chosen playlist.
    const other = new URL(`${origin}/watch?v=inv300030`);
    g.navigated(other, "deliberate");
    g.reconcile(true, other);
    nextLink().href = "/watch?v=inv300004&list=PLinvented03&index=3";
    end();
    await settle();
    expect(counts.cancel).toBe(1);
  });

  it("through the intent tracker: a page move into an automatic Mix right after a click is not the person's choice", async () => {
    let now = 1_000;
    const tracker = createNavigationIntentTracker(() => now);
    // The person clicks an ordinary video; within the deliberate window the page itself moves
    // into an automatic Mix on /watch. Only the clicked video (v and list) is deliberate.
    tracker.recordLink(new URL(`${origin}/watch?v=inv300040`));
    now += 1_000;
    const mix = new URL(`${origin}/watch?v=inv300041&list=RDinvented41`);
    expect(tracker.intentFor(mix)).toBe("page");
    expect(tracker.intentFor(new URL(`${origin}/watch?v=inv300040&pp=invented`)), "the clicked video, with tracking extras").toBe("deliberate");
    expect(tracker.intentFor(new URL(`${origin}/watch?v=inv300040&list=RDinvented41`)), "same video, a list the page added").toBe("page");
    // Another site's routes keep the path-only rule.
    tracker.recordLink(new URL("https://www.instagram.com/reel/inv1/"));
    expect(tracker.intentFor(new URL("https://www.instagram.com/reel/inv1/?igsh=x"))).toBe("deliberate");
    const counts = counters();
    const g = guard(WATCH);
    g.reconcile(true, new URL(WATCH));
    g.navigated(mix, tracker.intentFor(mix));
    g.reconcile(true, mix);
    nextLink().href = "/watch?v=inv300042&list=RDinvented41";
    end();
    await settle();
    expect(counts.cancel, "the automatic Mix is not continued").toBe(1);
  });

  it("clicks only a real Cancel button: never a non-button, anything inside a link, or the Play button", async () => {
    const mobile = file === "yt-m-autoplay.html";
    // Each variant replaces the real Cancel. On the phone card the Cancel is the action row's only
    // button; a second button there could be Play now redrawn, so the whole row is ambiguous.
    const variants: Array<[string, string]> = mobile ? [
      ["a non-button in the action row", '<div role="button" id="probe">Cancel</div>'],
      ["a Cancel button inside a link", '<a href="/watch?v=inv300002"><button id="probe">Cancel</button></a>'],
      ["a second button in the action row", '<button id="probe">Cancel</button></ytm-button-renderer><ytm-button-renderer><button id="probe-second">Play now</button>'],
    ] : [
      ["a non-button with the Cancel class", '<div class="ytp-autonav-endscreen-upnext-cancel-button" id="probe">Cancel</div>'],
      ["a Cancel button inside a link", '<a href="/watch?v=inv300002"><button class="ytp-autonav-endscreen-upnext-cancel-button" id="probe">Cancel</button></a>'],
      ["the Play button wearing the Cancel class", '<button class="ytp-autonav-endscreen-upnext-cancel-button ytp-autonav-endscreen-upnext-play-button" id="probe">Play</button>'],
    ];
    for (const [name, markup] of variants) {
      render(file);
      const cancel = document.getElementById("keep-autonav-cancel")!;
      if (mobile) cancel.outerHTML = markup;
      else { cancel.remove(); overlay().insertAdjacentHTML("afterbegin", markup); }
      let clicks = 0;
      for (const id of ["probe", "probe-second"]) document.getElementById(id)?.addEventListener("click", (event) => { clicks++; event.preventDefault(); });
      const g = guard(WATCH);
      g.reconcile(true, new URL(WATCH));
      end();
      await settle();
      expect(clicks, name).toBe(0);
      g.stop();
    }
  });

  it("presses Cancel at most twice in one ended state, however often the countdown comes back", async () => {
    const counts = counters();
    const g = guard(WATCH);
    g.reconcile(true, new URL(WATCH));
    end();
    await settle();
    for (let cycle = 0; cycle < 4; cycle++) {
      overlay().style.display = "none";
      await settle();
      overlay().style.display = "";
      await settle();
    }
    expect(counts.cancel).toBe(2);
    // A new ended state (after the video played again) gets its own two.
    video().dispatchEvent(new Event("play"));
    end();
    await settle();
    expect(counts.cancel).toBe(3);
  });

  it("stop removes every listener and observer", async () => {
    const counts = counters();
    overlay().style.display = "none";
    const g = guard(WATCH);
    g.reconcile(true, new URL(WATCH));
    end();
    g.stop();
    overlay().style.display = "";
    end();
    await settle();
    expect(counts.cancel).toBe(0);
  });
});

describe("the Autoplay guard: phone-layout boundaries", () => {
  const MOBILE_WATCH = "https://m.youtube.com/watch?v=inv300001";
  beforeEach(() => render("yt-m-autoplay.html"));

  it("an up-next card without its countdown timer is not autoplay and is left alone", async () => {
    const counts = counters();
    document.getElementById("player-endscreen")!.setAttribute("data-has-timer-countdown", "false");
    const g = guard(MOBILE_WATCH);
    g.reconcile(true, new URL(MOBILE_WATCH));
    end();
    await settle();
    expect(counts.cancel).toBe(0);
    // The timer starting later in the same ended state is a countdown: cancelled then.
    document.getElementById("player-endscreen")!.setAttribute("data-has-timer-countdown", "true");
    await settle();
    expect(counts.cancel).toBe(1);
  });

  it("a countdown outside this player's own container is never this player's", async () => {
    const counts = counters();
    // Move the main player out of the container that holds the countdown: the countdown now
    // belongs to some other player, and this player's end must not press it.
    const container = document.getElementById("player-container-id")!;
    container.parentElement!.insertAdjacentHTML("beforeend", '<div id="other-wrapper"></div>');
    document.getElementById("other-wrapper")!.append(document.getElementById("player")!);
    const g = guard(MOBILE_WATCH);
    g.reconcile(true, new URL(MOBILE_WATCH));
    end();
    await settle();
    expect(counts.cancel).toBe(0);
  });

  it("Replay stays available: after Cancel nothing presses Replay, the toggle or Play now", async () => {
    const counts = counters();
    let replays = 0;
    document.getElementById("keep-replay")!.addEventListener("click", () => replays++);
    const g = guard(MOBILE_WATCH);
    g.reconcile(true, new URL(MOBILE_WATCH));
    end();
    await settle();
    // YouTube removes the cancelled card; the person replays the video, which ends again.
    document.getElementById("keep-autonav-overlay")!.remove();
    await settle();
    expect(counts.cancel).toBe(1);
    expect(replays).toBe(0);
    video().dispatchEvent(new Event("play"));
    end();
    await settle();
    expect(counts).toEqual({ cancel: 1, toggle: 0 });
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
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
async function contentScript(settings: SettingsV2, paid: boolean, href = WATCH) {
  const cache = new SettingsCache(new InMemoryStorageAdapter(null), { initial: settings as never });
  const seam = paid ? paidOn() : shippedChromium();
  let access = seam.access;
  let accessChanged: (() => void) | undefined;
  const entitlement = {
    currentAccessSnapshot: () => access, current: () => paid, hydrate: () => Promise.resolve(),
    refreshAccess: () => Promise.resolve(access), watch: () => () => {},
    subscribeAccess: (listener: () => void) => { accessChanged = listener; return () => { accessChanged = undefined; }; },
    subscribe: () => () => {},
  };
  const win = { location: { href, replace: vi.fn(), assign: vi.fn() }, history: { pushState: vi.fn(), replaceState: vi.fn() },
    addEventListener: vi.fn(), removeEventListener: vi.fn(), MutationObserver: window.MutationObserver, requestAnimationFrame: vi.fn() };
  const script = createContentScript({ win, doc: document, ruleSet: seed as unknown as SignedRuleSet,
    ruleSetV2: admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!, cache, entitlement: entitlement as never, capabilities: seam.capabilities });
  scripts.push(script);
  await script.start();
  return { script, cache, win, updateAccess: (next: BenefitAccessSnapshot) => { access = next; accessChanged?.(); } };
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

  it("paid on: Back/forward onto a playlist (a history move, with no cancelable navigate event) counts as the person's choice", async () => {
    const counts = counters();
    const { win } = await contentScript(ALL_ON, true);
    // The person goes Back to a playlist page. Firefox ESR (no Navigation API) and Chromium's
    // non-cancelable traversals report it only as popstate after the address changed.
    win.location.href = PLAYLIST;
    const popstate = win.addEventListener.mock.calls.filter(([type]) => type === "popstate").map(([, listener]) => listener as () => void);
    expect(popstate.length).toBeGreaterThan(0);
    for (const listener of popstate) listener();
    nextLink().href = "/watch?v=inv300004&list=PLinvented03&index=3";
    end();
    await settle();
    expect(counts.cancel, "the playlist reached by Back continues").toBe(0);
    // Its end: a recommendation after the playlist is still cancelled.
    video().dispatchEvent(new Event("play"));
    nextLink().href = "/watch?v=inv300099";
    end();
    await settle();
    expect(counts.cancel).toBe(1);
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

  it("mobile: Pro loss through the real content subscription drops a waiting countdown and keeps playback untouched", async () => {
    render("yt-m-autoplay.html");
    const counts = counters();
    overlay().style.display = "none";
    const { updateAccess, win } = await contentScript(ALL_ON, true, "https://m.youtube.com/watch?v=inv300001");
    end();
    const purchased = paidOn().access;
    updateAccess({ ...purchased, states: { ...purchased.states, "youtube.autoplay": "locked" } });
    await settle();
    overlay().style.display = "";
    end();
    await settle();
    expect(counts).toEqual({ cancel: 0, toggle: 0 });
    expect(win.location.replace).not.toHaveBeenCalled();
    expect(win.location.assign).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    // A valid new access projection restores the handler without restarting the document.
    updateAccess(purchased);
    await settle();
    end();
    await settle();
    expect(counts.cancel).toBe(1);
  });
});
