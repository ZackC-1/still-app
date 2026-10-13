import { describe, expect, it, vi } from "vitest";

// ISS-0036: with the paid tier compiled on (V3 Pro builds, paid sandbox QA builds), a signed-out
// person without Still Pro saw TikTok load in Chrome. TikTok runs on the legacy seed engine on
// every browser host (its format-2 port is held), and the seed still tagged the whole-site TikTok
// block `tier: "pro"` from the retired 1.x paywall, so the tier gate dropped it. The TikTok block
// is the free `tiktok.all` alias, so it must apply without Still Pro, from the packaged seed and
// from a fetched rule set that still carries the stale tag.
vi.mock("@still/shared-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

const { PAID_TIER_ENABLED, TIKTOK_ALIAS } = await import("@still/shared-types");
const { ALWAYS_FREE_SURFACE_IDS, FREE_OUTCOME_SURFACE_IDS, createEnginePageSession, evaluate } = await import("../engine.js");
const { PRO_SERVICE_IDS } = await import("../tiers.js");
const seed = (await import("../../../rules/seed.json")).default;
type SignedRuleSet = import("@still/shared-types").SignedRuleSet;
type StillSettings = import("@still/shared-types").StillSettings;

const ruleSet = seed as unknown as SignedRuleSet;
const legacyAllOn: StillSettings = {
  globalOn: true,
  services: { youtube: true, instagram: true, tiktok: true, facebook: true },
  pauses: [],
} as unknown as StillSettings;
const TIKTOK_PAGES = [
  "https://www.tiktok.com/",
  "https://www.tiktok.com/foryou",
  "https://www.tiktok.com/@tiktok",
  "https://www.tiktok.com/explore",
  "https://www.tiktok.com/messages",
  "https://m.tiktok.com/",
  "https://tiktok.com/",
];

/** A fresh V3 profile's committed schema-2 settings (TikTok on, signed out). The legacy engine's
 * `evaluate` is typed for the schema-1 shape but reads schema 2 as the content script hands it. */
function freshV2(): StillSettings {
  return {
    schemaVersion: 2,
    globalOn: true,
    services: { youtube: true, instagram: true, tiktok: true, facebook: true },
    sites: {
      "youtube.shorts": true,
      "instagram.reels": true,
      "facebook.reels": true,
    },
    pauses: [],
  } as unknown as StillSettings;
}

describe("paid tier compiled on: the TikTok block stays free (ISS-0036)", () => {
  it("runs with the paid tier on", () => {
    expect(PAID_TIER_ENABLED).toBe(true);
  });

  it("blocks every TikTok page for a person without Still Pro, from the packaged seed", () => {
    for (const href of TIKTOK_PAGES) {
      for (const settings of [legacyAllOn, freshV2()]) {
        expect(evaluate(ruleSet, settings, new URL(href), { pro: false }), href).toEqual({
          kind: "placeholder",
          blocked: true,
        });
      }
    }
  });

  it("blocks TikTok from a fetched rule set that still tags the whole-site block Pro", () => {
    const fetched = JSON.parse(JSON.stringify(ruleSet)) as {
      services: { tiktok: { surfaces: Array<{ id: string; tier?: string }> } };
    };
    const surface = fetched.services.tiktok.surfaces.find((s) => s.id === "tt-blocksite")!;
    surface.tier = "pro";
    expect(evaluate(fetched as unknown as SignedRuleSet, legacyAllOn, new URL("https://www.tiktok.com/"), { pro: false }))
      .toEqual({ kind: "placeholder", blocked: true });
    delete surface.tier; // an untagged surface is treated as Pro by the gate
    expect(evaluate(fetched as unknown as SignedRuleSet, legacyAllOn, new URL("https://www.tiktok.com/"), { pro: false }))
      .toEqual({ kind: "placeholder", blocked: true });
  });

  it("the page session the content script and the background route use agrees", () => {
    const session = createEnginePageSession(ruleSet);
    expect(session.evaluate(freshV2(), new URL("https://www.tiktok.com/foryou"), { pro: false })).toEqual({
      kind: "placeholder",
      blocked: true,
    });
    expect(session.activeServiceId()).toBe("tiktok");
  });

  it("TikTok Blocker Off or Still Off still leaves TikTok open", () => {
    const off = { ...freshV2(), services: { ...freshV2().services, tiktok: false } } as StillSettings;
    expect(evaluate(ruleSet, off, new URL("https://www.tiktok.com/"), { pro: false }).kind).toBe("noop");
    const allOff = { ...freshV2(), globalOn: false } as StillSettings;
    expect(evaluate(ruleSet, allOff, new URL("https://www.tiktok.com/"), { pro: false }).kind).toBe("noop");
  });

  it("keeps the YouTube Shorts redirect free too", () => {
    expect(evaluate(ruleSet, legacyAllOn, new URL("https://www.youtube.com/shorts/abc123"), { pro: false }).kind)
      .toBe("redirect");
  });

  it("ties the exemption to the registry: the seed's TikTok block is the free tiktok.all alias", () => {
    expect(TIKTOK_ALIAS.tier).toBe("free");
    const tiktok = ruleSet.services.tiktok!.surfaces;
    expect(tiktok.filter((s) => s.action === "blockSite").map((s) => s.id)).toEqual(["tt-blocksite"]);
    expect(FREE_OUTCOME_SURFACE_IDS.has("tt-blocksite")).toBe(true);
  });

  it("audit: every legacy seed surface is a V3 free outcome, so no seed surface needs Still Pro", () => {
    // The seed carries only YouTube Shorts, Instagram Reels, Facebook Reels and the TikTok block;
    // V3 Still Pro extras live in the format-2 rule set. A new seed surface must make this choice
    // explicitly: add it to a free list, or prove it is a paid extra and change this test.
    for (const [service, rules] of Object.entries(ruleSet.services)) {
      for (const surface of rules!.surfaces) {
        const free = surface.tier === "free" || ALWAYS_FREE_SURFACE_IDS.has(surface.id) ||
          FREE_OUTCOME_SURFACE_IDS.has(surface.id);
        expect(free, `${service}/${surface.id} (${surface.label}) must be free`).toBe(true);
      }
    }
    // The legacy UI's lock list follows the gate: no legacy row is a paid row.
    expect(PRO_SERVICE_IDS).toEqual(new Set());
  });

  it("removes Instagram and Facebook Reels on the legacy lane without Still Pro", () => {
    for (const settings of [legacyAllOn, freshV2()]) {
      for (const href of ["https://www.instagram.com/reel/XYZ/", "https://www.instagram.com/reels/", "https://www.facebook.com/reel/123"])
        expect(evaluate(ruleSet, settings, new URL(href), { pro: false }).kind, href).toBe("placeholder");
      for (const href of ["https://www.instagram.com/", "https://www.facebook.com/"])
        expect(evaluate(ruleSet, settings, new URL(href), { pro: false }).kind, href).toBe("apply");
    }
  });

  it("from a fetched rule set that still tags every Reels surface Pro, too", () => {
    const fetched = JSON.parse(JSON.stringify(ruleSet)) as {
      services: Record<string, { surfaces: Array<{ tier?: string }> }>;
    };
    for (const id of ["instagram", "facebook"]) for (const s of fetched.services[id]!.surfaces) s.tier = "pro";
    expect(evaluate(fetched as unknown as SignedRuleSet, legacyAllOn, new URL("https://www.instagram.com/reel/XYZ/"), { pro: false }).kind)
      .toBe("placeholder");
    expect(evaluate(fetched as unknown as SignedRuleSet, legacyAllOn, new URL("https://www.facebook.com/reel/123"), { pro: false }).kind)
      .toBe("placeholder");
  });
});
