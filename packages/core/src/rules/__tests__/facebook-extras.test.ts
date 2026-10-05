import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FEATURE_REGISTRY, type BenefitAccessSnapshot, type BenefitId, type FeatureId, type SettingsV2 } from "@still/shared-types";
import {
  ACCESS_BENEFITS,
  IMPLEMENTED_PRO_FEATURES,
  accessCapabilitiesForTest,
  initialAccessSnapshot,
  type AccessHost,
} from "../../entitlement/access-policy.js";
import { createEnginePageSession, type EnginePageSession } from "../engine.js";
import { FACEBOOK_EXTRAS } from "../facebook-extras.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../packaged.js";
import { DEFAULT_SETTINGS_V2 } from "./format2-fixtures.js";
import { extrasFixture } from "./extras-fixtures.js";

// P5: Facebook's three Still Pro extras (Stories, Videos and Watch, Desktop sidebar ads) on the
// REAL packaged rule set. Paid-on cases reach the extras only through the explicit test seams
// (a purchased access snapshot plus accessCapabilitiesForTest over the shipped per-host table);
// the shipped paid-off defaults must leave every one of them inert.

const packaged = admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!;
const FB = "https://www.facebook.com";
const FB_PRO: readonly FeatureId[] = ["facebook.stories", "facebook.videos", "facebook.sponsored"];

const settingsWith = (sites: Partial<Record<FeatureId, boolean>>): SettingsV2 => ({
  ...DEFAULT_SETTINGS_V2,
  sites: { ...DEFAULT_SETTINGS_V2.sites, ...sites },
});
/** Every Facebook control On, free Reels included. */
const ALL_ON = settingsWith({ "facebook.reels": true, "facebook.stories": true, "facebook.videos": true, "facebook.sponsored": true });

/** Paid on through the test seams, with the host's real implementation table. */
function paidOn(host?: AccessHost): { access: BenefitAccessSnapshot; capabilities: ReadonlySet<BenefitId> } {
  const base = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  const pro = FEATURE_REGISTRY.filter((feature) => feature.tier === "pro").map((feature) => [feature.id, "purchased"]);
  return {
    access: { ...base, states: { ...base.states, ...Object.fromEntries(pro) } },
    capabilities: accessCapabilitiesForTest({ paidMode: true, host }, IMPLEMENTED_PRO_FEATURES),
  };
}
const ON = paidOn("chromium");

const sessions: EnginePageSession[] = [];
function session(): EnginePageSession {
  const created = createEnginePageSession(packaged);
  sessions.push(created);
  return created;
}
const visible = (id: string): boolean => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`fixture lost #${id}`);
  for (let at: Element | null = node; at; at = at.parentElement) if (getComputedStyle(at).display === "none") return false;
  return true;
};
function render(file: string): void {
  document.body.innerHTML = new DOMParser().parseFromString(extrasFixture(file), "text/html").body.innerHTML;
}
const ids = (prefix: string) => [...document.querySelectorAll(`[id^="${prefix}"]`)].map((node) => node.id);

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "site-theme";
});
afterEach(() => {
  for (const created of sessions.splice(0)) created.stop?.();
});

