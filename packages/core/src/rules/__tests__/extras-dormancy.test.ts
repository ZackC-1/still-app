import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURE_REGISTRY, type BenefitAccessSnapshot, type BenefitId, type FeatureId, type ServiceId, type SettingsV2, type SignedRuleSetV2 } from "@still/shared-types";
import { ACCESS_BENEFITS, accessCapabilitiesForTest, initialAccessSnapshot, type AccessHost } from "../../entitlement/access-policy.js";
import { createEnginePageSession, createFormat2PageSessionForTest, type EnginePageSession } from "../engine.js";
import { exactPath, type ExtrasRoute, type ExtrasRouteTable, type MarkerAdapter } from "../extras.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../packaged.js";
import { createMarkerHook } from "../../content/markers.js";
import { DEFAULT_SETTINGS_V2 } from "./format2-fixtures.js";
import pins from "./free-surface-pins.json";

// A4 dormancy at unit level for all 12 Still Pro controls, with SYNTHETIC extras: a hide surface,
// a compiled route and a marker for every Pro feature, every saved choice On. With the shipped
// paid-off defaults nothing of them applies: no feature class, no extras CSS (the owned style text
// equals the free-only text byte for byte), no redirect, no marker, and the route predicates are
// never even called. A paid-on control through the explicit test seams proves the synthetic extras
// are real, so the dormancy result is not vacuous.

const PRO = FEATURE_REGISTRY.filter((feature) => feature.tier === "pro");
const SERVICES = ["youtube", "instagram", "facebook"] as const;
const PAGE: Record<(typeof SERVICES)[number], string> = {
  youtube: "https://www.youtube.com/", instagram: "https://www.instagram.com/", facebook: "https://www.facebook.com/",
};
const slug = (id: string) => id.replace(".", "-");
const packaged = admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!;

/** The packaged set plus one synthetic Pro hide surface per feature (one target class and one marker). */
function withSyntheticExtras(): SignedRuleSetV2 {
  const copy = structuredClone(packaged) as unknown as { services: Record<string, { matches: string[]; surfaces: unknown[] }> };
  for (const feature of PRO) {
    copy.services[feature.service]!.surfaces.push({ id: `synthetic-extra-${slug(feature.id)}`, feature: feature.id, action: "hide",
      selectors: [`.synthetic-${slug(feature.id)}`, `[data-still-synthetic-${slug(feature.id)}]`] });
  }
  return copy as unknown as SignedRuleSetV2;
}
const routeCalls = vi.fn();
const ROUTES: ExtrasRouteTable = Object.fromEntries(SERVICES.map((service) => [service, PRO.filter((feature) => feature.service === service).map((feature): ExtrasRoute => ({
  feature: feature.id,
  matches: (url) => { routeCalls(feature.id); return exactPath(url.pathname, `/synthetic-${slug(feature.id)}`); },
  destination: (url) => new URL(`/synthetic-landing-${slug(feature.id)}`, url.origin),
}))]));
const MARKERS: MarkerAdapter[] = PRO.map((feature) => ({
  feature: feature.id, attribute: `data-still-synthetic-${slug(feature.id)}`, candidates: `.mark-${slug(feature.id)}`,
  ruleSelector: `[data-still-synthetic-${slug(feature.id)}]`, owns: () => true,
}));
const ALL_ON: SettingsV2 = { ...DEFAULT_SETTINGS_V2, sites: Object.fromEntries(FEATURE_REGISTRY.map((feature) => [feature.id, true])) as SettingsV2["sites"] };
const PRO_IDS: readonly BenefitId[] = PRO.map((feature) => feature.id);
const everyPro: Record<AccessHost, readonly BenefitId[]> = { chromium: PRO_IDS, firefox: PRO_IDS, safari: PRO_IDS };
const paidOn = (): { access: BenefitAccessSnapshot; capabilities: ReadonlySet<BenefitId> } => {
  const base = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  return {
    access: { ...base, states: { ...base.states, ...Object.fromEntries(PRO.map((feature) => [feature.id, "purchased"])) } },
    capabilities: accessCapabilitiesForTest({ paidMode: true }, everyPro),
  };
};

