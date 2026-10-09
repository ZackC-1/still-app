import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAID_TIER_ENABLED, type BenefitAccessSnapshot, type FeatureId, type SettingsV2 } from "@still/shared-types";
import {
  ACCESS_HOSTS,
  IMPLEMENTED_PRO_FEATURES,
  accessCapabilities,
  accessCapabilitiesForTest,
  initialAccessSnapshot,
  packagedAccessContext,
  type AccessHost,
  type AccessPlatform,
} from "../../entitlement/access-policy.js";
import { createEnginePageSession, type EngineOptions, type EnginePageSession } from "../engine.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../packaged.js";
import { YOUTUBE_EXTRAS } from "../youtube-extras.js";
import { DEFAULT_SETTINGS_V2 } from "./format2-fixtures.js";
import { extrasFixture } from "./extras-fixtures.js";

// YouTube's four Still Pro hide controls (Related videos, End-of-video suggestions, Comments, Live
// chat) and the top-level live chat route, through the SHIPPED packaged rule set and the shipped
// engine. The paid-on branch is reached only through the explicit test seams (a purchased access
// snapshot plus accessCapabilitiesForTest over the real implementation table); the shipped
// defaults (paid off) must leave every one of them dormant. The fixtures are synthetic and their
// selector families are unverified candidates (see youtube-extras.ts).

const YT_PRO = ["youtube.related", "youtube.endscreen", "youtube.comments", "youtube.livechat"] as const satisfies readonly FeatureId[];
type YtPro = (typeof YT_PRO)[number];
const packaged = admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!;

/** The paid-on seam for one host: real implementation table, purchased access for the four. */
function paidOn(host: AccessHost = "chromium", platform?: AccessPlatform): EngineOptions {
  const capabilities = accessCapabilitiesForTest({ paidMode: true, host, platform }, IMPLEMENTED_PRO_FEATURES);
  const base = initialAccessSnapshot({ paidMode: true, supported: capabilities });
  const access: BenefitAccessSnapshot = { ...base, states: { ...base.states, ...Object.fromEntries(
    YT_PRO.filter((id) => capabilities.has(id)).map((id) => [id, "purchased"])) } };
  return { access, capabilities };
}
const settings = (on: readonly FeatureId[], patch: Partial<SettingsV2> = {}): SettingsV2 => ({
  ...DEFAULT_SETTINGS_V2,
  ...patch,
  sites: { ...DEFAULT_SETTINGS_V2.sites, ...Object.fromEntries(YT_PRO.map((id) => [id, on.includes(id)])) },
});

interface Case {
  readonly feature: YtPro;
  readonly file: string;
  readonly url: string;
  readonly targets: readonly string[];
}
const CASES: readonly Case[] = [
  { feature: "youtube.related", file: "yt-watch-related.html", url: "https://www.youtube.com/watch?v=inv000000",
    targets: ["target-related-below", "target-related-side"] },
  { feature: "youtube.related", file: "yt-m-watch-related.html", url: "https://m.youtube.com/watch?v=inv100000",
    targets: ["target-m-related"] },
  { feature: "youtube.endscreen", file: "yt-watch-end.html", url: "https://www.youtube.com/watch?v=inv200000",
    targets: ["target-end-card-video", "target-end-card-channel", "target-endscreen-grid"] },
  { feature: "youtube.comments", file: "yt-watch-comments-chat.html", url: "https://www.youtube.com/watch?v=inv400000",
    targets: ["target-comments", "target-comments-panel"] },
  { feature: "youtube.livechat", file: "yt-watch-comments-chat.html", url: "https://www.youtube.com/watch?v=inv400001",
    targets: ["target-chat-frame", "target-chat-entry", "target-chat-replay"] },
];
/** Every element on every fixture that one of the four controls may hide, with its owner. */
const OWNER = new Map<string, YtPro>(CASES.flatMap((c) => c.targets.map((id) => [`${c.file}#${id}`, c.feature] as const)));
// The related fixture's keep-* comments and chat belong to OTHER controls; they must stay for
// Related, and hide only under their own control.
OWNER.set("yt-watch-related.html#keep-comments", "youtube.comments");
OWNER.set("yt-watch-related.html#keep-chat-frame", "youtube.livechat");
OWNER.set("yt-watch-related.html#keep-chat-iframe", "youtube.livechat");

