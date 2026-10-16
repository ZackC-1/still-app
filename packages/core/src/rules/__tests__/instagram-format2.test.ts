import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEnginePageSession, type EnginePageSession } from "../engine.js";
import { INSTAGRAM_EXPLORE_LAYOUT, INSTAGRAM_EXPLORE_MARKER, INSTAGRAM_PROFILE_MARKER, INSTAGRAM_REELS_LAYOUT, INSTAGRAM_REELS_RULES, isInstagramExploreHub, isInstagramProfilePage } from "../instagram.js";
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
  [
    // Explore's grid: every tile links to /p/<code>/; Reel tiles carry a looping video and an SVG
    // titled "Reel" (ISS-0038, ISS-0064). Explore itself and its other posts stay.
    "instagram-explore.html",
    ["explore-reel-1", "explore-reel-2", "explore-reel-3", "explore-reel-4", "explore-reel-5",
      "explore-reel-6", "explore-reel-7", "explore-reel-8", "explore-reel-9", "explore-reel-10"],
    ["explore-grid"],
  ],
] as const;
const visible = (node: Element) => {
  for (let at: Element | null = node; at; at = at.parentElement)
    if (getComputedStyle(at).display === "none") return false;
  return true;
};
function render(file: string) {
  // The content script's marker hook sets the profile mark from the address; the profile fixture
  // stands for a profile page.
  document.documentElement.toggleAttribute(INSTAGRAM_PROFILE_MARKER.attribute, file === "instagram-profile.html");
  document.documentElement.toggleAttribute(INSTAGRAM_EXPLORE_MARKER.attribute, file === "instagram-explore.html");
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
  document.documentElement.removeAttribute(INSTAGRAM_PROFILE_MARKER.attribute);
  document.documentElement.removeAttribute(INSTAGRAM_EXPLORE_MARKER.attribute);
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
  it("a grid Instagram is virtualizing (non-zero inline padding) keeps its own layout; only Reel links hide", () => {
    render("instagram-profile.html");
    const grid = document.getElementById("profile-grid")!;
    grid.setAttribute("style", "display: flex; flex-direction: column; padding-bottom: 0px; padding-top: 3892px; position: relative;");
    session().applyDom(DEFAULT_SETTINGS_V2, new URL("https://www.instagram.com/someuser/"), document);
    expect(getComputedStyle(grid).flexWrap).not.toBe("wrap");
    for (const row of grid.children) {
      expect(getComputedStyle(row).display).not.toBe("contents");
      for (const tile of row.children) expect(visible(tile), tile.id).toBe(true);
    }
    // The badge rule still hides the Reel links themselves (holes, as before this change).
    expect(visible(document.querySelector('#grid-reel-1 a')!)).toBe(false);
    grid.setAttribute("style", "display: flex; flex-direction: column; padding-bottom: 7784px; padding-top: 0px; position: relative;");
    expect(getComputedStyle(grid).flexWrap).not.toBe("wrap");
    // Back at the top with nothing unmounted: the wrap layout returns.
    grid.setAttribute("style", "display: flex; flex-direction: column; padding-bottom: 0px; padding-top: 0px; position: relative;");
    expect(getComputedStyle(grid).flexWrap).toBe("wrap");
    expect(visible(document.getElementById("grid-reel-1")!)).toBe(false);
  });
  it("the tab rule never hides a wrapper that also holds another tab", () => {
    render("instagram-profile.html");
    const tabs = document.getElementById("profile-tabs")!;
    tabs.innerHTML = '<div id="all-tabs"><a href="/someuser/">Posts</a><a href="/someuser/reels/" id="lone-reels">Reels</a></div>';
    session().applyDom(DEFAULT_SETTINGS_V2, new URL("https://www.instagram.com/someuser/"), document);
    expect(visible(document.getElementById("all-tabs")!)).toBe(true);
    expect(visible(document.getElementById("lone-reels")!)).toBe(false);
  });
  it("the profile mark follows the address: a profile's pages and its post dialogs, web app hosts only", () => {
    const at = (href: string) => isInstagramProfilePage(new URL(href));
    for (const href of ["https://www.instagram.com/someuser/", "https://instagram.com/some.user_9", "https://m.instagram.com/someuser/tagged/",
      "https://www.instagram.com/me/saved/all-posts/", "https://www.instagram.com/someuser/p/C0de/", "https://www.instagram.com/someuser/reel/C0de/"])
      expect(at(href), href).toBe(true);
    for (const href of ["https://www.instagram.com/", "https://www.instagram.com/explore/", "https://www.instagram.com/direct/inbox/",
      "https://www.instagram.com/p/C0de/", "https://www.instagram.com/reel/C0de/", "https://www.instagram.com/someuser/p/C0de/c/1/",
      "https://www.instagram.com/reels/", "https://www.instagram.com/stories/someuser/", "https://www.instagram.com/accounts/edit/",
      "https://www.instagram.com/someuser/reels/", "https://about.instagram.com/features/", "https://www.instagram.com/Explore/"])
      expect(at(href), href).toBe(false);
  });
  it("Explore: Reel tiles go whole and only rows holding a Reel become one measurable line, only with the mark", () => {
    render("instagram-explore.html");
    const s = session(), url = new URL("https://www.instagram.com/explore/");
    const grid = document.getElementById("explore-grid")!;
    // A row with no Reel at all (a later batch): it must keep Instagram's own layout.
    const plain = document.createElement("div");
    plain.setAttribute("style", "--x-gridTemplateColumns: repeat(4, 1fr);");
    plain.innerHTML = ["Pl1", "Pl2", "Pl3", "Pl4"].map((code) =>
      `<div id="plain-${code}"><div style="--x-width: 100%;"><a role="link" href="/p/${code}/"><div class="tile"></div></a></div></div>`).join("");
    grid.append(plain);
    const rows = [...grid.children] as HTMLElement[];
    const reelRows = rows.slice(0, 4);
    s.applyDom(DEFAULT_SETTINGS_V2, url, document);
    const assertLaidOut = () => {
      // The column is never rewritten, and no row ever stops being a box (ISS-0053).
      expect(getComputedStyle(grid).display).not.toBe("grid");
      for (const row of rows) expect(getComputedStyle(row).display).not.toBe("contents");
      for (const row of reelRows) {
        expect(getComputedStyle(row).display).toBe("flex");
        // Each row states four columns, so it wraps at four posts a line rather than squeezing.
        expect(getComputedStyle(row).flexWrap).toBe("wrap");
        // A row of only Reels keeps a box a ResizeObserver can report.
        expect(getComputedStyle(row).minHeight).toBe("1px");
      }
      expect(getComputedStyle(plain).display).not.toBe("flex");
      for (const tile of plain.children) expect(visible(tile), tile.id).toBe(true);
      for (const id of ["explore-reel-1", "explore-reel-7", "explore-reel-10"]) expect(visible(document.getElementById(id)!), id).toBe(false);
      for (const id of ["keep-explore-1", "keep-explore-5", "keep-explore-6"]) {
        const tile = document.getElementById(id)!;
        expect(visible(tile), id).toBe(true);
        expect(getComputedStyle(tile).overflow, id).toBe("hidden");
      }
    };
    assertLaidOut();
    // A row that states no column count stays one line (it cannot know where to wrap).
    const stated = reelRows[0]!.getAttribute("style")!;
    reelRows[0]!.removeAttribute("style");
    expect(getComputedStyle(reelRows[0]!).display).toBe("flex");
    expect(getComputedStyle(reelRows[0]!).flexWrap).toBe("nowrap");
    reelRows[0]!.setAttribute("style", stated);
    // A column Instagram is virtualizing keeps the same layout: no switch back to holes.
    grid.setAttribute("style", "display: flex; flex-direction: column; padding-bottom: 7784px; padding-top: 4060px; position: relative;");
    assertLaidOut();
    // The mark is the only scope: without it Explore keeps Instagram's own rows and its Reels.
    document.documentElement.removeAttribute(INSTAGRAM_EXPLORE_MARKER.attribute);
    for (const row of rows) expect(getComputedStyle(row).display).not.toBe("flex");
    expect(visible(document.getElementById("explore-reel-1")!)).toBe(true);
    document.documentElement.setAttribute(INSTAGRAM_EXPLORE_MARKER.attribute, "");
    assertLaidOut();
    // Off (the service or the Reels core): everything back, live.
    for (const settings of [
      { ...DEFAULT_SETTINGS_V2, services: { ...DEFAULT_SETTINGS_V2.services, instagram: false } },
      { ...DEFAULT_SETTINGS_V2, sites: { ...DEFAULT_SETTINGS_V2.sites, "instagram.reels": false } },
    ]) {
      s.applyDom(settings, url, document);
      for (const row of rows) {
        expect(getComputedStyle(row).display).not.toBe("flex");
        for (const tile of row.children) expect(visible(tile), tile.id).toBe(true);
      }
      s.applyDom(DEFAULT_SETTINGS_V2, url, document);
      assertLaidOut();
    }
    // The style text carries the Explore layout after the hides, under the same feature class.
    const text = document.head.querySelector("style")!.textContent!;
    for (const rule of INSTAGRAM_EXPLORE_LAYOUT) expect(text).toContain(`:is(${rule.selector}){${rule.declarations}}`);
    expect(text).not.toContain("display:contents!important;");
  });
  it("an Explore Reel tile is told by its video alone, whatever language its badge is in", () => {
    render("instagram-explore.html");
    for (const svg of document.querySelectorAll('#explore-grid svg[aria-label="Reel"]')) svg.setAttribute("aria-label", "Bobina");
    session().applyDom(DEFAULT_SETTINGS_V2, new URL("https://www.instagram.com/explore/"), document);
    expect(visible(document.getElementById("explore-reel-1")!)).toBe(false);
    expect(visible(document.getElementById("keep-explore-1")!)).toBe(true);
  });
  it("nothing in a post viewer over Explore is ever a grid row or a hidden tile", () => {
    render("instagram-explore.html");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = `<div id="dialog-column"><div id="dialog-row"><div id="dialog-tile"><div><a href="/p/More0001/"><video loop></video></a></div></div></div></div>`;
    document.body.append(dialog);
    session().applyDom(DEFAULT_SETTINGS_V2, new URL("https://www.instagram.com/p/ExReel0001/"), document);
    for (const id of ["dialog-column", "dialog-row", "dialog-tile"]) {
      const node = document.getElementById(id)!;
      expect(getComputedStyle(node).display, id).not.toBe("flex");
      expect(visible(node), id).toBe(true);
    }
  });
  it("the Explore mark stays while a tile is open over Explore, and goes on any other address", () => {
    const owns = (href: string, marked: boolean) => INSTAGRAM_EXPLORE_MARKER.owns({
      ownerDocument: { defaultView: { location: new URL(href) } },
      hasAttribute: (name: string) => marked && name === INSTAGRAM_EXPLORE_MARKER.attribute,
    } as unknown as Element);
    expect(owns("https://www.instagram.com/explore/", false)).toBe(true);
    // A tile opened over Explore keeps the mark, so the grid behind the dialog stays as it was.
    expect(owns("https://www.instagram.com/p/C0de/", true)).toBe(true);
    expect(owns("https://www.instagram.com/someuser/p/C0de/", true)).toBe(true);
    // A post opened from anywhere else never gains it.
    expect(owns("https://www.instagram.com/p/C0de/", false)).toBe(false);
    // Any other address clears it.
    for (const href of ["https://www.instagram.com/", "https://www.instagram.com/explore/search/", "https://www.instagram.com/someuser/",
      "https://www.instagram.com/reel/C0de/", "https://about.instagram.com/p/C0de/"])
      expect(owns(href, true), href).toBe(false);
  });
  it("the Explore mark follows the address: the Explore hub on the web app hosts only", () => {
    for (const href of ["https://www.instagram.com/explore/", "https://instagram.com/explore", "https://m.instagram.com/explore/?hl=fr"])
      expect(isInstagramExploreHub(new URL(href)), href).toBe(true);
    for (const href of ["https://www.instagram.com/", "https://www.instagram.com/explore/search/", "https://www.instagram.com/explore/tags/x/",
      "https://www.instagram.com/explore/people/", "https://www.instagram.com/p/C0de/", "https://about.instagram.com/explore/"])
      expect(isInstagramExploreHub(new URL(href)), href).toBe(false);
    const hides = INSTAGRAM_REELS_RULES.surfaces[0]!;
    if (hides.action !== "hide") throw new Error("Reels data only hides");
    expect(hides.selectors).toContain(INSTAGRAM_EXPLORE_MARKER.ruleSelector);
  });
  it("the packaged tile hide and the compiled layout select the same tile boxes", () => {
    // The layout ships in code and the hide in rule data: if either drifts, holes come back.
    const tileBoxes = INSTAGRAM_REELS_LAYOUT[2]!.selector;
    const hides = INSTAGRAM_REELS_RULES.surfaces[0]!;
    if (hides.action !== "hide") throw new Error("Reels data only hides");
    expect(hides.selectors.filter((selector) => selector.startsWith(`${tileBoxes}:has(`))).toHaveLength(1);
    // ...and it is the selector the profile mark exists for, so the content script sets the mark.
    expect(hides.selectors).toContain(INSTAGRAM_PROFILE_MARKER.ruleSelector);
    // Explore: the hidden tile boxes are exactly tile boxes the Explore layout lays out, and the
    // hide is the selector the Explore mark exists for.
    const exploreTiles = INSTAGRAM_EXPLORE_LAYOUT[1]!.selector;
    expect(hides.selectors.filter((selector) => selector.startsWith(`${exploreTiles}:has(`))).toEqual([INSTAGRAM_EXPLORE_MARKER.ruleSelector]);
    expect(exploreTiles).toBe(`${INSTAGRAM_EXPLORE_LAYOUT[0]!.selector} > div`);
    expect(INSTAGRAM_REELS_LAYOUT).toEqual(expect.arrayContaining([...INSTAGRAM_EXPLORE_LAYOUT]));
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
  it("profile rules stay off pages without the profile mark (Home, Explore, posts, search)", () => {
    render("instagram-profile.html");
    document.documentElement.removeAttribute(INSTAGRAM_PROFILE_MARKER.attribute);
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
    // Both aliases open the same shared item; the site chooses its canonical address.
    expect(s.evaluate(DEFAULT_SETTINGS_V2,
      new URL("/reels/shared/?igsh=chosen#part", "https://www.instagram.com")).kind).toBe("apply");
  });
});
