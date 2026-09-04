import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

/** Run the production formatter — the test intentionally has no second bucketing implementation. */
function generatedCss(): { readonly free: string; readonly pro: string } {
  const output = mkdtempSync(join(tmpdir(), "still-content-css-"));
  try {
    execFileSync(process.execPath, ["packages/core/scripts/gen-content-css.mjs", output], { cwd: root });
    return {
      free: readFileSync(join(output, "still.css"), "utf8"),
      pro: readFileSync(join(output, "still-pro.css"), "utf8"),
    };
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

/** The one place the class prefix is authored, read as text because this suite runs without a DOM. */
function servicePrefixFromEngine(): string {
  const engine = read("packages/core/src/rules/engine.ts");
  const match = /ROOT_SERVICE_CLASS_PREFIX = "([^"]+)"/.exec(engine);
  if (!match) throw new Error("ROOT_SERVICE_CLASS_PREFIX not found in engine.ts");
  return match[1]!;
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
      const expected = generatedCss();
      expect(read(`packages/${target}/entrypoints/content/still.css`)).toBe(expected.free);
      expect(read(`packages/${target}/entrypoints/content/still-pro.css`)).toBe(expected.pro);
    });

    // Both stylesheets are declared once in the manifest, so they load on all four services. Every
    // rule must therefore name the service it was authored for, or one service's selectors run on
    // another's pages: Instagram's `a[aria-label*="reels" i]` hid seven ordinary long-form results
    // on a YouTube search for "fishing reels".
    it(`${target}: every generated rule is scoped to exactly one service`, () => {
      const prefix = servicePrefixFromEngine();
      for (const file of ["still.css", "still-pro.css"]) {
        const lines = read(`packages/${target}/entrypoints/content/${file}`)
          .split("\n")
          .filter((line) => line.startsWith("html."));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          const scopes = line.slice(0, line.indexOf(" ")).split(".").filter((c) => c.startsWith(prefix));
          expect(scopes, line).toHaveLength(1);
        }
      }
    });
  }

  it("the generator writes the same service class prefix the engine toggles", () => {
    expect(read("packages/core/scripts/gen-content-css.mjs")).toContain(
      `SERVICE_CLASS_PREFIX = "${servicePrefixFromEngine()}"`,
    );
  });
});
