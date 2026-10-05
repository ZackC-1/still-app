import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FEATURE_REGISTRY, type BenefitAccessSnapshot, type BenefitId, type SettingsV2 } from "@still/shared-types";
import { ACCESS_BENEFITS, ACCESS_HOSTS, IMPLEMENTED_PRO_FEATURES, accessCapabilities, initialAccessSnapshot } from "../../entitlement/access-policy.js";
import { createEnginePageSession, type EnginePageSession } from "../engine.js";
import { INSTAGRAM_EXTRAS, INSTAGRAM_SEARCH_ENTRY } from "../instagram-extras.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../packaged.js";
import { DEFAULT_SETTINGS_V2 } from "./format2-fixtures.js";
import { extrasFixture, fixtureIds } from "./extras-fixtures.js";

// P4: Instagram's four Still Pro extras (Explore recommendations, Stories and Highlights, Suggested
// accounts, Threads links) through the SHIPPED packaged rule set and compiled route table. Paid-on
// cases use the real implementation table through accessCapabilities({ paidMode: true, host });
// the shipped paid-off defaults must leave every one of them inert. Selector families are
// unverified candidates checked against the synthetic fixtures in tests/fixtures/extras/.

const IG = "https://www.instagram.com";
const IG_PRO = ["instagram.explore", "instagram.stories", "instagram.suggested", "instagram.threads"] as const;
type IgPro = (typeof IG_PRO)[number];
const packaged = admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!;
const ALL_ON: SettingsV2 = { ...DEFAULT_SETTINGS_V2, sites: Object.fromEntries(FEATURE_REGISTRY.map((feature) => [feature.id, true])) as SettingsV2["sites"] };
const onlyPro = (...keep: IgPro[]): SettingsV2 => ({ ...ALL_ON, sites: { ...ALL_ON.sites, ...Object.fromEntries(IG_PRO.map((id) => [id, keep.includes(id)])) } });
const savedOff = (id: string): SettingsV2 => ({ ...ALL_ON, sites: { ...ALL_ON.sites, [id]: false } });

function paidOn(host: (typeof ACCESS_HOSTS)[number] = "chromium"): { access: BenefitAccessSnapshot; capabilities: ReadonlySet<BenefitId> } {
  const capabilities = accessCapabilities({ paidMode: true, host });
  const base = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  return { access: { ...base, states: { ...base.states, ...Object.fromEntries(IG_PRO.map((id) => [id, "purchased"])) } }, capabilities };
}

const sessions: EnginePageSession[] = [];
const session = () => { const created = createEnginePageSession(packaged); sessions.push(created); return created; };
const route = (href: string, settings: SettingsV2 = ALL_ON, opts: ReturnType<typeof paidOn> | Record<string, never> = paidOn()) =>
  session().evaluate(settings, new URL(href), opts);
const redirect = (path: string) => ({ kind: "redirect", url: new URL(path, IG).href });
const APPLY = { kind: "apply" };

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "site-theme";
});
afterEach(() => { for (const created of sessions.splice(0)) created.stop?.(); });

describe("Instagram extras: implementation table and dormancy gate", () => {
  it("lists all four Instagram extras as implemented on every host", () => {
    for (const host of ACCESS_HOSTS) for (const id of IG_PRO) expect(IMPLEMENTED_PRO_FEATURES[host], `${host}:${id}`).toContain(id);
  });

  it("paid off: none of the four is a capability on any host (they stay locked and inert)", () => {
    for (const host of [undefined, ...ACCESS_HOSTS]) {
      const supported = accessCapabilities({ paidMode: false, host });
      for (const id of IG_PRO) expect(supported.has(id), `${host}:${id}`).toBe(false);
    }
    const access = initialAccessSnapshot();
    for (const id of IG_PRO) expect(access.states[id]).toBe("unsupported");
  });

  it("paid off, every extra saved On: no route fires, and only the free Reels feature applies", () => {
    for (const path of ["/explore/", "/stories/inventeduser1/900000000001/", "/stories/highlights/900000000000001/", "/explore/people/"]) {
      const engine = session();
      expect(engine.evaluate(ALL_ON, new URL(path, IG)), path).toEqual(APPLY);
      expect(engine.effectiveFeatures!()).toEqual(["instagram.reels"]);
    }
  });
});

