import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import seed from "@still/core/seed";
import type { SignedRuleSet } from "@still/shared-types";

const root = resolve(process.cwd(), "../..");

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

/** Mirror of gen-content-css.mjs's bucketing — one drift-detector for the committed artifacts. */
function expectedCss(tier: "free" | "pro"): string {
  const rootClass = tier === "free" ? "still-active" : "still-pro-active";
  const lines: string[] = [];
  for (const service of Object.values((seed as unknown as SignedRuleSet).services)) {
    if (!service) continue;
    for (const surface of service.surfaces) {
      if (surface.action === "hide" && surface.enabledByDefault && surface.selectors && surface.tier === tier) {
        for (const selector of surface.selectors) {
          lines.push(`html.${rootClass} ${selector}{display:none!important}`);
        }
      }
    }
  }
  return `/* Generated from packages/core/rules/seed.json — do not edit by hand. */\n${lines.join("\n")}\n`;
}

describe("generated content CSS monetization gating", () => {
  for (const target of ["ext-chromium", "ext-safari"]) {
    it(`${target}: free stylesheet contains no Pro Reels selectors`, () => {
      const freeCss = read(`packages/${target}/entrypoints/content/still.css`);
      expect(freeCss).toContain("html.still-active");
      expect(freeCss).not.toContain("instagram.com");
      expect(freeCss).not.toContain('a[href="/reels/"]');
      expect(freeCss).not.toContain('a[aria-label="Reels"]');
      expect(freeCss).not.toContain('a[href$="/reels/"]');
      expect(freeCss).not.toContain('a[aria-label="Reels"]');
      expect(freeCss).not.toContain('li:has(> a[href*="/reel"])');
      expect(freeCss).not.toContain("still-pro-active");
    });

    it(`${target}: Pro stylesheet scopes Pro selectors under still-pro-active`, () => {
      const proCss = read(`packages/${target}/entrypoints/content/still-pro.css`);
      expect(proCss).toContain("html.still-pro-active");
      expect(proCss).toContain('a[href="/reels/"]');
      expect(proCss).toContain('a[aria-label="Reels"]');
      expect(proCss).toContain('li:has(> a[href*="/reel"])');
      // Issue #58's tab-slot cover MUST ship in the packaged CSS: the manifest-CSS fast path
      // (manifestCssOwnsHides) skips hide surfaces in JS, so a stylesheet that drifted from the
      // seed silently never applies this rule.
      expect(proCss).toContain('[role="tab"][aria-label*="reels" i] > *');
    });

    // The committed stylesheets are GENERATED artifacts of the seed. PR #64's review caught the
    // chromium copy drifting a seed version behind (only build/zip run gen-css, and only for the
    // package being built) — this parity pin turns any future drift into a red test instead of a
    // silently-inert rule set change.
    it(`${target}: committed stylesheets byte-match the generator's output for the current seed`, () => {
      expect(read(`packages/${target}/entrypoints/content/still.css`)).toBe(expectedCss("free"));
      expect(read(`packages/${target}/entrypoints/content/still-pro.css`)).toBe(expectedCss("pro"));
    });
  }
});
