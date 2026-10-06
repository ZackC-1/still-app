import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FEATURE_REGISTRY, type SignedRuleSetV2 } from "@still/shared-types";
import {
  PACKAGED_FREE_FEATURES,
  PACKAGED_RULE_SET_V2,
  admitPackagedRuleSetV2,
} from "../packaged.js";
import { verifyRuleSetV2 } from "../signature.js";
import { DEV_RULE_SET_KEYS, PRODUCTION_RULE_SET_KEYS, RULE_SET_MIN_VERSION } from "../trusted-keys.js";
import { createEnginePageSession, type EnginePageSession } from "../engine.js";
import { YOUTUBE_SHORTS_RULES } from "../youtube.js";
import { INSTAGRAM_REELS_RULES } from "../instagram.js";
import { FACEBOOK_REELS_RULES } from "../facebook.js";
import { YOUTUBE_EXTRAS } from "../youtube-extras.js";
import { INSTAGRAM_EXTRAS } from "../instagram-extras.js";
import { FACEBOOK_EXTRAS } from "../facebook-extras.js";
import { DEFAULT_SETTINGS_V2 } from "./format2-fixtures.js";
import { ACCESS_HOSTS, IMPLEMENTED_PRO_FEATURES } from "../../entitlement/access-policy.js";

/** A mutable deep copy of the committed data, for negative controls. */
type MutableSet = {
  format?: number;
  version: string;
  signature: SignedRuleSetV2["signature"];
  services: Record<string, { matches: string[]; surfaces: Array<{ feature: string; action: string; selectors?: string[] }> }>;
};
const packaged = () => structuredClone(PACKAGED_RULE_SET_V2) as MutableSet;
const sessions: EnginePageSession[] = [];

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.className = "site-theme";
});
afterEach(() => {
  for (const engine of sessions.splice(0)) engine.stop?.();
});