const sessions: EnginePageSession[] = [];
function session(): EnginePageSession {
  const engine = createEnginePageSession(packaged);
  sessions.push(engine);
  return engine;
}
function render(file: string): void {
  document.body.innerHTML = new DOMParser().parseFromString(extrasFixture(file), "text/html").body.innerHTML;
}
/** Visible through every ancestor (an ancestor's display:none hides it too). */
function shown(node: Element): boolean {
  for (let at: Element | null = node; at; at = at.parentElement) if (getComputedStyle(at).display === "none") return false;
  return true;
}
const byId = (id: string) => document.getElementById(id)!;
const ids = (prefix: string) => [...document.querySelectorAll(`[id^="${prefix}"]`)].map((node) => node.id);
const featureClasses = () => [...document.documentElement.classList].filter((name) => name.startsWith("still-feature-"));
const ownedStyle = () => document.head.querySelector("style")?.textContent ?? "";
const extrasSelectors = YOUTUBE_EXTRAS.surfaces.flatMap((surface) => surface.selectors);

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "site-theme";
});
afterEach(() => {
  for (const engine of sessions.splice(0)) engine.stop?.();
});

describe("YouTube Still Pro hide controls, paid on through the test seams", () => {
  for (const c of CASES) {
    const name = `${c.feature} on ${c.file}`;

    it(`${name}: A1 hides every target but keeps it attached and untouched; A2 every keep stays visible`, () => {
      render(c.file);
      const before = new Map([...document.body.querySelectorAll("*")].map((node) => [node, node.outerHTML]));
      const engine = session();
      const url = new URL(c.url);
      engine.applyDom(settings([c.feature]), url, document, paidOn());
      expect(engine.evaluate(settings([c.feature]), url, paidOn())).toEqual({ kind: "apply" });
      expect(engine.effectiveFeatures!()).toEqual(["youtube.shorts", c.feature]);
      for (const id of c.targets) {
        expect(byId(id).isConnected, id).toBe(true);
        expect(shown(byId(id)), id).toBe(false);
      }
      expect(ids("keep-").length).toBeGreaterThan(0);
      for (const id of ids("keep-")) expect(shown(byId(id)), id).toBe(true);
      // Every target of another control on the same page stays visible.
      for (const id of ids("target-").filter((id) => !c.targets.includes(id))) expect(shown(byId(id)), id).toBe(true);
      // Hide, never remove or edit: renderer-owned nodes, children and attributes are untouched.
      for (const [node, html] of before) expect(node.outerHTML).toBe(html);
      // Media in the kept player is never treated as hidden, so it is never paused.
      for (const video of document.querySelectorAll("video")) expect(engine.ownsHiddenMedia!(video)).toBe(video.closest("[id^='target-']") !== null);
    });

    it(`${name}: A3 the feature, its service and Still off each restore exactly what Still hid, without navigating`, () => {
      render(c.file);
      const engine = session();
      const url = new URL(c.url);
      const on = settings([c.feature]);
      const offs: SettingsV2[] = [
        settings([]),
        settings([c.feature], { services: { ...DEFAULT_SETTINGS_V2.services, youtube: false } }),
        settings([c.feature], { globalOn: false }),
      ];
      for (const off of offs) {
        engine.applyDom(on, url, document, paidOn());
        for (const id of c.targets) expect(shown(byId(id)), `${id} on`).toBe(false);
        engine.applyDom(off, url, document, paidOn());
        expect(engine.evaluate(off, url, paidOn()).kind).not.toBe("redirect");
        for (const id of c.targets) expect(shown(byId(id)), `${id} off`).toBe(true);
        for (const id of ids("keep-")) expect(shown(byId(id)), id).toBe(true);
        expect(featureClasses().some((name) => name.endsWith(c.feature.replace(".", "-")))).toBe(false);
        for (const selector of extrasSelectors) expect(ownedStyle()).not.toContain(selector);
      }
      engine.applyDom(on, url, document, paidOn());
      for (const id of c.targets) expect(shown(byId(id)), `${id} on again`).toBe(false);
    });

    it(`${name}: A4 dormant with the shipped paid-off defaults on every host, saved On`, () => {
      render(c.file);
      const engine = session();
      const url = new URL(c.url);
      const all = settings(YT_PRO);
      // Exactly what a shipped host hands the engine: its content entry's capabilities and the
      // access snapshot its background resolves from the same host's packaged context.
      for (const opts of [{}, ...[undefined, ...ACCESS_HOSTS].map((host): EngineOptions => ({
        capabilities: accessCapabilities({ paidMode: PAID_TIER_ENABLED, host }),
        access: initialAccessSnapshot(packagedAccessContext(host)) }))]) {
        engine.applyDom(all, url, document, opts);
        expect(engine.effectiveFeatures!()).toEqual(["youtube.shorts"]);
        for (const id of [...ids("target-"), ...ids("keep-")]) expect(shown(byId(id)), id).toBe(true);
        for (const selector of extrasSelectors) expect(ownedStyle()).not.toContain(selector);
        expect(featureClasses()).toHaveLength(1);
      }
    });
  }

  // A5: every one of the 16 combinations of the four controls, with Shorts on and off, hides
  // exactly the targets of the controls that are on. Split per fixture and Shorts state.
  const A5_PAGES = [...new Map(CASES.map((c) => [c.file, c.url] as const))];
  for (const [file, url] of A5_PAGES) for (const shorts of [true, false])
    it(`A5 independence on ${file} (Shorts ${shorts ? "on" : "off"}): all 16 combinations hide exactly their own targets`, () => {
      render(file);
      const engine = session();
      const checked = [...ids("target-"), ...ids("keep-")];
      for (let mask = 0; mask < 16; mask++) {
        const on = YT_PRO.filter((_, index) => mask & (1 << index));
        const s = settings(on);
        engine.applyDom({ ...s, sites: { ...s.sites, "youtube.shorts": shorts } }, new URL(url), document, paidOn());
        for (const id of checked) {
          const owner = OWNER.get(`${file}#${id}`);
          expect(shown(byId(id)), `${file} ${on.join("+") || "none"} shorts=${shorts}: ${id}`).toBe(!(owner && on.includes(owner)));
        }
      }
    });

  it("A6 late-inserted and recycled nodes follow the current structure, and SPA moves keep the plan", () => {
    render("yt-m-watch-related.html");
    const engine = session();
    const on = settings(YT_PRO);
    engine.applyDom(on, new URL("https://m.youtube.com/watch?v=inv100000"), document, paidOn());
    // Late insertion: a new related renderer, comments section and chat frame hide without a pass.
    document.body.insertAdjacentHTML("beforeend", `
      <ytd-watch-next-secondary-results-renderer id="late-related"></ytd-watch-next-secondary-results-renderer>
      <ytd-comments id="late-comments"></ytd-comments>
      <ytd-live-chat-frame id="late-chat"></ytd-live-chat-frame>
      <div class="ytp-ce-element" id="late-end-card"></div>
      <ytd-playlist-panel-renderer id="late-playlist"></ytd-playlist-panel-renderer>`);
    for (const id of ["late-related", "late-comments", "late-chat", "late-end-card"]) expect(shown(byId(id)), id).toBe(false);
    expect(shown(byId("late-playlist"))).toBe(true);
    // Recycled: a section renderer reused for the comments entry stops being hidden, and back.
    const section = byId("target-m-related");
    section.setAttribute("section-identifier", "comments-entry-point");
    expect(shown(section)).toBe(true);
    section.setAttribute("section-identifier", "related-items");
    expect(shown(section)).toBe(false);
    const teaser = byId("keep-m-comments-teaser");
    teaser.setAttribute("section-identifier", "related-items");
    expect(shown(teaser)).toBe(false);
    teaser.setAttribute("section-identifier", "comments-entry-point");
    expect(shown(teaser)).toBe(true);
    // A recycled engagement panel follows its current target id.
    render("yt-watch-comments-chat.html");
    engine.applyDom(settings(["youtube.comments"]), new URL("https://www.youtube.com/watch?v=inv400000"), document, paidOn());
    const panel = byId("target-comments-panel");
    expect(shown(panel)).toBe(false);
    panel.setAttribute("target-id", "engagement-panel-structured-description");
    expect(shown(panel)).toBe(true);
    // SPA moves: the same session on another YouTube page keeps the controls; a top-level live
    // chat page is routed; coming back applies again.
    engine.applyDom(settings(["youtube.comments"]), new URL("https://www.youtube.com/results?search_query=x"), document, paidOn());
    expect(shown(byId("target-comments"))).toBe(false);
    expect(engine.evaluate(on, new URL("https://www.youtube.com/live_chat?v=inv400001"), paidOn()))
      .toEqual({ kind: "redirect", url: "https://www.youtube.com/" });
    engine.applyDom(on, new URL("https://www.youtube.com/watch?v=inv400001"), document, paidOn());
    expect(shown(byId("target-chat-frame"))).toBe(false);
  });

  it("End-of-video keeps every player control and the autonav countdown (Autoplay is separate)", () => {
    render("yt-watch-end.html");
    session().applyDom(settings(YT_PRO), new URL("https://www.youtube.com/watch?v=inv200000"), document, paidOn());
    for (const id of ["keep-controls", "keep-replay", "keep-seek", "keep-volume", "keep-captions", "keep-settings", "keep-fullscreen", "keep-autonav-countdown", "keep-autonav-cancel"])
      expect(shown(byId(id)), id).toBe(true);
    expect(shown(byId("movie_player"))).toBe(true);
  });
});