describe("Instagram extras routes (paid on through the real implementation table)", () => {
  it("Explore: the exact hub opens the intentional search entry, silently", () => {
    expect(INSTAGRAM_SEARCH_ENTRY).toBe("/explore/search/");
    for (const path of ["/explore/", "/explore", "/explore/?hl=en", "/explore/#grid"])
      expect(route(`${IG}${path}`), path).toEqual(redirect("/explore/search/"));
  });

  it("Explore: search, results, /popular/, tags, locations and every nested path stay usable", () => {
    for (const path of [
      "/explore/search/", "/explore/search", "/explore/search/keyword/?q=invented", "/explore/?q=invented",
      "/explore/tags/inventedtag/", "/explore/locations/", "/explore/locations/900000001/invented-place/",
      "/popular/", "/popular/inventedtopic/", "/explore/reels/", "/explorer/", "/inventeduser/explore/",
    ]) expect(route(`${IG}${path}`), path).toEqual(APPLY);
  });

  it("Stories: story viewer addresses, shared links included, go to same-site Home", () => {
    for (const path of [
      "/stories/inventeduser1/", "/stories/inventeduser1", "/stories/inventeduser1/900000000001/",
      "/stories/inventeduser1/900000000001/?utm_source=ig_story_item_share&igsh=invented", "/stories/",
    ]) expect(route(`${IG}${path}`), path).toEqual(redirect("/"));
  });

  it("Stories: profiles, posts, messages and look-alike paths stay", () => {
    for (const path of ["/", "/inventeduser1/", "/storiesx/", "/inventeduser1/stories/", "/p/InvF6/", "/direct/inbox/"])
      expect(route(`${IG}${path}`), path).toEqual(APPLY);
  });

  it("Highlights links go to same-site Home too (V3-D-252; owner question Q8 still open)", () => {
    for (const path of ["/stories/highlights/900000000000001/", "/stories/highlights/900000000000001", "/stories/highlights/900000000000001/?igsh=invented"])
      expect(route(`${IG}${path}`), path).toEqual(redirect("/"));
    expect(route(`${IG}/stories/highlights/900000000000001/`, savedOff("instagram.stories"))).toEqual(APPLY);
    // Home is never routed again.
    expect(route(`${IG}/`)).toEqual(APPLY);
  });

  it("Suggested accounts: /explore/people/ (and anything under it) goes Home", () => {
    for (const path of ["/explore/people/", "/explore/people", "/explore/people/suggested/"])
      expect(route(`${IG}${path}`), path).toEqual(redirect("/"));
    for (const path of ["/explore/peoplex/", "/inventedsuggest1/"]) expect(route(`${IG}${path}`), path).toEqual(APPLY);
  });

  it("never loops: no route's destination is itself routed, by the core or any extra", () => {
    const samples = ["/explore/", "/stories/inventeduser1/", "/stories/highlights/900000000000001/", "/explore/people/"];
    for (const path of samples) {
      const first = route(`${IG}${path}`);
      expect(first.kind, path).toBe("redirect");
      const landing = (first as { url: string }).url;
      expect(route(landing), `${path} -> ${landing}`).toEqual(APPLY);
      // Directly through the compiled table too: no entry matches any entry's destination.
      for (const entry of INSTAGRAM_EXTRAS.routes) {
        const destination = entry.destination(new URL(path, IG));
        for (const other of INSTAGRAM_EXTRAS.routes) expect(other.matches(destination), `${entry.feature} -> ${destination.pathname}`).toBe(false);
      }
    }
  });

  it("predicates never overlap, so the first-match table cannot hide a later entry", () => {
    const probes = ["/explore/", "/explore", "/stories/x/", "/stories/highlights/1/", "/explore/people/", "/explore/people/x/", "/explore/search/", "/"];
    for (const path of probes) {
      const url = new URL(path, IG);
      expect(INSTAGRAM_EXTRAS.routes.filter((entry) => entry.matches(url)).length, path).toBeLessThanOrEqual(1);
    }
  });

  it("each route runs only while its own feature is effective", () => {
    const cases: [IgPro, string][] = [["instagram.explore", "/explore/"], ["instagram.stories", "/stories/inventeduser1/"], ["instagram.suggested", "/explore/people/"]];
    for (const [feature, path] of cases) {
      expect(route(`${IG}${path}`, savedOff(feature)), `${feature} saved Off`).toEqual(APPLY);
      expect(route(`${IG}${path}`, onlyPro(feature)), `${feature} alone`).toEqual(redirect(feature === "instagram.explore" ? "/explore/search/" : "/"));
      for (const [other, otherPath] of cases) if (other !== feature)
        expect(route(`${IG}${otherPath}`, onlyPro(feature)), `${feature} alone leaves ${otherPath}`).toEqual(APPLY);
    }
    // Instagram off, Still off, or the host paused: nothing routes.
    for (const settings of [
      { ...ALL_ON, services: { ...ALL_ON.services, instagram: false } },
      { ...ALL_ON, globalOn: false },
      { ...ALL_ON, pauses: ["instagram.com"] },
    ] as SettingsV2[]) for (const [, path] of cases) expect(route(`${IG}${path}`, settings).kind, path).not.toBe("redirect");
  });

  it("works with the free Reels core Off (independent controls)", () => {
    const reelsOff = savedOff("instagram.reels");
    expect(route(`${IG}/explore/`, reelsOff)).toEqual(redirect("/explore/search/"));
    expect(route(`${IG}/stories/inventeduser1/`, reelsOff)).toEqual(redirect("/"));
    expect(route(`${IG}/reels/`, reelsOff)).toEqual(APPLY);
  });

  it("the free Reels routes and continuation run first and are never shadowed", () => {
    expect(route(`${IG}/reels/`)).toEqual(redirect("/"));
    expect(route(`${IG}/reels/InvReel1/?igsh=x`)).toEqual(redirect("/reel/InvReel1/?igsh=x"));
    expect(route(`${IG}/reel/InvReel1/`)).toEqual(APPLY);
    // The Reels viewer advancing on its own is still stopped with every extra On.
    const engine = session();
    const on = paidOn();
    const to = new URL(`${IG}/reels/InvReel2/`);
    engine.evaluate(ALL_ON, to, on);
    expect(engine.reelContinuation!(new URL(`${IG}/reels/InvReel1/`), to)).toBe(`${IG}/`);
  });

  it("an Instagram route never runs on another service", () => {
    for (const href of ["https://www.youtube.com/explore/", "https://www.facebook.com/explore/people/", "https://www.youtube.com/stories/x/"])
      expect(route(href).kind, href).not.toBe("redirect");
  });

  it("routes on every host (each host's capabilities include the feature)", () => {
    for (const host of ACCESS_HOSTS) expect(route(`${IG}/explore/`, ALL_ON, paidOn(host)), host).toEqual(redirect("/explore/search/"));
  });
});

