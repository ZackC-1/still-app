import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
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
    });
  }
});
