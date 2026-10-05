import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  FEATURE_REGISTRY,
  type ServiceId,
  type SettingsV2,
  type SignedRuleSetV2,
  type StillSettings,
} from "@still/shared-types";
import { NAVIGATION_DNR_FEATURES, NAVIGATION_DNR_RULE_IDS, planNavigationDnr, type NavigationDnrRule } from "../navigation-dnr.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../packaged.js";
import { createEnginePageSession, createFormat2PageSessionForTest, type EnginePageSession } from "../engine.js";
import { exactPath, type ExtrasRouteTable } from "../extras.js";
import { DEFAULT_SETTINGS_V2, access as everyFeatureAccess, capabilities as everyFeature } from "./format2-fixtures.js";

// The session rules must never redirect a top-level request anywhere the format-2 engine's own
// classifier would not send it. Every case below compiles rules for one settings state and replays
// a shared URL corpus through a model of Chrome's matcher; each URL a rule redirects must be one
// the classifier redirects, to the same address.

const packaged = admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!;
const SHIPPING = new Set<ServiceId>(["youtube", "instagram", "facebook"]);
const sessions: EnginePageSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.stop?.();
});

/**
 * Chrome's matcher for these rules, modelled on the documented semantics: regexFilter is tested
 * against the whole request URL (case-sensitively when isUrlFilterCaseSensitive is set),
 * requestDomains matches the host or any subdomain, the highest priority wins, allow beats
 * redirect at equal priority, and regexSubstitution replaces the first match with \0-\9 groups
 * (an unmatched group is empty). The filters use only syntax RE2 and JavaScript read alike.
 */
function simulate(rules: readonly NavigationDnrRule[], href: string): string | null {
  const host = new URL(href).hostname;
  const hits = rules.filter((rule) => {
    const domain = rule.condition.requestDomains.some((d) => host === d || host.endsWith(`.${d}`));
    const flags = rule.condition.isUrlFilterCaseSensitive ? "" : "i";
    return domain && new RegExp(rule.condition.regexFilter, flags).test(href);
  });
  if (hits.length === 0) return null;
  const top = Math.max(...hits.map((rule) => rule.priority));
  const winners = hits.filter((rule) => rule.priority === top);
  if (winners.some((rule) => rule.action.type === "allow")) return null;
  // Redirect templates must be disjoint: two winning redirects would leave the outcome to Chrome.
  expect(winners, href).toHaveLength(1);
  const rule = winners[0]!;
  if (rule.action.type !== "redirect") return null;
  const flags = rule.condition.isUrlFilterCaseSensitive ? "" : "i";
  const substitution = rule.action.redirect.regexSubstitution.replace(/\\(\d)/g, "$$$1");
  return new URL(href.replace(new RegExp(rule.condition.regexFilter, flags), substitution)).href;
}

function classify(settings: StillSettings | SettingsV2, href: string, session?: EnginePageSession): string | null {
  const engine = session ?? createEnginePageSession(packaged);
  if (!session) sessions.push(engine);
  const decision = engine.evaluate(settings, new URL(href));
  return decision.kind === "redirect" ? decision.url : null;
}