/** Render a synthetic fixture's body and apply the packaged session at `path`. */
function render(file: string, path: string, settings: SettingsV2 = ALL_ON, opts: ReturnType<typeof paidOn> | Record<string, never> = paidOn()) {
  // One live session per page, as in a tab: the previous one stops and removes what it owned.
  for (const created of sessions.splice(0)) created.stop?.();
  expect(document.head.querySelector("style"), "the previous session removed its owned style").toBeNull();
  document.body.innerHTML = new DOMParser().parseFromString(extrasFixture(file), "text/html").body.innerHTML;
  const engine = session();
  engine.applyDom(settings, new URL(path, IG), document, opts);
  return engine;
}
const shown = (id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  for (let at: Element | null = node; at; at = at.parentElement) if (getComputedStyle(at).display === "none") return false;
  return true;
};
const keeps = (file: string) => fixtureIds(extrasFixture(file), "keep-").filter((id) => !document.getElementById(id)?.hasAttribute("hidden"));

describe("Instagram extras hide surfaces on the synthetic fixtures", () => {
  const pages: { feature: IgPro; file: string; path: string; hidden: string[]; visible?: string[] }[] = [
    { feature: "instagram.explore", file: "ig-explore-mobile.html", path: "/explore/search/", hidden: ["target-mobile-explore-grid"] },
    // A tag page's own grid and the search panel are deliberate content: nothing on it is hidden.
    { feature: "instagram.explore", file: "ig-explore.html", path: "/explore/tags/inventedtag/", hidden: [], visible: ["target-explore-grid", "target-nav-explore"] },
    { feature: "instagram.stories", file: "ig-stories.html", path: "/", hidden: ["target-home-tray", "target-highlights"] },
    { feature: "instagram.suggested", file: "ig-suggested.html", path: "/", hidden: ["target-sidebar-suggestions", "target-infeed-carousel", "target-profile-similar"] },
    { feature: "instagram.threads", file: "ig-threads.html", path: "/inventeduser/", hidden: ["target-threads-badge-com-www", "target-threads-badge-com", "target-threads-badge-net-www", "target-threads-badge-net"] },
  ];

  for (const { feature, file, path, hidden, visible = [] } of pages) {
    it(`${feature} on ${file} at ${path}: hides only its targets, keeps everything else, and Off restores`, () => {
      render(file, path);
      for (const id of hidden) expect(shown(id), `${id} hidden`).toBe(false);
      for (const id of [...keeps(file), ...visible]) expect(shown(id), `${id} kept`).toBe(true);
      // Hidden, never removed.
      for (const id of hidden) expect(document.getElementById(id)).not.toBeNull();

      // Only this feature On (the other three Off): the same targets hide.
      render(file, path, onlyPro(feature));
      for (const id of hidden) expect(shown(id), `${id} hidden alone`).toBe(false);
      // Saved Off restores, with no class or rule of this feature left.
      render(file, path, savedOff(feature));
      for (const id of hidden) expect(shown(id), `${id} restored`).toBe(true);
      expect(document.documentElement.className).not.toMatch(new RegExp(feature.replace(".", "-")));
      // Shipped paid-off defaults: nothing of the extras applies at all.
      render(file, path, ALL_ON, {});
      for (const id of [...hidden, ...visible]) expect(shown(id), `${id} dormant`).toBe(true);
      expect(document.head.querySelector("style")?.textContent ?? "").not.toMatch(/threads\.|stories\/highlights|explore\/people|type="search"/);
    });
  }

  it("each feature alone hides nothing that belongs to another control", () => {
    for (const { feature: owner, file, path, hidden } of pages) for (const feature of IG_PRO) {
      if (feature === owner) continue;
      render(file, path, onlyPro(feature));
      for (const id of hidden) expect(shown(id), `${feature} must leave ${owner}'s #${id}`).toBe(true);
    }
  });
});