describe("Facebook extras routes (paid on through the test seams)", () => {
  const evaluate = (path: string, settings: SettingsV2 = ALL_ON, opts = ON) => session().evaluate(settings, new URL(path, FB), opts);
  const home = { kind: "redirect", url: `${FB}/` };
  const stays = { kind: "apply" };

  it.each([
    "/stories", "/stories/", "/stories/900000000001/", "/stories/900000000001/UzpfSW52ZW50ZWQ/?view_single=1",
  ])("Stories: %s goes silently to Home", (path) => {
    expect(evaluate(path)).toEqual(home);
  });

  it.each(["/storiesx", "/inventedpage/stories/", "/inventedpage/", "/messages/t/900000000004/"])(
    "Stories: %s is not a Story route", (path) => {
      expect(evaluate(path)).toEqual(stays);
    });

  it.each(["/watch", "/watch/", "/watch/?ref=bookmarks", "/watch/?v=", "/watch/#top"])(
    "Videos and Watch: the Watch hub %s goes silently to Home", (path) => {
      expect(evaluate(path)).toEqual(home);
    });

  it.each([
    "/watch/?v=900000000105",
    "/watch?v=900000000105",
    "/watch/?v=900000000105&t=30",
    "/inventedpage/videos/900000000106",
    "/inventedpage/videos/900000000106/",
    "/videos/900000000107",
    "/videos/900000000107/",
    "/watch/900000000108", // Q10 open: /watch/<number> is left alone
  ])("Videos and Watch: the direct player %s stays playable", (path) => {
    expect(evaluate(path)).toEqual(stays);
  });

  it("each route needs its own feature effective: saved Off or paid off never routes", () => {
    expect(evaluate("/stories/1/", settingsWith({ "facebook.reels": true, "facebook.videos": true }))).toEqual(stays);
    expect(evaluate("/watch/", settingsWith({ "facebook.reels": true, "facebook.stories": true }))).toEqual(stays);
    // Shipped defaults: paid off, every Pro feature unsupported.
    const shipped = session();
    for (const path of ["/stories/", "/stories/1/", "/watch", "/watch/", "/watch/?ref=x"])
      expect(shipped.evaluate(ALL_ON, new URL(path, FB)), path).toEqual(stays);
  });

  it("redirects are loop-free: Home is never routed again", () => {
    expect(evaluate("/")).toEqual(stays);
    expect(evaluate("/?ref=stories")).toEqual(stays);
  });

  it("redirects are silent: no Still element, notice or sub-line is added on the way", () => {
    const engine = session();
    engine.applyDom(ALL_ON, new URL("/stories/1/", FB), document, ON);
    engine.applyDom(ALL_ON, new URL("/watch/", FB), document, ON);
    expect(document.querySelectorAll("[id^='still-'], [class*='still-placeholder']")).toHaveLength(0);
    expect(document.body.textContent).toBe("");
  });

  it("routes stay on Facebook and the same host", () => {
    expect(evaluate("https://m.facebook.com/stories/1/")).toEqual({ kind: "redirect", url: "https://m.facebook.com/" });
    expect(evaluate("https://web.facebook.com/watch/")).toEqual({ kind: "redirect", url: "https://web.facebook.com/" });
    // Another service's /stories or /watch is never a Facebook route.
    expect(session().evaluate(ALL_ON, new URL("https://www.instagram.com/watch/"), ON).kind).not.toBe("redirect");
  });
});

describe("Videos and Watch: the live hub (owner question Q10, its own droppable entry)", () => {
  const evaluate = (path: string, settings: SettingsV2 = ALL_ON) => session().evaluate(settings, new URL(path, FB), ON);

  it.each(["/watch/live", "/watch/live/", "/watch/live/?ref=bookmarks"])("%s goes silently to Home", (path) => {
    expect(evaluate(path)).toEqual({ kind: "redirect", url: `${FB}/` });
  });

  it.each(["/watch/live/?v=900000000112", "/watch/live/900000000112", "/inventedpage/videos/900000000112"])(
    "the direct live link %s stays playable", (path) => {
      expect(evaluate(path)).toEqual({ kind: "apply" });
    });

  it("needs Videos and Watch effective", () => {
    expect(evaluate("/watch/live/", settingsWith({ "facebook.reels": true, "facebook.stories": true }))).toEqual({ kind: "apply" });
    expect(session().evaluate(ALL_ON, new URL("/watch/live/", FB))).toEqual({ kind: "apply" });
  });
});

describe("free Facebook Reels are never shadowed", () => {
  const REEL_PATHS = [
    "/reel/", "/reel/900000000103", "/reel/900000000103/", "/reel/900000000103/?s=1",
    "/reels/", "/reels", "/watch/reels", "/watch/reels/", "/watch/reels/?v=1", "/inventedpage/reels_tab",
  ];

  it.each(REEL_PATHS)("no Facebook extras route predicate ever matches %s", (path) => {
    for (const route of FACEBOOK_EXTRAS.routes) expect(route.matches(new URL(path, FB)), `${route.feature} ${path}`).toBe(false);
  });

  it("the core's Reels routes and the #278 /watch/reels redirect still win with every extra On", () => {
    for (const path of ["/reels/", "/watch/reels/", "/watch/reels"])
      expect(session().evaluate(ALL_ON, new URL(path, FB), ON), path).toEqual({ kind: "redirect", url: `${FB}/` });
    // A shared Reel opens: neither the core nor any extra redirects it.
    expect(session().evaluate(ALL_ON, new URL("/reel/900000000103", FB), ON)).toEqual({ kind: "apply" });
  });

  it("the Reel continuation guard follows Reels alone, never Videos and Watch (D244)", () => {
    const from = new URL("/reel/1", FB);
    const to = new URL("/reel/2", FB);
    const reelsOn = session();
    reelsOn.evaluate(ALL_ON, to, ON);
    expect(reelsOn.reelContinuation!(from, to)).toBe(`${FB}/`);
    const videosOnly = session();
    videosOnly.evaluate({ ...ALL_ON, sites: { ...ALL_ON.sites, "facebook.reels": false } }, to, ON);
    expect(videosOnly.reelContinuation!(from, to)).toBeNull();
  });
});

