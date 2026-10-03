import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BenefitAccessSnapshot,
  type SignedRuleSetV2,
} from "@still/shared-types";
import { createEnginePageSession, type EnginePageSession } from "../engine.js";
import { YOUTUBE_SHORTS_RULES } from "../youtube.js";
import { ruleSet, DEFAULT_SETTINGS_V2, access } from "./format2-fixtures.js";

const bundle: SignedRuleSetV2 = {
  ...ruleSet,
  services: { youtube: YOUTUBE_SHORTS_RULES },
};
const sessions: EnginePageSession[] = [];
const layouts: readonly (readonly [
  string,
  string,
  readonly string[],
  boolean?,
])[] = [
  [
    "youtube.html",
    "/",
    [
      "shorts-guide",
      "shorts-mini-guide",
      "shorts-chip",
      "shelf",
      "rich-shorts-section",
      "subs-shorts-shelf",
    ],
  ],
  ["youtube.html", "/feed/subscriptions", ["subs-shorts-shelf"]],
  [
    "youtube-search.html",
    "/results?search_query=example",
    ["shorts-result", "shorts-shelf"],
  ],
  [
    "youtube-channel.html",
    "/@channel",
    ["shorts-tab", "shorts-tab-legacy", "channel-shorts-shelf"],
  ],
  [
    "youtube-watch.html",
    "/watch?v=normal&list=chosen&index=2",
    ["watch-shorts-shelf", "watch-mobile-short"],
  ],
  [
    "youtube-watch.html",
    "/watch?v=normal&list=chosen&index=2",
    ["watch-shorts-shelf", "watch-mobile-short"],
    true,
  ],
  [
    "youtube-mobile.html",
    "/",
    [
      "shorts-tab",
      "shorts-tab-by-href",
      "mobile-shorts-section",
      "mobile-reel-shelf-section",
      "mobile-loose-short",
      "mobile-shorts-card",
    ],
  ],
  [
    "youtube-mobile-search.html",
    "/results?search_query=example",
    ["mobile-shorts-result", "mobile-shorts-shelf"],
  ],
  [
    "youtube-mobile-channel.html",
    "/@channel",
    ["mobile-shorts-tab", "mobile-channel-shorts-shelf"],
  ],
] as const;
function render(name: string) {
  const html = readFileSync(resolve("../../tests/fixtures", name), "utf8");
  document.body.innerHTML = new DOMParser().parseFromString(
    html,
    "text/html",
  ).body.innerHTML;
}
function session() {
  const engine = createEnginePageSession(bundle);
  sessions.push(engine);
  return engine;
}
function display(id: string) {
  return getComputedStyle(document.getElementById(id)!).display;
}
function shown(node: Element) {
  for (let at: Element | null = node; at; at = at.parentElement)
    if (getComputedStyle(at).display === "none") return false;
  return true;
}
beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "site-theme";
});
afterEach(() => {
  for (const engine of sessions.splice(0)) engine.stop?.();
});
describe("captured YouTube Shorts through the single format2 interpreter", () => {
  it("the internal data is deeply immutable and grants only reversible core Shorts hides", () => {
    expect(Object.isFrozen(YOUTUBE_SHORTS_RULES)).toBe(true);
    expect(Object.isFrozen(YOUTUBE_SHORTS_RULES.matches)).toBe(true);
    expect(Object.isFrozen(YOUTUBE_SHORTS_RULES.surfaces)).toBe(true);
    for (const surface of YOUTUBE_SHORTS_RULES.surfaces) {
      expect(Object.isFrozen(surface)).toBe(true);
      if (surface.action !== "hide")
        throw new Error("Shorts data must only hide");
      expect(Object.isFrozen(surface.selectors)).toBe(true);
      expect(surface.feature).toBe("youtube.shorts");
      expect(surface.action).toBe("hide");
      expect(new Set(surface.selectors).size).toBe(surface.selectors.length);
    }
  });
  for (const [file, path, targets, mobile = file.includes("mobile")] of layouts)
    it(`${mobile ? "mobile" : "desktop"} ${file} ${path} hides captured targets and preserves renderer-owned ordinary content`, () => {
      render(file);
      const engine = session();
      const url = new URL(
        path,
        file.includes("mobile")
          ? "https://m.youtube.com"
          : "https://www.youtube.com",
      );
      const nodes = targets.map((id) => document.getElementById(id)!);
      const keep = [...document.querySelectorAll<HTMLElement>('[id^="keep-"]')];
      const before = new Map(
        [...nodes, ...keep].map((node) => [node, node.outerHTML]),
      );
      engine.applyDom(DEFAULT_SETTINGS_V2, url, document);
      for (const id of targets) expect(display(id), id).toBe("none");
      for (const node of keep) expect(shown(node), node.id).toBe(true);
      for (const [node, html] of before) {
        expect(node.isConnected, node.id).toBe(true);
        expect(node.outerHTML, node.id).toBe(html);
      }
      engine.applyDom(
        {
          ...DEFAULT_SETTINGS_V2,
          sites: { ...DEFAULT_SETTINGS_V2.sites, "youtube.shorts": false },
        },
        url,
        document,
      );
      for (const id of targets) expect(display(id), id).not.toBe("none");
      expect(document.documentElement.classList.contains("site-theme")).toBe(
        true,
      );
    });
  it("a reused own thumbnail reclassifies without a sweep or deleting the card", () => {
    render("youtube-mobile.html");
    const engine = session();
    const url = new URL("https://m.youtube.com/");
    const card = document.getElementById("mobile-shorts-card")!;
    const anchor = card.querySelector("a")!;
    engine.applyDom(DEFAULT_SETTINGS_V2, url, document);
    expect(display(card.id)).toBe("none");
    card
      .querySelector("ytm-media-item")!
      .classList.remove("big-shorts-singleton");
    anchor.setAttribute("href", "/watch?v=ordinary");
    expect(display(card.id)).not.toBe("none");
    anchor.setAttribute("href", "/shorts/recycled");
    expect(display(card.id)).toBe("none");
    expect(card.parentElement).toBe(document.querySelector("ytm-app"));
    expect(engine.debugStats()).toMatchObject({
      domQueries: 0,
      retainedSiteNodes: 0,
    });
  });
  it("current held access, master and service Off retract only owned effects without rewriting intent", () => {
    render("youtube.html");
    const engine = session();
    const url = new URL("https://www.youtube.com/");
    const saved = JSON.stringify(DEFAULT_SETTINGS_V2);
    for (const state of [
      "checking",
      "locked",
      "unsupported",
      "verification_required",
    ] as const) {
      const held: BenefitAccessSnapshot = {
        ...access,
        states: { ...access.states, "youtube.shorts": state },
      };
      engine.applyDom(DEFAULT_SETTINGS_V2, url, document, { access: held });
      expect(display("shelf")).not.toBe("none");
    }
    for (const settings of [
      { ...DEFAULT_SETTINGS_V2, globalOn: false },
      {
        ...DEFAULT_SETTINGS_V2,
        services: { ...DEFAULT_SETTINGS_V2.services, youtube: false },
      },
    ]) {
      engine.applyDom(settings, url, document);
      expect(display("shelf")).not.toBe("none");
    }
    expect(JSON.stringify(DEFAULT_SETTINGS_V2)).toBe(saved);
  });
  it("short links normalize only the video id while normal watch, community and outbound routes remain usable", () => {
    const engine = session();
    const input = new URL(
      "https://www.youtube.com/shorts/shared_123?list=chosen&index=2&t=9&si=share#part",
    );
    const result = engine.evaluate(DEFAULT_SETTINGS_V2, input);
    expect(result).toEqual({
      kind: "redirect",
      url: "https://www.youtube.com/watch?list=chosen&index=2&t=9&si=share&v=shared_123#part",
    });
    for (const url of [
      "https://www.youtube.com/watch?v=normal&list=chosen",
      "https://www.youtube.com/@channel/community",
      "https://example.com/shorts/shared_123",
    ])
      expect(engine.evaluate(DEFAULT_SETTINGS_V2, new URL(url)).kind).not.toBe(
        "redirect",
      );
  });
});