const sessions: EnginePageSession[] = [];
const session = (set: SignedRuleSetV2, routes?: ExtrasRouteTable) => {
  const created = routes ? createFormat2PageSessionForTest(set, routes) : createEnginePageSession(set);
  sessions.push(created);
  return created;
};
const ownedStyles = () => [...document.head.querySelectorAll("style")];
const featureClasses = () => [...document.documentElement.classList].filter((name) => name.startsWith("still-feature-"));
/** "Today's" free-only owned text: one rule per pinned free selector under the core's class. */
function freeOnlyText(service: (typeof SERVICES)[number], scope: string): string {
  const pin = Object.values(pins.surfaces).find((surface) => surface.service === service)!;
  return pin.selectors.map((selector) => `.${scope}-${slug(pin.feature)} :is(${selector}){display:none!important}`).join("\n");
}
const scopeOf = (core: string) => featureClasses().find((name) => name.endsWith(`-${slug(core)}`))!.slice(0, -(slug(core).length + 1));

beforeEach(() => {
  routeCalls.mockClear();
  document.head.innerHTML = "";
  document.documentElement.className = "site-theme";
  document.body.innerHTML = PRO.map((feature) =>
    `<div class="synthetic-${slug(feature.id)}" id="target-${slug(feature.id)}"></div><div class="mark-${slug(feature.id)}" id="mark-${slug(feature.id)}"></div>`).join("");
});
afterEach(() => { for (const created of sessions.splice(0)) created.stop?.(); });

describe("A4 dormancy at unit level: all 12 Still Pro controls with synthetic extras", () => {
  for (const service of SERVICES) {
    const core = FEATURE_REGISTRY.find((feature) => feature.service === service && feature.tier === "free")!.id;
    const pros = PRO.filter((feature) => feature.service === service);

    it(`${service}: shipped paid-off defaults apply no extras effect, only the free core`, () => {
      const engine = session(withSyntheticExtras(), ROUTES);
      const hook = createMarkerHook(document, MARKERS);
      const url = new URL(PAGE[service]);
      engine.applyDom(ALL_ON, url, document);
      hook.reconcile(engine.effectiveFeatures!());
      expect(engine.effectiveFeatures!()).toEqual([core]);
      // No feature class for any Pro feature; only the core's.
      expect(featureClasses()).toHaveLength(1);
      for (const feature of pros) expect(featureClasses().some((name) => name.endsWith(slug(feature.id)))).toBe(false);
      // Owned style text is byte-identical to the free-only text.
      expect(ownedStyles()).toHaveLength(1);
      expect(ownedStyles()[0]!.textContent).toBe(freeOnlyText(service, scopeOf(core)));
      for (const feature of pros) {
        expect(ownedStyles()[0]!.textContent).not.toContain(`synthetic-${slug(feature.id)}`);
        expect(getComputedStyle(document.getElementById(`target-${slug(feature.id)}`)!).display).not.toBe("none");
        // No redirect from the feature's own route, and its predicate is never consulted.
        const routeUrl = new URL(`/synthetic-${slug(feature.id)}`, url.origin);
        expect(engine.evaluate(ALL_ON, routeUrl)).toEqual({ kind: "apply" });
      }
      expect(routeCalls).not.toHaveBeenCalled();
      // No marker attributes anywhere.
      hook.reconcile(engine.effectiveFeatures!());
      expect(document.querySelectorAll("[data-still-synthetic-youtube-comments], [data-still-synthetic-instagram-threads], [data-still-synthetic-facebook-videos]")).toHaveLength(0);
      for (const marker of MARKERS) expect(document.querySelector(`[${marker.attribute}]`), marker.attribute).toBeNull();
      hook.stop();
    });

    it(`${service}: paid-on control through the test seams applies every synthetic extra, and returning to defaults removes them`, () => {
      const engine = session(withSyntheticExtras(), ROUTES);
      const hook = createMarkerHook(document, MARKERS);
      const url = new URL(PAGE[service]);
      const on = paidOn();
      engine.applyDom(ALL_ON, url, document, on);
      hook.reconcile(engine.effectiveFeatures!());
      // Same set, compared sorted: the packaged YouTube extras now come before the synthetic ones
      // in plan order, so plan order differs from registry order.
      expect([...engine.effectiveFeatures!()].sort()).toEqual([core, ...pros.map((feature) => feature.id)].sort());
      expect(engine.effectiveFeatures!()[0]).toBe(core);
      for (const feature of pros) {
        expect(getComputedStyle(document.getElementById(`target-${slug(feature.id)}`)!).display).toBe("none");
        expect(document.getElementById(`mark-${slug(feature.id)}`)!.hasAttribute(`data-still-synthetic-${slug(feature.id)}`)).toBe(true);
        expect(engine.evaluate(ALL_ON, new URL(`/synthetic-${slug(feature.id)}`, url.origin), on))
          .toEqual({ kind: "redirect", url: new URL(`/synthetic-landing-${slug(feature.id)}`, url.origin).href });
      }
      // Back to the shipped defaults: Pro classes, CSS and markers go; the free text is restored.
      engine.applyDom(ALL_ON, url, document);
      hook.reconcile(engine.effectiveFeatures!());
      expect(featureClasses()).toHaveLength(1);
      expect(ownedStyles()[0]!.textContent).toBe(freeOnlyText(service, scopeOf(core)));
      for (const marker of MARKERS) expect(document.querySelector(`[${marker.attribute}]`)).toBeNull();
      hook.stop();
    });
  }

  it("covers all 12 Pro controls", () => {
    expect(PRO.map((feature) => feature.id)).toHaveLength(12);
    expect(Object.values(ROUTES).flat()).toHaveLength(12);
    expect(MARKERS).toHaveLength(12);
  });
});