describe("Facebook Stories tray (fb-stories.html)", () => {
  it("hides only the story cards, keeping the wrapper, People you may know, posts and messages", () => {
    render("fb-stories.html");
    const engine = session();
    engine.applyDom(ALL_ON, new URL(`${FB}/`), document, ON);
    expect(ids("target-").length).toBeGreaterThan(0);
    for (const id of ids("target-")) expect(visible(id), id).toBe(false);
    for (const id of ids("keep-")) expect(visible(id), id).toBe(true);
    // Hidden, never removed; Off restores without touching the page.
    const before = document.body.innerHTML;
    engine.applyDom(settingsWith({ "facebook.reels": true }), new URL(`${FB}/`), document, ON);
    for (const id of ids("target-")) expect(visible(id), id).toBe(true);
    expect(document.body.innerHTML).toBe(before);
  });

  it("a virtualised feed post whose own direct link opens a Story is not a tray card", () => {
    render("fb-stories.html");
    // The feed's own virtualiser shape: [role=feed] > [data-virtualized] > post, the Story link a
    // direct child of the post, exactly the shape a tray card has outside the feed.
    document.getElementById("keep-feed")!.insertAdjacentHTML("beforeend",
      '<div data-virtualized="false" id="keep-feed-virtualizer">'
      + '<div id="keep-story-link-post"><a href="/stories/900000000009/">An invented shared Story</a></div>'
      + '<div id="keep-story-link-post-absolute"><a href="https://www.facebook.com/stories/900000000010/">Another invented shared Story</a></div>'
      + "</div>");
    session().applyDom(ALL_ON, new URL(`${FB}/`), document, ON);
    expect(visible("keep-story-link-post")).toBe(true);
    expect(visible("keep-story-link-post-absolute")).toBe(true);
    // The tray itself is still hidden.
    expect(visible("target-story-card-1")).toBe(false);
  });
});

describe("Videos and Watch: the four Reels/Videos combinations (fb-videos.html)", () => {
  const combos = [
    { reels: false, videos: false },
    { reels: true, videos: false },
    { reels: false, videos: true },
    { reels: true, videos: true },
  ] as const;

  for (const { reels, videos } of combos)
    it(`Reels ${reels ? "On" : "Off"}, Videos ${videos ? "On" : "Off"}`, () => {
      render("fb-videos.html");
      const engine = session();
      engine.applyDom(settingsWith({ "facebook.reels": reels, "facebook.videos": videos }), new URL(`${FB}/`), document, ON);
      for (const id of ["target-feed-video", "target-feed-live", "target-nav-watch"]) expect(visible(id), id).toBe(!videos);
      // The feed Reel belongs to free Reels only: Videos never hides it.
      expect(visible("reel-feed-free"), "reel-feed-free").toBe(!reels);
      expect(visible("reels-nav-free"), "reels-nav-free").toBe(true);
      for (const id of ids("keep-")) expect(visible(id), id).toBe(true);
      // Hidden feed video is quieted by the engine's media adapter; direct players never are.
      const feedVideo = document.querySelector("#target-feed-video video")!;
      const reelVideo = document.querySelector("#reel-feed-free video")!;
      const directVideo = document.querySelector("#keep-direct-player video")!;
      expect(engine.ownsHiddenMedia!(feedVideo)).toBe(videos);
      expect(engine.ownsHiddenMedia!(reelVideo)).toBe(reels);
      expect(engine.ownsHiddenMedia!(directVideo)).toBe(false);
    });

  it("D244: a shared Reel in the normal player is never re-hidden by Videos, on its page or in the feed", () => {
    render("fb-videos.html");
    // A shared Reel post that plays in the normal video player and also carries a video link.
    document.getElementById("keep-feed")!.insertAdjacentHTML("beforeend",
      '<div role="article" id="shared-reel-normal-player"><a href="/inventedpage/videos/900000000110">Invented video page</a>'
      + '<a href="/reel/900000000110">Invented shared Reel</a><video></video></div>');
    const reelsOff = settingsWith({ "facebook.reels": false, "facebook.videos": true });
    const engine = session();
    engine.applyDom(reelsOff, new URL(`${FB}/`), document, ON);
    expect(visible("shared-reel-normal-player")).toBe(true);
    expect(engine.ownsHiddenMedia!(document.querySelector("#shared-reel-normal-player video")!)).toBe(false);
    // The shared Reel's own page, with Reels and Videos both On: its player stays and plays.
    const page = session();
    const reelUrl = new URL("/reel/900000000110", FB);
    expect(page.evaluate(ALL_ON, reelUrl, ON)).toEqual({ kind: "apply" });
    page.applyDom(ALL_ON, reelUrl, document, ON);
    expect(visible("keep-direct-player")).toBe(true);
    expect(page.ownsHiddenMedia!(document.querySelector("#keep-direct-player video")!)).toBe(false);
  });

  it("a text post that only links to a video, without a player, stays", () => {
    render("fb-videos.html");
    document.getElementById("keep-feed")!.insertAdjacentHTML("beforeend",
      '<div role="article" id="keep-video-link-only"><a href="/inventedpage/videos/900000000111">A link to an invented video</a></div>');
    session().applyDom(ALL_ON, new URL(`${FB}/`), document, ON);
    expect(visible("keep-video-link-only")).toBe(true);
  });
});

