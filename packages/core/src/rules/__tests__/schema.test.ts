import { describe, it, expect } from "vitest";
import seed from "../../../rules/seed.json";
import { validateRuleSet, isSafeSelector } from "../schema.js";
import { SERVICE_IDS } from "@still/shared-types";

// A minimal well-formed set used as a base for targeted negative cases.
function validMinimal(): Record<string, unknown> {
  return {
    version: "1.0.0",
    services: {
      youtube: {
        matches: ["*://*.youtube.com/*"],
        surfaces: [
          { id: "yt-x", label: "x", action: "hide", enabledByDefault: true, selectors: ["a[title=\"Shorts\"]"] },
        ],
      },
    },
    signature: { kid: "still-dev-1", alg: "ed25519", value: "ab" },
  };
}

describe("validateRuleSet", () => {
  it("accepts the bundled seed", () => {
    const result = validateRuleSet(seed);
    expect(result.ok).toBe(true);
  });

  it("rejects a set missing version", () => {
    const set = validMinimal();
    delete set.version;
    expect(validateRuleSet(set).ok).toBe(false);
  });

  it("rejects a non-dotted-numeric version", () => {
    const set = validMinimal();
    set.version = "v1-beta";
    expect(validateRuleSet(set).ok).toBe(false);
  });

  it("rejects an unknown action", () => {
    const set = validMinimal();
    (set.services as any).youtube.surfaces[0].action = "evalScript";
    expect(validateRuleSet(set).ok).toBe(false);
  });

  it("rejects a surface carrying an unexpected (expression-like) field", () => {
    const set = validMinimal();
    (set.services as any).youtube.surfaces[0].onMatch = "() => fetch('//evil')";
    const result = validateRuleSet(set);
    expect(result.ok).toBe(false);
  });

  it("rejects a hide surface with no selectors", () => {
    const set = validMinimal();
    delete (set.services as any).youtube.surfaces[0].selectors;
    expect(validateRuleSet(set).ok).toBe(false);
  });

  it("rejects a redirect target that is not a same-origin path", () => {
    const set = validMinimal();
    (set.services as any).youtube.surfaces[0] = {
      id: "r", label: "r", action: "redirect", enabledByDefault: true,
      redirect: { urlMatch: "^/shorts/(\\w+)", to: "https://evil.example/$1" },
    };
    expect(validateRuleSet(set).ok).toBe(false);
  });

  it("rejects an empty services object", () => {
    const set = validMinimal();
    set.services = {};
    expect(validateRuleSet(set).ok).toBe(false);
  });
});

describe("isSafeSelector (KTD13 safe-CSS allowlist)", () => {
  it("accepts ordinary element/class/id/attribute/:has selectors", () => {
    expect(isSafeSelector("ytd-reel-shelf-renderer")).toBe(true);
    expect(isSafeSelector('div[role="article"]:has(a[href*="/reel/"])')).toBe(true);
    expect(isSafeSelector("a#endpoint[title=\"Shorts\"]")).toBe(true);
    expect(isSafeSelector('section:has(> a[href^="/reel/"])')).toBe(true);
  });

  it("rejects url() exfiltration", () => {
    expect(isSafeSelector('a[style="background:url(//evil/x)"]')).toBe(false);
  });

  it("rejects @import", () => {
    expect(isSafeSelector("@import url(//evil)")).toBe(false);
  });

  it("rejects :visited side channels and other non-allowlisted pseudo-classes", () => {
    expect(isSafeSelector("a:visited")).toBe(false);
    expect(isSafeSelector("a:hover")).toBe(false);
  });

  it("rejects pseudo-elements and rule-block punctuation", () => {
    expect(isSafeSelector("a::before")).toBe(false);
    expect(isSafeSelector("a{display:none}")).toBe(false);
  });
});

describe("seed coverage", () => {
  const set = seed as unknown as {
    services: Record<string, { matches: string[]; surfaces: { id: string; action: string }[] }>;
  };

  it("covers all four services, each with a matches pattern and ≥1 surface", () => {
    for (const id of SERVICE_IDS) {
      const svc = set.services[id];
      expect(svc, `service ${id}`).toBeDefined();
      expect(svc!.matches.length).toBeGreaterThan(0);
      expect(svc!.surfaces.length).toBeGreaterThan(0);
    }
  });

  it("uses blockSite only on TikTok", () => {
    for (const [id, svc] of Object.entries(set.services)) {
      const hasBlockSite = svc.surfaces.some((s) => s.action === "blockSite");
      if (id === "tiktok") expect(hasBlockSite).toBe(true);
      else expect(hasBlockSite).toBe(false);
    }
  });

  it("redirects Shorts on YouTube", () => {
    expect(set.services.youtube!.surfaces.some((s) => s.action === "redirect")).toBe(true);
  });
});