// ── The shared URL corpus ─────────────────────────────────────────────────────────────────────────
const QUERIES = [
  "", "?", "?feature=share", "?si=AbC-1_2", "?v=other", "?V=1", "?x", "?a=1&b=2", "?a=1&&b=2",
  "?q=a+b", "?q=a%20b", "?t=10s&v=x", "?list=PL1&index=2", "?*=1", "?vv=1", "?k=v", "?a=1&v=2",
  "?igsh=MTc4&utm_source=ig_web", "?sk=reels_tab", "?ref=bookmarks",
];
const FRAGMENTS = ["", "#t=10"];
const HOSTS: Record<string, readonly string[]> = {
  youtube: ["https://www.youtube.com", "https://m.youtube.com", "https://youtube.com", "http://www.youtube.com",
    "https://music.youtube.com", "https://www.youtube.com:8443", "https://WWW.YOUTUBE.COM", "https://user@www.youtube.com",
    "https://notyoutube.com", "https://youtube.com.example.net"],
  instagram: ["https://www.instagram.com", "https://instagram.com", "https://m.instagram.com", "https://www.instagram.com:444",
    "https://notinstagram.com"],
  facebook: ["https://www.facebook.com", "https://m.facebook.com", "https://facebook.com", "https://web.facebook.com",
    "https://www.facebook.com:81"],
  tiktok: ["https://www.tiktok.com"],
};
const PATHS: Record<string, readonly string[]> = {
  youtube: ["/shorts/abc123", "/shorts/abc123/", "/shorts/a-b_C9", "/shorts/", "/shorts", "/Shorts/abc123",
    "/shorts/abc123/extra", "/shorts/abc%20d", "/shorts/abc.d", "/watch", "/", "/feed/shorts", "/@someone/shorts",
    "/results"],
  instagram: ["/reels", "/reels/", "/reels/C0dE_1-x", "/reels/C0dE_1-x/", "/reels/audio", "/reels/audio/",
    "/reels/audio/123/", "/reels/audiox/", "/reel/C0dE/", "/someuser/reel/C0dE/", "/someuser/reels/", "/explore/",
    "/reelsx", "/reels/C0dE/extra/", "/Reels/", "/reels//", "/"],
  facebook: ["/reels", "/reels/", "/watch/reels", "/watch/reels/", "/watch/", "/watch", "/reel/123456",
    "/someuser/reels_tab", "/reels/123", "/watch/reels/x", "/profile.php", "/Watch/Reels/", "/groups/x/reels", "/"],
  tiktok: ["/", "/@someone/video/1", "/foryou"],
};
const CORPUS: readonly string[] = Object.entries(HOSTS).flatMap(([service, hosts]) =>
  hosts.flatMap((host) =>
    PATHS[service]!.flatMap((path) => QUERIES.flatMap((query) => FRAGMENTS.map((fragment) => `${host}${path}${query}${fragment}`))),
  ),
).map((raw) => new URL(raw).href); // the normalized URL a browser actually requests

// ── Settings states ───────────────────────────────────────────────────────────────────────────────
const v2 = (edit: (settings: { -readonly [K in keyof SettingsV2]: SettingsV2[K] }) => void): SettingsV2 => {
  const settings = structuredClone(DEFAULT_SETTINGS_V2) as { -readonly [K in keyof SettingsV2]: SettingsV2[K] };
  edit(settings);
  return settings;
};
const sites = (settings: SettingsV2) => settings.sites as Record<string, boolean>;
const services = (settings: SettingsV2) => settings.services as Record<string, boolean>;
const allOn = DEFAULT_SETTINGS_V2;
const everyProOn = v2((s) => { for (const feature of FEATURE_REGISTRY) sites(s)[feature.id] = true; });

const STATES: ReadonlyArray<readonly [string, StillSettings | SettingsV2, ReadonlySet<ServiceId>]> = [
  ["fresh defaults (all free features On)", allOn, new Set(SHIPPING)],
  ["master switch Off", v2((s) => { s.globalOn = false; }), new Set()],
  ["every Still Pro choice On (paid off)", everyProOn, new Set(SHIPPING)],
  ...(["youtube", "instagram", "facebook"] as const).flatMap((service) => {
    const core = FEATURE_REGISTRY.find((f) => f.service === service && f.tier === "free")!.id;
    const rest = new Set([...SHIPPING].filter((id) => id !== service));
    return [
      [`${service} service Off`, v2((s) => { services(s)[service] = false; }), rest],
      [`${core} Off`, v2((s) => { sites(s)[core] = false; }), rest],
      [`${core} unknown (absent)`, v2((s) => { delete sites(s)[core]; }), rest],
      [`${core} unknown (not a boolean)`, v2((s) => { (sites(s) as Record<string, unknown>)[core] = "on"; }), rest],
    ] as const;
  }),
  ["TikTok Off", v2((s) => { services(s).tiktok = false; }), new Set(SHIPPING)],
] as const;

/** The services each state leaves effective, from the free registry and the state's own choices. */
const effectiveServices = (settings: SettingsV2): Set<ServiceId> =>
  new Set(FEATURE_REGISTRY.filter((f) => f.tier === "free" && settings.globalOn && services(settings)[f.service] === true &&
    sites(settings)[f.id] === true).map((f) => f.service as ServiceId));

const plan = (settings: StillSettings | SettingsV2 | null, overrides: Partial<Parameters<typeof planNavigationDnr>[0]> = {}) =>
  planNavigationDnr({ packaged, shippingServices: SHIPPING, settings, ...overrides });