describe("effective-only owned CSS on the shipped packaged set", () => {
  it.each(SERVICES)("%s: owned text equals today's free-only text with Pro saved Off and saved On", (service) => {
    const core = FEATURE_REGISTRY.find((feature) => feature.service === service && feature.tier === "free")!.id;
    for (const settings of [DEFAULT_SETTINGS_V2, ALL_ON]) {
      document.head.innerHTML = "";
      document.documentElement.className = "site-theme";
      const engine = session(packaged);
      engine.applyDom(settings, new URL(PAGE[service]), document);
      // The pre-extras composition: every FREE hide rule of the service, in plan order. Packaged
      // Pro surfaces (Instagram's and YouTube's today) must add nothing while paid is off.
      const surfaces = packaged.services[service]!.surfaces.filter((surface) => surface.action === "hide"
        && FEATURE_REGISTRY.some((feature) => feature.id === surface.feature && feature.tier === "free"));
      const scope = scopeOf(core);
      const previous = surfaces.flatMap((surface) => surface.action === "hide"
        ? surface.selectors.map((selector) => `.${scope}-${slug(surface.feature)} :is(${selector}){display:none!important}`) : []).join("\n");
      expect(ownedStyles()[0]!.textContent).toBe(previous);
      expect(ownedStyles()[0]!.textContent).toBe(freeOnlyText(service, scope));
      engine.stop?.();
    }
  });

  it("free Off leaves no owned style at all, as before", () => {
    const engine = session(packaged);
    engine.applyDom({ ...ALL_ON, sites: { ...ALL_ON.sites, "youtube.shorts": false } }, new URL(PAGE.youtube), document);
    expect(ownedStyles()).toHaveLength(0);
    expect(featureClasses()).toHaveLength(0);
  });
});

