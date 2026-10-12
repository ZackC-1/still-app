import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEnginePageSession, type EnginePageSession } from "../engine.js";
import { INSTAGRAM_REELS_LAYOUT, INSTAGRAM_REELS_RULES } from "../instagram.js";
import { ruleSet, DEFAULT_SETTINGS_V2, access } from "./format2-fixtures.js";
const bundle = { ...ruleSet, services: { instagram: INSTAGRAM_REELS_RULES } };
const sessions: EnginePageSession[] = [];
const layouts = [
  [
    "instagram.html",
    ["reels-link", "reel-post", "profile-reel-tile"],
    ["home-link"],
  ],
  [
    "instagram-home.html",
    ["nav-reels", "reel-post", "reel-post-with-hashtags"],
    [],
  ],
  [
    "instagram-mobile.html",
    ["ig-mobile-reels", "ig-mobile-reel"],
    ["ig-mobile-home", "ig-mobile-post"],
  ],
  [
    // The current desktop menu (no <nav>) and a profile's tab row and grid (ISS-0033, ISS-0034).
    "instagram-profile.html",
    ["menu-reels", "profile-reels-tab-slot", "profile-reels-tab", "grid-reel-1", "grid-reel-2",
      "grid-reel-3", "grid-reel-4", "grid-reel-5", "grid-reel-6"],
    ["profile-grid"],
  ],
] as const;
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
  const s = createEnginePageSession(bundle);
  sessions.push(s);
  return s;
}
beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "site-theme";
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.stop?.();
});
describe("captured Instagram through the maintained format2 compiler", () => {
  it("immutable data contains only reversible core Reels hides", () => {
    expect(Object.isFrozen(INSTAGRAM_REELS_RULES)).toBe(true);
    expect(Object.isFrozen(INSTAGRAM_REELS_RULES.matches)).toBe(true);
    expect(Object.isFrozen(INSTAGRAM_REELS_RULES.surfaces)).toBe(true);
    for (const surface of INSTAGRAM_REELS_RULES.surfaces) {
      expect(Object.isFrozen(surface)).toBe(true);
      expect(surface.feature).toBe("instagram.reels");
      expect(surface.action).toBe("hide");
      if (surface.action !== "hide") throw new Error("Reels data only hides");
      expect(Object.isFrozen(surface.selectors)).toBe(true);
      expect(new Set(surface.selectors).size).toBe(surface.selectors.length);
    }
  });
  for (const [file, targets, extraKeep] of layouts)
    it(`${file}: Reels hide reversibly and ordinary nodes remain untouched`, () => {
      render(file);
      const s = session(),
        url = new URL("https://www.instagram.com/");
      const nodes = targets.map((id) => document.getElementById(id)!);
      const keep = [
        ...document.querySelectorAll('[id^="keep-"]'),
        ...extraKeep.map((id) => document.getElementById(id)!),
      ];
      const before = new Map([...nodes, ...keep].map((n) => [n, n.outerHTML]));
      s.applyDom(DEFAULT_SETTINGS_V2, url, document);
      for (const node of nodes) expect(visible(node), node.id).toBe(false);
      for (const node of keep) expect(visible(node), node.id).toBe(true);
      for (const [node, html] of before) {
        expect(node.isConnected, node.id).toBe(true);
        expect(node.outerHTML, node.id).toBe(html);
      }
      s.applyDom(
        {
          ...DEFAULT_SETTINGS_V2,
          sites: { ...DEFAULT_SETTINGS_V2.sites, "instagram.reels": false },
        },
        url,
        document,
      );
      for (const node of nodes) expect(visible(node), node.id).toBe(true);
      expect(document.documentElement.classList.contains("site-theme")).toBe(
        true,
      );
    });
  it("recycled own media destination becomes ordinary without a sweep", () => {
    render("instagram-home.html");
    const s = session(),
      url = new URL("https://www.instagram.com/");
    const card = document.getElementById("reel-post")!;
    const anchor = card.querySelector('a[href="/reels/Ca1eXaMpLe02/"]')!;
    s.applyDom(DEFAULT_SETTINGS_V2, url, document);
    expect(visible(card)).toBe(false);
    anchor.setAttribute("href", "/p/ordinary/");
    expect(visible(card)).toBe(true);
    anchor.setAttribute("href", "/reels/recycled/");
    expect(visible(card)).toBe(false);
    expect(s.debugStats()).toMatchObject({
      domQueries: 0,
      retainedSiteNodes: 0,
    });
  });
  it("ordinary captions linking to a Reel and ordinary audio attribution do not identify an own Reel", () => {
    render("instagram-home.html");
    const card = document.getElementById("keep-post-linking-to-reels")!;
    const a = document.createElement("a");
    a.href = "/reels/mentioned/";
    a.textContent = "See my friend's Reel";
    card.querySelector('span[dir="auto"]')!.append(a);
    const s = session();
    s.applyDom(
      DEFAULT_SETTINGS_V2,
      new URL("https://www.instagram.com/"),
      document,
    );
    expect(visible(card)).toBe(true);
    expect(
      visible(document.getElementById("keep-video-post-with-audio")!),
    ).toBe(true);
  });
  it("Reel badges on outside destinations or caption links do not hide useful links", () => {
    render("instagram.html");
    const grid = document.getElementById("profile-grid")!;
    for (const href of [
      "https://example.com/reel/shop/",
      "//example.com/reel/shop/",
    ]) {
      const a = document.createElement("a");
      a.href = href;
      a.innerHTML = '<svg aria-label="Clip"></svg>Outside';
      grid.append(a);
    }
    const caption = document.createElement("a");
    caption.href = "/someuser/reel/mentioned/";
    caption.innerHTML = '<svg aria-label="Clip"></svg>Caption';
    document.getElementById("keep-post")!.append(caption);
    session().applyDom(
      DEFAULT_SETTINGS_V2,
      new URL("https://www.instagram.com/"),
      document,
    );
    for (const a of grid.querySelectorAll('a[href*="example.com"]'))
      expect(visible(a)).toBe(true);
    expect(visible(caption)).toBe(true);
  });
  it("held current access, service and master Off never hide or rewrite saved choices", () => {
    render("instagram-home.html");
    const s = session(),
      url = new URL("https://www.instagram.com/"),
      saved = JSON.stringify(DEFAULT_SETTINGS_V2);
    for (const state of [
      "checking",
      "locked",
      "unsupported",
      "verification_required",
    ] as const) {
      s.applyDom(DEFAULT_SETTINGS_V2, url, document, {
        access: {
          ...access,
          states: { ...access.states, "instagram.reels": state },
        },
      });
      expect(visible(document.getElementById("reel-post")!)).toBe(true);
    }
    for (const settings of [
      { ...DEFAULT_SETTINGS_V2, globalOn: false },
      {
        ...DEFAULT_SETTINGS_V2,
        services: { ...DEFAULT_SETTINGS_V2.services, instagram: false },
      },
    ]) {
      s.applyDom(settings, url, document);
      expect(visible(document.getElementById("reel-post")!)).toBe(true);
    }
    expect(JSON.stringify(DEFAULT_SETTINGS_V2)).toBe(saved);
  });
  it("profile grid: Reel tiles go whole and only the grid gets the wrap layout, only while Reels hide", () => {
    render("instagram-profile.html");
    const s = session(),
      url = new URL("https://www.instagram.com/someuser/");
    const grid = document.getElementById("profile-grid")!;
    const rows = [...grid.children];
    const tiles = rows.flatMap((row) => [...row.children]);
    s.applyDom(DEFAULT_SETTINGS_V2, url, document);
    // The layout rules select exactly the grid, its rows and its tile boxes, nothing else.
    const scoped = (selector: string) =>
      new Set(document.querySelectorAll(`[class*="-instagram-reels"] :is(${selector})`));
    const [column, row, tile] = INSTAGRAM_REELS_LAYOUT.map((rule) => scoped(rule.selector));
    expect([...column!]).toEqual([grid]);
    expect([...row!]).toEqual(rows);
    expect([...tile!]).toEqual(tiles);
    expect(getComputedStyle(grid).flexWrap).toBe("wrap");
    for (const r of rows) expect(getComputedStyle(r).display).toBe("contents");
    // The style text carries the layout after the hides, under the same feature class.
    const text = document.head.querySelector("style")!.textContent!;
    for (const rule of INSTAGRAM_REELS_LAYOUT) expect(text).toContain(`:is(${rule.selector}){${rule.declarations}}`);
    // Off: no hide and no layout.
    s.applyDom({ ...DEFAULT_SETTINGS_V2, sites: { ...DEFAULT_SETTINGS_V2.sites, "instagram.reels": false } }, url, document);
    expect(getComputedStyle(grid).flexWrap).not.toBe("wrap");
    for (const r of rows) expect(getComputedStyle(r).display).not.toBe("contents");
    for (const t of tiles) expect(visible(t)).toBe(true);
  });
  it("the packaged tile hide and the compiled layout select the same tile boxes", () => {
    // The layout ships in code and the hide in rule data: if either drifts, holes come back.
    const tileBoxes = INSTAGRAM_REELS_LAYOUT[2]!.selector;
    const hides = INSTAGRAM_REELS_RULES.surfaces[0]!;
    if (hides.action !== "hide") throw new Error("Reels data only hides");
    expect(hides.selectors.filter((selector) => selector.startsWith(`${tileBoxes}:has(`))).toHaveLength(1);
  });
  it("a post dialog over the profile is never the grid: its comment and Reel links keep their layout", () => {
    render("instagram-profile.html");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = `<div id="dialog-box"><div id="dialog-comments">
      <div id="dialog-comment"><div><a href="/someuser/p/Post0001/c/900001/">1w</a></div></div>
      <div id="dialog-reel-row"><div id="dialog-reel-box"><a href="/otheruser/reel/Reel0009/">mentioned Reel</a></div></div>
    </div></div>`;
    document.body.append(dialog);
    session().applyDom(DEFAULT_SETTINGS_V2, new URL("https://www.instagram.com/someuser/p/Post0001/"), document);
    // The profile grid underneath still gets its layout...
    expect(getComputedStyle(document.getElementById("profile-grid")!).flexWrap).toBe("wrap");
    // ...but nothing in the dialog does, and nothing in it is hidden as a grid tile.
    for (const id of ["dialog-box", "dialog-comments", "dialog-comment", "dialog-reel-row", "dialog-reel-box"]) {
      const node = document.getElementById(id)!;
      expect(getComputedStyle(node).display, id).not.toBe("contents");
      expect(getComputedStyle(node).flexWrap, id).not.toBe("wrap");
      expect(visible(node), id).toBe(true);
    }
  });
  it("profile rules stay off Home, Explore and post pages, which have no profile tab row", () => {
    render("instagram-profile.html");
    document.getElementById("profile-tabs")!.remove();
    session().applyDom(DEFAULT_SETTINGS_V2, new URL("https://www.instagram.com/explore/"), document);
    const grid = document.getElementById("profile-grid")!;
    expect(getComputedStyle(grid).flexWrap).not.toBe("wrap");
    for (const row of grid.children) {
      expect(getComputedStyle(row).display).not.toBe("contents");
      // Tiles stay; the Reel links themselves are still hidden by their Clip badge where it shows.
      for (const tile of row.children) expect(visible(tile), tile.id).toBe(true);
    }
  });
  it("direct/shared playback, Search and messages do not acquire a new redirect", () => {
    const s = session();
    for (const href of [
      "/reel/shared/?igsh=chosen#part",
      "/p/ordinary/?img_index=2",
      "/direct/inbox/",
      "/explore/?q=chosen",
      "/explore/tags/boats/",
      "/reels/audio/123/",
    ]) {
      expect(
        s.evaluate(
          DEFAULT_SETTINGS_V2,
          new URL(href, "https://www.instagram.com"),
        ).kind,
        href,
      ).toBe("apply");
    }
    // The plural /reels/<code>/ viewer opens the same Reel at its singular shared address
    // ("shared" is a code by the viewer pattern), keeping the share query and fragment.
    expect(
      s.evaluate(
        DEFAULT_SETTINGS_V2,
        new URL("/reels/shared/?igsh=chosen#part", "https://www.instagram.com"),
      ),
    ).toEqual({ kind: "redirect", url: "https://www.instagram.com/reel/shared/?igsh=chosen#part" });
  });
});
