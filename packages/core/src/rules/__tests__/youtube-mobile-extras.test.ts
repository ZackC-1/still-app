import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BenefitAccessSnapshot, BenefitId, FeatureId, SettingsV2, SignedRuleSetV2 } from "@still/shared-types";
import { initialAccessSnapshot } from "../../entitlement/access-policy.js";
import { createEnginePageSession, type EnginePageSession } from "../engine.js";
import { YOUTUBE_EXTRAS } from "../youtube-extras.js";
import { DEFAULT_SETTINGS_V2 } from "./format2-fixtures.js";
import { extrasFixture } from "./extras-fixtures.js";

// Exercise authored selector source through the real engine before the coordinator regenerates
// signed packaged data. This synthetic input is never admitted by a production loader and the
// explicit capabilities here make no claim about any platform's packaged capability table.
const rules: SignedRuleSetV2 = {
  format: 2, version: "3.0.0", signature: { kid: "synthetic-only", alg: "ed25519", value: "0".repeat(128) },
  services: { youtube: { matches: ["*://*.youtube.com/*"], surfaces: [
    { id: "synthetic-free-shorts", feature: "youtube.shorts", action: "hide", selectors: [".synthetic-shorts"] },
    ...YOUTUBE_EXTRAS.surfaces,
  ] } },
};
const capabilities = new Set<BenefitId>(["youtube.shorts", ...YOUTUBE_EXTRAS.surfaces.map(surface => surface.feature)]);
const fresh = initialAccessSnapshot({ paidMode: true, supported: capabilities });
const access: BenefitAccessSnapshot = { ...fresh, states: { ...fresh.states, "youtube.comments": "purchased", "youtube.related": "purchased" } };
const settings = (comments: boolean, patch: Partial<SettingsV2> = {}): SettingsV2 => ({
  ...DEFAULT_SETTINGS_V2, ...patch,
  sites: { ...DEFAULT_SETTINGS_V2.sites, "youtube.comments": comments },
});
const url = new URL("https://m.youtube.com/watch?v=synthetic-mobile");
const byId = (id: string) => document.getElementById(id)!;
const shown = (node: Element): boolean => {
  for (let at: Element | null = node; at; at = at.parentElement) if (getComputedStyle(at).display === "none") return false;
  return true;
};
const targets = ["target-m-comments-teaser", "target-m-comments-preview", "target-m-comments-panel", "target-m-comments-header", "target-m-comments-scrim"];
let engine: EnginePageSession;
beforeEach(() => {
  const html = new DOMParser().parseFromString(extrasFixture("yt-m-watch-comments.html"), "text/html");
  document.head.innerHTML = html.head.innerHTML;
  document.body.innerHTML = html.body.innerHTML;
  document.documentElement.className = "site-theme";
  engine = createEnginePageSession(rules);
});
afterEach(() => engine.stop?.());

describe("observed mobile YouTube comments boundaries", () => {
  it("hides the individual teaser and comments section without changing renderer-owned nodes or shared controls", () => {
    const before = document.body.innerHTML;
    engine.applyDom(settings(true), url, document, { capabilities, access });
    for (const id of targets) expect(shown(byId(id)), id).toBe(false);
    for (const node of document.querySelectorAll('[id^="keep-"]')) expect(shown(node), node.id).toBe(true);
    expect(document.body.innerHTML).toBe(before);
    expect(engine.ownsHiddenMedia?.(byId("keep-player-video"))).toBe(false);
  });

  it("restores on feature Off, service Off, Still Off, Pro loss and teardown", () => {
    const lost: BenefitAccessSnapshot = { ...access, states: { ...access.states, "youtube.comments": "locked" } };
    for (const [off, snapshot] of [
      [settings(false), access],
      [settings(true, { services: { ...DEFAULT_SETTINGS_V2.services, youtube: false } }), access],
      [settings(true, { globalOn: false }), access],
      [settings(true), lost],
    ] as const) {
      engine.applyDom(settings(true), url, document, { capabilities, access });
      expect(shown(byId(targets[0]!))).toBe(false);
      engine.applyDom(off, url, document, { capabilities, access: snapshot });
      for (const id of targets) expect(shown(byId(id)), id).toBe(true);
    }
    engine.applyDom(settings(true), url, document, { capabilities, access });
    engine.stop?.();
    for (const id of targets) expect(shown(byId(id)), id).toBe(true);
  });

  it("keeps adjacent carousel items and description panels after insertion, recycling and an in-page watch move", () => {
    engine.applyDom(settings(true), url, document, { capabilities, access });
    const section = byId("target-m-comments-panel");
    section.className = "engagement-panel-description-section";
    expect(shown(section)).toBe(true);
    section.className = "engagement-panel-comments-section";
    expect(shown(section)).toBe(false);
    byId("keep-carousel").insertAdjacentHTML("beforeend", '<yt-carousel-item-view-model id="late-item"><comments-entry-point-teaser-view-model id="late-comments">Invented teaser</comments-entry-point-teaser-view-model><button id="late-action">Invented action</button></yt-carousel-item-view-model>');
    expect(shown(byId("late-comments"))).toBe(false);
    expect(shown(byId("late-action"))).toBe(true);
    engine.applyDom(settings(true), new URL("https://m.youtube.com/watch?v=synthetic-next"), document, { capabilities, access });
    expect(shown(byId("keep-carousel"))).toBe(true);
    expect(shown(byId("keep-description-panel"))).toBe(true);
    expect(engine.debugStats().retainedSiteNodes).toBe(0);
    expect(engine.debugStats().domQueries).toBe(0);
  });

  it("comments and related remain independent of each other and the free Shorts choice", () => {
    for (const comments of [false, true]) for (const related of [false, true]) for (const shorts of [false, true]) {
      const value: SettingsV2 = { ...settings(comments), sites: { ...settings(comments).sites, "youtube.related": related, "youtube.shorts": shorts } };
      engine.applyDom(value, url, document, { capabilities, access });
      for (const id of targets) expect(shown(byId(id)), `${id} comments=${comments}`).toBe(!comments);
      expect(shown(byId("keep-related"))).toBe(!related);
      expect(shown(byId("keep-chosen-playlist"))).toBe(true);
      const decision = engine.evaluate(value, new URL("https://m.youtube.com/shorts/synthetic-short"), { capabilities, access });
      if (shorts) expect(decision.kind).toBe("redirect");
      else expect(decision.kind).not.toBe("redirect");
    }
  });

  it("saved On remains dormant without paid access or explicit capabilities", () => {
    engine.applyDom(settings(true), url, document);
    for (const id of targets) expect(shown(byId(id)), id).toBe(true);
    expect(engine.effectiveFeatures?.()).not.toContain("youtube.comments" satisfies FeatureId);
  });

  it("keeps ambiguous panels that hold another section, then follows the renderer's recycled ownership", () => {
    const panel = byId("comments-panel-shell");
    panel.insertAdjacentHTML("beforeend", '<ytm-engagement-panel-section-list-renderer class="engagement-panel-description-section" id="ambiguous-description">Invented description</ytm-engagement-panel-section-list-renderer>');
    engine.applyDom(settings(true), url, document, { capabilities, access });
    expect(shown(panel)).toBe(true);
    expect(shown(byId("ambiguous-description"))).toBe(true);
    expect(shown(byId("target-m-comments-panel"))).toBe(true);
    byId("ambiguous-description").remove(); // YouTube's renderer owns this removal, not Still.
    expect(shown(panel)).toBe(false);
    engine.stop?.();
    expect(shown(panel)).toBe(true);
  });
});