describe("youtube.livechat top-level route", () => {
  const all = settings(YT_PRO);
  const evaluate = (href: string, s: SettingsV2 = all, opts: EngineOptions = paidOn()) => session().evaluate(s, new URL(href), opts);

  it.each([
    "https://www.youtube.com/live_chat?v=inv400001",
    "https://www.youtube.com/live_chat/?v=inv400001&is_popout=1",
    "https://www.youtube.com/live_chat_replay?v=inv400001&continuation=x",
    "https://www.youtube.com/live_chat_replay/",
    "https://www.youtube.com/live_chat#x",
  ])("%s goes to same-site Home, silently", (href) => {
    expect(evaluate(href)).toEqual({ kind: "redirect", url: "https://www.youtube.com/" });
  });

  it("keeps the page's own origin (mobile stays mobile)", () => {
    expect(evaluate("https://m.youtube.com/live_chat?v=inv400001")).toEqual({ kind: "redirect", url: "https://m.youtube.com/" });
  });

  it.each([
    "https://www.youtube.com/live_chatx",
    "https://www.youtube.com/live_chat/inner",
    "https://www.youtube.com/live_chat_replay_more",
    "https://www.youtube.com/watch?v=inv400001&live_chat=1",
    "https://www.youtube.com/watch?v=inv400001",
    "https://www.youtube.com/channel/live_chat",
    "https://www.youtube.com/",
  ])("%s is never routed", (href) => {
    expect(evaluate(href).kind).not.toBe("redirect");
  });

  it("routes only while Live chat itself is effective: Off, service Off, Still Off, paid off, or a phone platform all leave it", () => {
    const href = "https://www.youtube.com/live_chat?v=inv400001";
    expect(evaluate(href, settings(["youtube.comments", "youtube.related", "youtube.endscreen"])).kind).not.toBe("redirect");
    expect(evaluate(href, settings(YT_PRO, { services: { ...DEFAULT_SETTINGS_V2.services, youtube: false } })).kind).toBe("noop");
    expect(evaluate(href, settings(YT_PRO, { globalOn: false })).kind).toBe("noop");
    expect(evaluate(href, all, {}).kind).not.toBe("redirect");
    for (const [host, platform] of [["safari", "ios"], ["safari", "unknown"], ["firefox", "android"]] as const)
      expect(evaluate(href, all, paidOn(host, platform)).kind, `${host} ${platform}`).not.toBe("redirect");
    expect(evaluate(href, all, paidOn("safari", "desktop"))).toEqual({ kind: "redirect", url: "https://www.youtube.com/" });
    // Independent of Shorts: Live chat routes with the free core Off.
    expect(evaluate(href, { ...all, sites: { ...all.sites, "youtube.shorts": false } })).toEqual({ kind: "redirect", url: "https://www.youtube.com/" });
  });

  it("never shadows the free Shorts route and never loops (Home is not routed again)", () => {
    expect(evaluate("https://www.youtube.com/shorts/abc123")).toEqual({ kind: "redirect", url: "https://www.youtube.com/watch?v=abc123" });
    expect(evaluate("https://www.youtube.com/").kind).toBe("apply");
    expect(YOUTUBE_EXTRAS.routes).toHaveLength(1);
  });
});

