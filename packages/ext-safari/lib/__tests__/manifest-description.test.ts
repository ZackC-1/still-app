import { describe, expect, it } from "vitest";
import config, { SAFARI_DESCRIPTION } from "../../wxt.config";

// App Store Connect rejects an upload whose Safari web extension manifest.json description is
// missing, not a string, or longer than 112 characters (ITMS-90849). The longer Still Pro detail
// (owner ruling P2-17) lives in the App Store listing and the in-app Still Pro screen instead.
// ext-chromium guards Chrome's 132-character description and AMO's 250-character summary
// (lib/__tests__/firefox-manifest.test.ts). scripts/release/release.test.mjs checks the built file.
const APPLE_SAFARI_DESCRIPTION_LIMIT = 112;

describe("Safari extension manifest description", () => {
  it("is the current wording", () => {
    expect(SAFARI_DESCRIPTION).toBe(
      "Removes YouTube Shorts and Instagram and Facebook Reels and blocks the TikTok website. Still Pro hides more.",
    );
    expect((config.manifest as Record<string, unknown>).description).toBe(SAFARI_DESCRIPTION);
  });

  it("is a non-empty string within Apple's 112-character limit", () => {
    const description = (config.manifest as Record<string, unknown>).description;
    expect(typeof description).toBe("string");
    expect((description as string).trim().length).toBeGreaterThan(0);
    expect([...(description as string)].length).toBeLessThanOrEqual(APPLE_SAFARI_DESCRIPTION_LIMIT);
  });
});
