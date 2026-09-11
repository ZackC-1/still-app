import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("cross-platform design contract", () => {
  it("self-hosts Inter and defines system dark and reduced-motion modes", () => {
    const tokens = read("src/ui/tokens.css");

    expect(tokens).toContain("@font-face");
    expect(tokens).toContain('font-family: "InterVariable"');
    expect(tokens).toContain("font-display: swap");
    expect(tokens).toContain("@media (prefers-color-scheme: dark)");
    expect(tokens).toContain("@media (prefers-reduced-motion: reduce)");
    expect(tokens).toContain("box-sizing: border-box");
  });

  it("uses explicit compact popup layout instead of scaling the interface", () => {
    const chromium = read("../ext-chromium/entrypoints/popup/index.html");
    const safari = read("../ext-safari/entrypoints/popup/index.html");

    expect(chromium).not.toMatch(/\bzoom\s*:/);
    expect(safari).not.toMatch(/\bzoom\s*:/);
  });

  it("takes every surface size from the shared tokens instead of repeating numbers", () => {
    // Before this, the popup width was written out twice, the options width twice, and the sheet
    // width twice, so "make the popup narrower" meant finding every copy. Each size now has one
    // declaration and each host reads it, with the number repeated only as a var() fallback so the
    // component still sizes correctly if it is ever mounted without tokens.css.
    const tokens = read("src/ui/tokens.css");
    const consumers: Record<string, string> = {
      "src/ui/App.svelte": "--content-max-inline-size",
      "src/ui/components/SignInSheet.svelte": "--sheet-max-inline-size",
      "src/ui/components/PaywallSheet.svelte": "--sheet-max-inline-size",
      "../ext-chromium/entrypoints/popup/PopupApp.svelte": "--popup-inline-size",
      "../ext-safari/entrypoints/popup/PopupApp.svelte": "--popup-inline-size",
      "../ext-chromium/entrypoints/options/OptionsApp.svelte":
        "--content-max-inline-size",
      "../ext-safari/entrypoints/options/OptionsApp.svelte":
        "--content-max-inline-size",
    };

    const declared = new Map<string, string>();
    for (const token of new Set(Object.values(consumers))) {
      // Empty when the token is missing or has stopped being a pixel value, which the assertion
      // then reports as the failure it is rather than pinning nothing.
      const value = new RegExp(`${token}:\\s*(\\d+px);`).exec(tokens)?.[1] ?? "";
      expect(value).toMatch(/^\d+px$/);
      declared.set(token, value);
    }

    // The fallback must repeat the token's own value, not merely be a pixel value. Otherwise
    // "one place to change it" is only half true: editing the token would leave a stale number
    // behind in every consumer, unreachable in a real build and wrong in every other reading.
    for (const [path, token] of Object.entries(consumers)) {
      expect(read(path)).toContain(`var(${token}, ${declared.get(token)})`);
    }
  });

  it("uses the same typeface on the linked privacy and support surfaces", () => {
    const privacy = read("../../docs/privacy.html");
    const support = read("../../docs/support.html");
    const legalStyles = read("../../docs/assets/legal.css");

    expect(privacy).toContain('href="/assets/legal.css"');
    expect(support).toContain('href="/assets/legal.css"');
    expect(legalStyles).toContain('font-family: "InterVariable"');
  });
});
