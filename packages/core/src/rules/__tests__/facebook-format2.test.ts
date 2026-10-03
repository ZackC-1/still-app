import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEnginePageSession, type EnginePageSession } from "../engine.js";
import { FACEBOOK_REELS_RULES } from "../facebook.js";
import { ruleSet, DEFAULT_SETTINGS_V2, access } from "./format2-fixtures.js";

const bundle = { ...ruleSet, services: { facebook: FACEBOOK_REELS_RULES } };
const sessions: EnginePageSession[] = [];
const visible = (node: Element) => {
  for (let at: Element | null = node; at; at = at.parentElement)
    if (getComputedStyle(at).display === "none") return false;
  return true;
};
function render(file: string) {
  document.body.innerHTML = new DOMParser().parseFromString(
    readFileSync(resolve("../../tests/fixtures", file), "utf8"),
    "text/html",
  ).body.innerHTML;
}
function session() {
  const result = createEnginePageSession(bundle);
  sessions.push(result);
  return result;
}
beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "site-theme";
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.stop?.();
});
describe("captured Facebook through the maintained format2 compiler", () => {
  for (const [file, target, ordinary, href] of [
    [
      "facebook.html",
      "reels-shelf-card",
      "keep-article",
      "https://www.facebook.com/",
    ],
    [
      "facebook-mobile.html",
      "fb-mobile-reel",
      "fb-mobile-post",
      "https://m.facebook.com/",
    ],
  ] as const)
    it(`${file}: a present Reels target hides while ordinary content survives`, () => {
      render(file);
      const reel = document.getElementById(target)!;
      const keep = document.getElementById(ordinary)!;
      expect(reel).not.toBeNull();
      expect(keep).not.toBeNull();
      expect(visible(reel)).toBe(true);
      expect(visible(keep)).toBe(true);
      const before = keep.outerHTML;
      session().applyDom(DEFAULT_SETTINGS_V2, new URL(href), document);
      expect(visible(keep)).toBe(true);
      expect(keep.outerHTML).toBe(before);
      expect(visible(reel)).toBe(false);
    });

  it("immutable data admits only reversible core Reels selectors", () => {
    expect(Object.isFrozen(FACEBOOK_REELS_RULES)).toBe(true);
    expect(Object.isFrozen(FACEBOOK_REELS_RULES.matches)).toBe(true);
    expect(Object.isFrozen(FACEBOOK_REELS_RULES.surfaces)).toBe(true);
    for (const surface of FACEBOOK_REELS_RULES.surfaces) {
      expect(Object.isFrozen(surface)).toBe(true);
      expect(surface.feature).toBe("facebook.reels");
      expect(surface.action).toBe("hide");
      if (surface.action !== "hide") throw new Error("Core data only hides");
      expect(Object.isFrozen(surface.selectors)).toBe(true);
      expect(new Set(surface.selectors).size).toBe(surface.selectors.length);
    }
  });

  it("desktop shelf, shortcut and tab children hide without rewriting measured wrappers or ordinary nodes", () => {
    render("facebook.html");
    const targets = [
      "reels-shortcut-by-label",
      "menu-reels",
      "reel-article",
      "reels-shelf-card",
      "emptied-reels-shelf-card",
      "nested-reels-shelf-card",
      "page-more-reels",
    ].map((id) => document.getElementById(id)!);
    const tab = document.getElementById("page-reels-tab")!;
    const keep = [
      ...document.querySelectorAll('[id^="keep-"]'),
      tab,
      document.getElementById("reels-shelf-unit")!,
      document.getElementById("emptied-reels-shelf-unit")!,
    ];
    const before = new Map(
      [...targets, ...keep].map((node) => [node, node.outerHTML]),
    );
    const s = session();
    const url = new URL("https://www.facebook.com/");
    s.applyDom(DEFAULT_SETTINGS_V2, url, document);
    for (const node of targets) expect(visible(node), node.id).toBe(false);
    for (const child of tab.children) expect(visible(child)).toBe(false);
    for (const node of keep) expect(visible(node), node.id).toBe(true);
    for (const [node, html] of before) {
      expect(node.isConnected, node.id).toBe(true);
      expect(node.outerHTML, node.id).toBe(html);
    }
    s.applyDom(
      {
        ...DEFAULT_SETTINGS_V2,
        sites: { ...DEFAULT_SETTINGS_V2.sites, "facebook.reels": false },
      },
      url,
      document,
    );
    for (const node of [...targets, ...tab.children])
      expect(visible(node)).toBe(true);
    expect(document.documentElement.classList.contains("site-theme")).toBe(
      true,
    );
  });

  it("the mobile tab's box stays while its captured label children hide, not lookalike tabs", () => {
    render("facebook-mobile.html");
    const tab = document.getElementById("fb-mobile-reels-tab")!;
    const ordinary = document.createElement("div");
    ordinary.setAttribute("role", "tab");
    ordinary.setAttribute("aria-label", "Fishing Reels, 4 of 6");
    ordinary.innerHTML = "<span>Fishing Reels</span>";
    document.getElementById("fb-mobile-tablist")!.append(ordinary);
    const html = tab.outerHTML;
    session().applyDom(
      DEFAULT_SETTINGS_V2,
      new URL("https://m.facebook.com/"),
      document,
    );
    expect(visible(tab)).toBe(true);
    expect(visible(tab.firstElementChild!)).toBe(false);
    expect(visible(ordinary.firstElementChild!)).toBe(true);
    expect(tab.outerHTML).toBe(html);
    expect(visible(document.getElementById("keep-fb-mobile-home-tab")!)).toBe(
      true,
    );
  });

  it("the virtualized child keeps ownership with empty tiles and releases when recycled to ordinary content", () => {
    render("facebook.html");
    const card = document.getElementById("reels-shelf-card")!;
    const grid = card.querySelector('[role="grid"]')!;
    const s = session();
    s.applyDom(
      DEFAULT_SETTINGS_V2,
      new URL("https://www.facebook.com/"),
      document,
    );
    expect(visible(card)).toBe(false);
    grid.replaceChildren();
    expect(visible(card)).toBe(false);
    grid.setAttribute("aria-label", "People you may know");
    expect(visible(card)).toBe(true);
    grid.setAttribute("aria-label", "Reels");
    expect(visible(card)).toBe(false);
    expect(visible(document.getElementById("keep-outer-unit-child")!)).toBe(
      true,
    );
    expect(visible(document.getElementById("keep-shallow-feed")!)).toBe(true);
    expect(s.debugStats()).toMatchObject({
      domQueries: 0,
      retainedSiteNodes: 0,
    });
  });

  it("caption and external links do not identify an ordinary or sponsored feed card", () => {
    render("facebook.html");
    for (const id of ["keep-article", "keep-sponsored-post"]) {
      const p = document.createElement("p");
      p.innerHTML = '<a href="/reel/mentioned/">A shared Reel</a>';
      document.getElementById(id)!.append(p);
    }
    const outside = document.createElement("div");
    outside.setAttribute("role", "article");
    outside.innerHTML = '<a href="/reel/shared/">An intentional message</a>';
    document.body.append(outside);
    session().applyDom(
      DEFAULT_SETTINGS_V2,
      new URL("https://www.facebook.com/"),
      document,
    );
    for (const id of [
      "keep-article",
      "keep-sponsored-post",
      "keep-lookalike-article",
    ])
      expect(visible(document.getElementById(id)!), id).toBe(true);
    expect(visible(outside)).toBe(true);
  });

  it("checked radio-menu matching preserves exact vanity, group, query, fragment and external paths", () => {
    render("facebook.html");
    const menu = document.getElementById("page-tabs-more-menu")!;
    for (const href of [
      "https://www.facebook.com/stillapp/reels_tab?chosen=1",
      "https://www.facebook.com/stillapp/reels_tab#part",
      "https://www.facebook.com/search?q=/reels_tab",
      "https://www.facebook.com/groups/reels_tab",
      "https://example.com/stillapp/reels_tab",
    ]) {
      const a = document.createElement("a");
      a.setAttribute("role", "menuitemradio");
      a.setAttribute("aria-checked", "false");
      a.href = href;
      a.id = `keep-extra-${menu.children.length}`;
      a.textContent = "A useful destination";
      menu.append(a);
    }
    session().applyDom(
      DEFAULT_SETTINGS_V2,
      new URL("https://www.facebook.com/"),
      document,
    );
    expect(visible(document.getElementById("page-more-reels")!)).toBe(false);
    for (const node of menu.querySelectorAll('[id^="keep-"]'))
      expect(visible(node), node.id).toBe(true);
  });

  it("current access holds and saved feature, service or master Off preserve choices and content", () => {
    render("facebook.html");
    const s = session(),
      url = new URL("https://www.facebook.com/");
    const saved = JSON.stringify(DEFAULT_SETTINGS_V2);
    for (const state of [
      "checking",
      "locked",
      "unsupported",
      "verification_required",
    ] as const) {
      s.applyDom(DEFAULT_SETTINGS_V2, url, document, {
        access: {
          ...access,
          states: { ...access.states, "facebook.reels": state },
        },
      });
      expect(visible(document.getElementById("reels-shelf-card")!)).toBe(true);
    }
    for (const settings of [
      { ...DEFAULT_SETTINGS_V2, globalOn: false },
      {
        ...DEFAULT_SETTINGS_V2,
        services: { ...DEFAULT_SETTINGS_V2.services, facebook: false },
      },
      {
        ...DEFAULT_SETTINGS_V2,
        sites: { ...DEFAULT_SETTINGS_V2.sites, "facebook.reels": false },
      },
    ]) {
      s.applyDom(settings, url, document);
      expect(visible(document.getElementById("reels-shelf-card")!)).toBe(true);
    }
    expect(JSON.stringify(DEFAULT_SETTINGS_V2)).toBe(saved);
  });

  it("direct normal, live, shared and ordinary routes preserve their destination", () => {
    const s = session();
    for (const href of [
      "/reel/shared/?chosen=1#part",
      "/reels/shared/?chosen=1#part",
      "/watch/?v=chosen",
      "/stillapp/videos/123/",
      "/stillapp/live_videos/",
      "/groups/reels/",
      "/public/reels",
      "/hashtag/reels/",
      "/messages/",
      "/search?q=/reels_tab",
    ])
      expect(
        s.evaluate(
          DEFAULT_SETTINGS_V2,
          new URL(href, "https://www.facebook.com"),
        ).kind,
        href,
      ).toBe("apply");
    expect(
      s.evaluate(
        DEFAULT_SETTINGS_V2,
        new URL("https://www.facebook.com/reels/"),
      ).kind,
    ).toBe("redirect");
  });
});