describe("packaged format-2 rule set", () => {
  it("is generated from the authored service modules plus the TikTok alias, and is current", () => {
    const set = packaged();
    expect(set.format).toBe(2);
    expect(Object.keys(set.services).sort()).toEqual(["facebook", "instagram", "tiktok", "youtube"]);
    // Free surfaces first, then each service's Still Pro extras surfaces (sign-format2.mjs).
    const composed = (rules: typeof YOUTUBE_SHORTS_RULES, extras: typeof YOUTUBE_EXTRAS) =>
      JSON.parse(JSON.stringify({ ...rules, surfaces: [...rules.surfaces, ...extras.surfaces] }));
    expect(set.services.youtube).toEqual(composed(YOUTUBE_SHORTS_RULES, YOUTUBE_EXTRAS));
    expect(set.services.instagram).toEqual(composed(INSTAGRAM_REELS_RULES, INSTAGRAM_EXTRAS));
    expect(set.services.facebook).toEqual(composed(FACEBOOK_REELS_RULES, FACEBOOK_EXTRAS));
    expect(set.services.tiktok).toEqual({
      matches: ["*://*.tiktok.com/*"],
      surfaces: [{ id: "tiktok-site", feature: "tiktok.all", action: "blockSite" }],
    });
    // The committed bytes are exactly what the generator writes (drift fails here and in CI).
    expect(() =>
      execFileSync(process.execPath, [resolve("scripts/sign-format2.mjs"), "--check"], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("covers the free launch features, plus only the optional extras whose implementation ships", () => {
    const features = Object.values(packaged().services).flatMap((service) =>
      service.surfaces.map((surface) => surface.feature),
    );
    expect(PACKAGED_FREE_FEATURES).toEqual(["youtube.shorts", "instagram.reels", "facebook.reels", "tiktok.all"]);
    for (const id of PACKAGED_FREE_FEATURES) expect(features).toContain(id);
    const implemented = new Set(ACCESS_HOSTS.flatMap((host) => IMPLEMENTED_PRO_FEATURES[host]));
    const pro = FEATURE_REGISTRY.filter((feature) => feature.tier === "pro").map((feature) => feature.id);
    // A content-handler extra (Autoplay) is implemented in code and ships no rule data.
    const handlers = new Set<string>([YOUTUBE_EXTRAS, INSTAGRAM_EXTRAS, FACEBOOK_EXTRAS].flatMap((module) => module.handlers ?? []));
    const withData = new Set<string>([...implemented].filter((id) => !handlers.has(id)));
    for (const id of features) expect(PACKAGED_FREE_FEATURES.includes(id as never) || withData.has(id as never), id).toBe(true);
    // A Pro surface is packaged only together with its implementation; the rest stay out.
    for (const id of pro) if (!withData.has(id)) expect(features, id).not.toContain(id);
    // Packaged Pro data exists exactly for the implemented extras that hide (dormant while paid is off).
    expect(new Set(features.filter((id) => (pro as readonly string[]).includes(id)))).toEqual(withData);
    for (const id of handlers) expect(implemented.has(id as never), id).toBe(true);
    expect([...handlers]).toEqual(["youtube.autoplay"]);
    expect([...implemented].sort()).toEqual([
      "facebook.sponsored", "facebook.stories", "facebook.videos",
      "instagram.explore", "instagram.stories", "instagram.suggested", "instagram.threads",
      "youtube.autoplay", "youtube.comments", "youtube.endscreen", "youtube.livechat", "youtube.related",
    ]);
    // Every Pro surface comes from a per-service extras module, and nothing else is packaged.
    const extras = [YOUTUBE_EXTRAS, INSTAGRAM_EXTRAS, FACEBOOK_EXTRAS].flatMap((module) => module.surfaces.map((surface) => surface.feature));
    expect(new Set(features)).toEqual(new Set([...PACKAGED_FREE_FEATURES, ...extras]));
  });

  it("is admitted by the format-2 contract and carries a valid dev signature over its exact payload", async () => {
    const admitted = admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2);
    expect(admitted).toEqual(PACKAGED_RULE_SET_V2);
    expect(admitted).not.toBe(PACKAGED_RULE_SET_V2); // a fresh snapshot, never the module object
    const dev = { allowedKeys: DEV_RULE_SET_KEYS, minVersion: RULE_SET_MIN_VERSION };
    expect(await verifyRuleSetV2(PACKAGED_RULE_SET_V2, dev)).toEqual({ ok: true });
    // The dev key is never a production trust anchor, so this data cannot pose as an OTA update.
    expect(
      (await verifyRuleSetV2(PACKAGED_RULE_SET_V2, { allowedKeys: PRODUCTION_RULE_SET_KEYS, minVersion: RULE_SET_MIN_VERSION })).ok,
    ).toBe(false);
    // Negative control: any edit to the packaged bytes without regenerating breaks the signature.
    const edited = packaged();
    edited.services.instagram!.surfaces[0]!.selectors![0] = "article";
    expect((await verifyRuleSetV2(edited, dev)).ok).toBe(false);
  });

  it.each([
    ["an unsafe selector", (set: ReturnType<typeof packaged>) => { set.services.youtube!.surfaces[0]!.selectors![0] = "a[href=url(x)]"; }],
    ["an unknown action", (set: ReturnType<typeof packaged>) => { set.services.youtube!.surfaces[0]!.action = "remove"; }],
    ["a host outside the service", (set: ReturnType<typeof packaged>) => { set.services.instagram!.matches = ["*://*.example.com/*"]; }],
    ["a missing free feature", (set: ReturnType<typeof packaged>) => { delete set.services.facebook; }],
    ["a missing TikTok alias", (set: ReturnType<typeof packaged>) => { delete set.services.tiktok; }],
    ["a format-1 shape", (set: ReturnType<typeof packaged>) => { delete set.format; }],
  ])("returns null (legacy fallback) for %s", (_name, mutate) => {
    const set = packaged();
    mutate(set);
    expect(admitPackagedRuleSetV2(set)).toBeNull();
  });

  it.each([null, undefined, "{}", 2, []])("returns null for non-rule-set input %s", (input) => {
    expect(admitPackagedRuleSetV2(input)).toBeNull();
  });

  // Each captured fixture: every packaged target is hidden by the compiled stylesheet and every
  // ordinary "keep-" control stays shown, attached and byte-identical; feature Off restores.
  const layouts = [
    ["youtube.html", "https://www.youtube.com/", "youtube.shorts", ["shelf", "rich-shorts-section", "subs-shorts-shelf", "shorts-guide", "shorts-mini-guide", "shorts-chip"]],
    ["youtube-search.html", "https://www.youtube.com/results?search_query=x", "youtube.shorts", ["shorts-shelf", "shorts-result"]],
    ["youtube-mobile.html", "https://m.youtube.com/", "youtube.shorts", ["mobile-shorts-section", "mobile-reel-shelf-section", "mobile-loose-short", "mobile-shorts-card"]],
    ["instagram-home.html", "https://www.instagram.com/", "instagram.reels", ["reel-post", "reel-post-with-hashtags", "nav-reels"]],
    ["instagram.html", "https://www.instagram.com/someuser/", "instagram.reels", ["reel-post", "reels-link", "profile-reel-tile"]],
    ["facebook.html", "https://www.facebook.com/", "facebook.reels", ["reel-article", "reels-shortcut", "reels-shelf-card"]],
    ["facebook-mobile.html", "https://m.facebook.com/", "facebook.reels", ["fb-mobile-reel", "fb-mobile-reels"]],
  ] as const;
  for (const [file, href, feature, targets] of layouts)
    it(`${file} ${href}: packaged targets hide, ordinary content is untouched, Off restores`, () => {
      const html = readFileSync(resolve("../../tests/fixtures", file), "utf8");
      document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
      const engine = createEnginePageSession(admitPackagedRuleSetV2(PACKAGED_RULE_SET_V2)!);
      sessions.push(engine);
      const url = new URL(href);
      const keep = [...document.querySelectorAll<HTMLElement>('[id^="keep-"]')];
      expect(keep.length).toBeGreaterThan(0);
      const before = new Map(keep.map((node) => [node, node.outerHTML]));
      engine.applyDom(DEFAULT_SETTINGS_V2, url, document);
      const display = (id: string) => getComputedStyle(document.getElementById(id)!).display;
      for (const id of targets) expect(display(id), id).toBe("none");
      for (const node of keep) {
        for (let at: Element | null = node; at; at = at.parentElement)
          expect(getComputedStyle(at).display, `${node.id} via ${at.id || at.tagName}`).not.toBe("none");
        expect(node.isConnected, node.id).toBe(true);
        expect(node.outerHTML, node.id).toBe(before.get(node));
      }
      engine.applyDom({ ...DEFAULT_SETTINGS_V2, sites: { ...DEFAULT_SETTINGS_V2.sites, [feature]: false } }, url, document);
      for (const id of targets) expect(display(id), id).not.toBe("none");
      expect(document.documentElement.className).toBe("site-theme");
    });
});