describe("Desktop sidebar ads (fb-sidebar.html)", () => {
  it("hides only the right-column ad block", () => {
    render("fb-sidebar.html");
    session().applyDom(ALL_ON, new URL(`${FB}/`), document, ON);
    expect(visible("target-sidebar-ad-block")).toBe(false);
    for (const id of ids("keep-")) expect(visible(id), id).toBe(true);
  });

  it("Contacts, birthdays and group chats stay visible in every combination of the Facebook controls", () => {
    for (let mask = 0; mask < 16; mask++) {
      const [reels, stories, videos, sponsored] = [1, 2, 4, 8].map((bit) => (mask & bit) !== 0);
      render("fb-sidebar.html");
      const engine = session();
      const settings = settingsWith({ "facebook.reels": reels, "facebook.stories": stories, "facebook.videos": videos, "facebook.sponsored": sponsored });
      engine.applyDom(settings, new URL(`${FB}/`), document, ON);
      for (const id of ["keep-contacts", "keep-birthdays", "keep-group-chats"]) expect(visible(id), `${id} mask ${mask}`).toBe(true);
      expect(visible("target-sidebar-ad-block"), `ad mask ${mask}`).toBe(!sponsored);
      engine.stop?.();
    }
  });

  it("uncertain blocks stay: a Contacts list carrying an outbound link, or one column child holding everything", () => {
    render("fb-sidebar.html");
    document.getElementById("keep-contacts")!.insertAdjacentHTML("afterbegin",
      '<a href="https://invented.example/" rel="nofollow">Invented outbound link</a>');
    const column = document.getElementById("right-column")!;
    column.insertAdjacentHTML("beforeend",
      '<div id="keep-mixed"><a href="https://ads.invented.example/click?id=ad3" rel="nofollow">Invented ad three</a>'
      + '<div role="list" aria-label="Invented list"><a href="https://www.facebook.com/inventedcontact3/">Invented contact three</a></div></div>');
    session().applyDom(ALL_ON, new URL(`${FB}/`), document, ON);
    expect(visible("keep-contacts")).toBe(true);
    expect(visible("keep-mixed")).toBe(true);
    expect(visible("target-sidebar-ad-block")).toBe(false);
  });

  it("is not implemented on the Safari host (iPad is open owner question Q4) or when the host is unknown", () => {
    for (const host of ["safari", undefined] as const) {
      render("fb-sidebar.html");
      const engine = session();
      engine.applyDom(ALL_ON, new URL(`${FB}/`), document, paidOn(host));
      expect(visible("target-sidebar-ad-block"), String(host)).toBe(true);
      expect(engine.effectiveFeatures!(), String(host)).not.toContain("facebook.sponsored");
      // Stories and Videos are implemented on every host.
      expect(engine.effectiveFeatures!(), String(host)).toEqual(expect.arrayContaining(["facebook.stories", "facebook.videos"]));
      engine.stop?.();
    }
  });
});

describe("Facebook extras stay dormant on the shipped paid-off defaults", () => {
  it.each(["fb-stories.html", "fb-videos.html", "fb-sidebar.html"])("%s: every Pro saved On has no effect", (file) => {
    render(file);
    const engine = session();
    engine.applyDom(ALL_ON, new URL(`${FB}/`), document);
    expect(engine.effectiveFeatures!()).toEqual(["facebook.reels"]);
    for (const id of ids("target-")) expect(visible(id), id).toBe(true);
    const text = [...document.head.querySelectorAll("style")].map((style) => style.textContent).join("\n");
    for (const surface of FACEBOOK_EXTRAS.surfaces) for (const selector of surface.selectors) expect(text).not.toContain(selector);
    expect(document.documentElement.className).not.toMatch(/facebook-(stories|videos|sponsored)/);
  });

  it("marks each Facebook extra implemented per host", () => {
    const facebook = (host: AccessHost) => IMPLEMENTED_PRO_FEATURES[host].filter((id) => id.startsWith("facebook."));
    expect(facebook("chromium")).toEqual(FB_PRO);
    expect(facebook("firefox")).toEqual(FB_PRO);
    expect(facebook("safari")).toEqual(["facebook.stories", "facebook.videos"]);
  });
});