describe("YouTube extras capability table and selector boundaries", () => {
  it("every host implements all five; phone platforms hold the desktop-layout end screen and live chat", () => {
    // The four hide controls plus Autoplay prevention (a content handler, youtube-autoplay.ts).
    for (const host of ACCESS_HOSTS)
      expect([...IMPLEMENTED_PRO_FEATURES[host]].filter((id) => id.startsWith("youtube.")).sort()).toEqual([...YT_PRO, "youtube.autoplay"].sort());
    for (const host of [undefined, ...ACCESS_HOSTS]) {
      const off = accessCapabilities({ paidMode: PAID_TIER_ENABLED, host });
      for (const id of [...YT_PRO, "youtube.autoplay"] as const) expect(off.has(id), `${host}:${id}`).toBe(false);
    }
    const on = (host?: AccessHost, platform?: AccessPlatform) => accessCapabilitiesForTest({ paidMode: true, host, platform }, IMPLEMENTED_PRO_FEATURES);
    for (const id of [...YT_PRO, "youtube.autoplay"] as const) {
      for (const host of [undefined, ...ACCESS_HOSTS]) expect(on(host, "desktop").has(id), `${host}:${id}`).toBe(true);
      const phoneLayout = id !== "youtube.endscreen" && id !== "youtube.livechat";
      expect(on("safari", "ios").has(id), `ios:${id}`).toBe(phoneLayout);
      expect(on("firefox", "android").has(id), `android:${id}`).toBe(phoneLayout);
    }
  });

  it("naming the Safari host alone (a content entry) keeps the whole list; the paid-off context equals no host", () => {
    expect(packagedAccessContext("safari")).toEqual(packagedAccessContext());
    expect(initialAccessSnapshot(packagedAccessContext("safari"))).toEqual(initialAccessSnapshot());
    expect([...accessCapabilitiesForTest({ paidMode: true, host: "safari" }, IMPLEMENTED_PRO_FEATURES)].sort())
      .toEqual([...accessCapabilitiesForTest({ paidMode: true }, IMPLEMENTED_PRO_FEATURES)].sort());
  });

  it("no selector names a wrapper that also holds the playlist, live chat, comments or player controls", () => {
    const wrappers = /#secondary\b|#related\b|#primary\b|#columns\b|#below\b|ytd-watch-flexy|ytm-app|#movie_player|html5-video-player|ytp-chrome|ytp-player-content|html5-endscreen|ytp-autonav|ytd-watch-metadata|ytd-item-section-renderer|ytd-engagement-panel-section-list-renderer(?!\[target-id=)|ytm-item-section-renderer(?!\[section-identifier=)/;
    for (const surface of YOUTUBE_EXTRAS.surfaces) for (const selector of surface.selectors) expect(selector, surface.id).not.toMatch(wrappers);
    // A mobile modal's own scrim belongs to its sole comments-section child. No generic
    // ancestor or shared carousel gains a :has() rule.
    expect(extrasSelectors.filter(selector => selector.includes(":has("))).toEqual([
      "ytm-engagement-panel:has(> ytm-engagement-panel-section-list-renderer.engagement-panel-comments-section):not(:has(> * + *))",
    ]);
    expect(YOUTUBE_EXTRAS.surfaces.map((surface) => surface.feature)).toEqual(YT_PRO);
    expect(YOUTUBE_EXTRAS.markers).toHaveLength(1);
    expect(YOUTUBE_EXTRAS.markers[0]).toMatchObject({ feature: "youtube.comments",
      candidates: "ytm-engagement-panel", ruleSelector: "ytm-engagement-panel[data-still-youtube-comments-panel]",
      structuralFallback: extrasSelectors.find(selector => selector.includes(":has(")) });
  });
});