describe("Threads links: exact hosts only", () => {
  const selectors = INSTAGRAM_EXTRAS.surfaces.find((surface) => surface.feature === "instagram.threads")!.selectors;
  const matched = (href: string) => {
    document.body.innerHTML = "";
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    document.body.append(anchor);
    return selectors.some((selector) => anchor.matches(selector));
  };

  it("matches threads.com and threads.net, with and without www., on any path or query", () => {
    for (const host of ["threads.com", "www.threads.com", "threads.net", "www.threads.net", "WWW.Threads.COM"])
      for (const rest of ["/@inventeduser", "/", "", "?xmt=invented"])
        for (const scheme of ["https", "http"]) expect(matched(`${scheme}://${host}${rest}`), `${scheme}://${host}${rest}`).toBe(true);
  });

  it("never matches look-alike hosts, Instagram paths, hashtags, captions or wrapped links", () => {
    for (const href of [
      "https://www.threads.com.invented.example/@inventeduser", "https://threads.net.invented.example/",
      "https://notthreads.com/@inventeduser", "https://mythreads.net/", "https://threads.community/",
      "https://threads.co/", "https://www.threads.comx/", "https://sub.threads.com/", "https://threads.com:8443/",
      "/threadsapp/", "/explore/tags/threads/", "https://www.instagram.com/threads/",
      "https://l.instagram.com/?u=https%3A%2F%2Fwww.threads.com%2F%40inventeduser",
      "https://www.instagram.com/?next=https://www.threads.com/",
    ]) expect(matched(href), href).toBe(false);
  });
});