describe("compiled extras route framework", () => {
  const route = (feature: FeatureId, from: string, to: string, extra: Partial<ExtrasRoute> = {}): ExtrasRoute => ({
    feature, matches: (url) => exactPath(url.pathname, from), destination: (url) => new URL(to, url.origin), ...extra,
  });
  const youtube = (...routes: ExtrasRoute[]): ExtrasRouteTable => ({ youtube: routes });
  const on = paidOn();
  const evaluate = (routes: ExtrasRouteTable, href: string, opts: Partial<typeof on> = on) =>
    session(packaged, routes).evaluate(ALL_ON, new URL(href), opts);

  it("exactPath matches the exact path with or without one trailing slash, never a nested path", () => {
    expect(exactPath("/live_chat", "/live_chat")).toBe(true);
    expect(exactPath("/live_chat/", "/live_chat")).toBe(true);
    expect(exactPath("/live_chat", "/live_chat/")).toBe(true);
    expect(exactPath("/live_chat/x", "/live_chat")).toBe(false);
    expect(exactPath("/live_chatx", "/live_chat")).toBe(false);
    expect(exactPath("/", "/")).toBe(true);
    expect(exactPath("/a", "/b", "/a")).toBe(true);
  });

  it("the free core runs first and is never shadowed by an extras route", () => {
    const shadow = route("youtube.comments", "/shorts/abc", "/extras-landing");
    expect(evaluate(youtube(shadow), "https://www.youtube.com/shorts/abc?t=3"))
      .toEqual({ kind: "redirect", url: "https://www.youtube.com/watch?t=3&v=abc" });
  });

  it("an entry is consulted only while its own feature is effective", () => {
    // youtube.autoplay: a Pro feature with no packaged hide surface, so it stays route-only here.
    const matches = vi.fn((url: URL) => exactPath(url.pathname, "/live_chat"));
    const entry = route("youtube.autoplay", "/live_chat", "/", { matches });
    // Saved Off for that feature, even with paid on.
    const engine = session(packaged, youtube(entry));
    expect(engine.evaluate({ ...ALL_ON, sites: { ...ALL_ON.sites, "youtube.autoplay": false } }, new URL("https://www.youtube.com/live_chat"), on)).toEqual({ kind: "apply" });
    // Paid off (shipped defaults).
    expect(engine.evaluate(ALL_ON, new URL("https://www.youtube.com/live_chat?v=1"))).toEqual({ kind: "apply" });
    expect(matches).not.toHaveBeenCalled();
    // Effective: a route-only feature (no hide surface) still routes, and adds no root class.
    expect(engine.evaluate(ALL_ON, new URL("https://www.youtube.com/live_chat?v=2"), on)).toEqual({ kind: "redirect", url: "https://www.youtube.com/" });
    engine.applyDom(ALL_ON, new URL("https://www.youtube.com/watch?v=2"), document, on);
    expect(featureClasses().some((name) => name.endsWith("youtube-autoplay"))).toBe(false);
  });

  it("is query-aware: the predicate sees the whole URL", () => {
    const hub = route("facebook.videos", "/watch", "/", { matches: (url) => exactPath(url.pathname, "/watch") && !url.searchParams.has("v") });
    const table: ExtrasRouteTable = { facebook: [hub] };
    expect(evaluate(table, "https://www.facebook.com/watch/")).toEqual({ kind: "redirect", url: "https://www.facebook.com/" });
    expect(evaluate(table, "https://www.facebook.com/watch/?v=123")).toEqual({ kind: "apply" });
  });

  it("is loop-safe: no self, cross-origin, core-routed or re-routed destination is followed", () => {
    const apply = { kind: "apply" };
    expect(evaluate(youtube(route("youtube.related", "/a", "/a")), "https://www.youtube.com/a")).toEqual(apply);
    expect(evaluate(youtube(route("youtube.related", "/a", "https://m.youtube.com/")), "https://www.youtube.com/a")).toEqual(apply);
    expect(evaluate(youtube(route("youtube.related", "/a", "/shorts/abc")), "https://www.youtube.com/a")).toEqual(apply);
    expect(evaluate(youtube(route("youtube.related", "/a", "/b"), route("youtube.comments", "/b", "/a")), "https://www.youtube.com/a")).toEqual(apply);
    // The second entry is dormant (saved Off), so the first may route to /b.
    const engine = session(packaged, youtube(route("youtube.related", "/a", "/b"), route("youtube.comments", "/b", "/a")));
    expect(engine.evaluate({ ...ALL_ON, sites: { ...ALL_ON.sites, "youtube.comments": false } }, new URL("https://www.youtube.com/a"), on))
      .toEqual({ kind: "redirect", url: "https://www.youtube.com/b" });
  });

  it("a throwing entry counts as no route and never breaks the free core", () => {
    const broken = route("youtube.endscreen", "/x", "/", { matches: () => { throw new Error("broken"); } });
    expect(evaluate(youtube(broken), "https://www.youtube.com/x")).toEqual({ kind: "apply" });
    expect(evaluate(youtube(broken), "https://www.youtube.com/shorts/abc")).toEqual({ kind: "redirect", url: "https://www.youtube.com/watch?v=abc" });
  });

  it("a Pro route never runs on another service's pages", () => {
    const matches = vi.fn(() => true);
    const table: ExtrasRouteTable = { instagram: [route("instagram.stories", "/stories", "/", { matches })] };
    expect(evaluate(table, "https://www.youtube.com/stories")).toEqual({ kind: "apply" });
    expect(matches).not.toHaveBeenCalled();
  });

  it("shipped sessions route only through the compiled tables that exist: Instagram's and YouTube's live chat today", () => {
    // Instagram's own routes ship with P4 and are covered by instagram-extras.test.ts; YouTube's
    // live chat route is pinned here and in youtube-extras.test.ts.
    const shipped: Partial<Record<ServiceId, readonly string[]>> = { instagram: ["/explore/", "/stories/x/", "/explore/people/"] };
    for (const [service, href] of Object.entries(PAGE) as [ServiceId, string][]) {
      const engine = session(packaged);
      for (const path of ["/live_chat", "/explore/", "/stories/x/", "/watch/", "/explore/people/"]) {
        if (shipped[service]?.includes(path)) continue;
        const decision = engine.evaluate(ALL_ON, new URL(path, href), on);
        if (service === "youtube" && path === "/live_chat") expect(decision, `${service}${path}`).toEqual({ kind: "redirect", url: "https://www.youtube.com/" });
        else expect(decision.kind, `${service}${path}`).not.toBe("redirect");
      }
      // Paid off (shipped defaults): no route at all.
      for (const path of ["/live_chat", "/live_chat_replay"]) expect(engine.evaluate(ALL_ON, new URL(path, href)).kind).not.toBe("redirect");
    }
  });
});