function serviceOf(rule: NavigationDnrRule): ServiceId {
  return rule.condition.requestDomains[0]!.replace(/\.com$/, "") as ServiceId;
}

describe("format-2 navigation session rules", () => {
  it.each(STATES)("%s: every redirect the rules make is the classifier's own", (_name, settings) => {
    const { rules } = plan(settings);
    const session = createEnginePageSession(packaged);
    sessions.push(session);
    for (const href of CORPUS) {
      const dnr = simulate(rules, href);
      if (dnr !== null) expect({ href, target: dnr }).toEqual({ href, target: classify(settings, href, session) });
    }
  });

  it.each(STATES)("%s: rules exist exactly for the effective services", (_name, settings) => {
    const { rules } = plan(settings);
    const effective = effectiveServices(settings as SettingsV2);
    expect(new Set(rules.map(serviceOf))).toEqual(effective);
    // No Off or unknown service keeps a single redirect anywhere in the corpus.
    for (const href of CORPUS) {
      const host = new URL(href).hostname;
      const service = (["youtube", "instagram", "facebook", "tiktok"] as const).find((id) => host === `${id}.com` || host.endsWith(`.${id}.com`));
      if (service && !effective.has(service)) expect(simulate(rules, href), href).toBeNull();
    }
  });

  it("covers the free navigation rulings, including the Reels decisions, for the fresh defaults", () => {
    const { rules } = plan(allOn);
    const cases: ReadonlyArray<readonly [string, string | null]> = [
      // YouTube Shorts open as an ordinary watch page on the same host, keeping share context.
      ["https://www.youtube.com/shorts/abc123", "https://www.youtube.com/watch?v=abc123"],
      ["https://m.youtube.com/shorts/abc123/", "https://m.youtube.com/watch?v=abc123"],
      ["https://www.youtube.com/shorts/abc123?feature=share", "https://www.youtube.com/watch?feature=share&v=abc123"],
      ["https://www.youtube.com/shorts/abc123?si=AbC-1_2", "https://www.youtube.com/watch?si=AbC-1_2&v=abc123"],
      // A query URLSearchParams would rewrite (or an existing v) stays with the content script.
      ["https://www.youtube.com/shorts/abc123?v=other", null],
      ["https://www.youtube.com/shorts/abc123?q=a%20b", null],
      // Decision 32: Facebook's Reels feed under Watch goes home; profile/Page Reels and shared Reels stay.
      ["https://www.facebook.com/watch/reels/", "https://www.facebook.com/"],
      ["https://www.facebook.com/reels/?ref=bookmarks", "https://www.facebook.com/"],
      ["https://www.facebook.com/someuser/reels_tab", null],
      ["https://www.facebook.com/reel/123456", null],
      ["https://www.facebook.com/watch/", null],
      // Decision 33: Instagram's plural viewer opens just that one Reel; the bare feed goes home;
      // profile browsing, shared single Reels and the audio hub stay reachable.
      ["https://www.instagram.com/reels/C0dE_1-x/", "https://www.instagram.com/reel/C0dE_1-x/"],
      ["https://www.instagram.com/reels/C0dE_1-x/?igsh=MTc4", "https://www.instagram.com/reel/C0dE_1-x/?igsh=MTc4"],
      ["https://www.instagram.com/reels/", "https://www.instagram.com/"],
      ["https://www.instagram.com/reels/audio/", null],
      ["https://www.instagram.com/reels/audio/123/", null],
      ["https://www.instagram.com/someuser/reel/C0dE/", null],
      ["https://www.instagram.com/someuser/reels/", null],
      ["https://www.instagram.com/reel/C0dE/", null],
      // TikTok's blocked page is a per-tab decision, never a network redirect.
      ["https://www.tiktok.com/@someone/video/1", null],
    ];
    for (const [href, target] of cases) expect({ href, target: simulate(rules, href) }).toEqual({ href, target });
    // Non-vacuous: every classifier redirect in the corpus that the rules leave alone is a case the
    // rules deliberately cannot express exactly (fragment, port, user info, rewritten query).
    let covered = 0;
    const session = createEnginePageSession(packaged);
    sessions.push(session);
    for (const href of CORPUS) {
      const expected = classify(allOn, href, session);
      if (expected === null) continue;
      if (simulate(rules, href) !== null) { covered++; continue; }
      const url = new URL(href);
      const exempt = url.hash !== "" || url.port !== "" || url.username !== "" || url.hostname !== url.hostname.toLowerCase() ||
        (url.pathname.startsWith("/shorts/") && href.includes("?"));
      expect(exempt, `left to the content script without a reason: ${href}`).toBe(true);
    }
    expect(covered).toBeGreaterThan(200);
  });

  it("keeps every Still Pro extras route out of the rules", () => {
    // Templates belong to free registry features only.
    for (const feature of NAVIGATION_DNR_FEATURES)
      expect(FEATURE_REGISTRY.find((entry) => entry.id === feature)?.tier, feature).toBe("free");
    // Every Still Pro choice On compiles exactly the free-only rules.
    expect(plan(everyProOn).rules).toEqual(plan(allOn).rules);
    // A synthetic extras table the engine WOULD follow if paid were on: none of its routes may
    // appear as a network redirect, whatever the saved choices.
    const extras: ExtrasRouteTable = {
      instagram: [{ feature: "instagram.explore", matches: (u) => exactPath(u.pathname, "/explore/"), destination: (u) => new URL("/explore/search/", u.origin) }],
      youtube: [{ feature: "youtube.related", matches: (u) => exactPath(u.pathname, "/feed/trending"), destination: (u) => new URL("/feed/subscriptions", u.origin) }],
      facebook: [{ feature: "facebook.videos", matches: (u) => exactPath(u.pathname, "/watch/"), destination: (u) => new URL("/", u.origin) }],
    };
    const paidSession = createFormat2PageSessionForTest(packaged as SignedRuleSetV2, extras);
    sessions.push(paidSession);
    const routed = ["https://www.instagram.com/explore/", "https://www.youtube.com/feed/trending", "https://www.facebook.com/watch/"];
    for (const href of routed) {
      // The extras route is real in a paid session...
      expect(paidSession.evaluate(everyProOn, new URL(href), { access: everyFeatureAccess, capabilities: everyFeature }).kind, href).toBe("redirect");
      // ...and never a session rule.
      expect(simulate(plan(everyProOn).rules, href), href).toBeNull();
    }
  });

  it("follows the content script's lane: no rules where its pages run the legacy engine", () => {
    // Schema-1 settings (configured builds until the modern rollout), absent or unreadable settings.
    for (const settings of [DEFAULT_SETTINGS, null]) expect(plan(settings)).toEqual({ format2Services: new Set(), rules: [] });
    // Packaged data that failed admission.
    expect(plan(allOn, { packaged: null })).toEqual({ format2Services: new Set(), rules: [] });
    // A service the shipping entry holds back keeps its legacy lane.
    const held = plan(allOn, { shippingServices: new Set<ServiceId>(["youtube", "facebook"]) });
    expect(held.format2Services).toEqual(new Set(["youtube", "facebook"]));
    expect(held.rules.map(serviceOf)).not.toContain("instagram");
    // A paused site (retired UI, still honoured by the engine) gets no rule.
    const paused = { ...allOn, pauses: ["youtube.com"] } as unknown as SettingsV2;
    expect(plan(paused).rules.map(serviceOf)).not.toContain("youtube");
    expect(classify(paused, "https://www.youtube.com/shorts/abc123")).toBeNull();
  });

  it("produces RE2-safe, case-sensitive, main-frame rules with stable ids", () => {
    const { rules } = plan(allOn);
    expect(rules.map((rule) => rule.id)).toEqual([...NAVIGATION_DNR_RULE_IDS]);
    for (const rule of rules) {
      // No lookaround or backreference (RE2 rejects both); Chrome validates the rest at install.
      expect(rule.condition.regexFilter).not.toMatch(/\(\?[=!<]|\\[1-9]/);
      expect(rule.condition.regexFilter.startsWith("^") && rule.condition.regexFilter.endsWith("$")).toBe(true);
      expect(rule.condition.isUrlFilterCaseSensitive).toBe(true);
      expect(rule.condition.resourceTypes).toEqual(["main_frame"]);
    }
    // Case-insensitive matching would redirect paths the classifier does not.
    const insensitive = rules.map((rule) => ({ ...rule, condition: { ...rule.condition, isUrlFilterCaseSensitive: false } })) as unknown as NavigationDnrRule[];
    expect(simulate(insensitive, "https://www.youtube.com/Shorts/abc123")).not.toBeNull();
    expect(classify(allOn, "https://www.youtube.com/Shorts/abc123")).toBeNull();
  });
});
