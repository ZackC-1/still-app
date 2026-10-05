import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tiktokBlockedPageEnabled } from "../../entrypoints/tiktok-blocked/gate.js";

// The shipping content script must reach the packaged format-2 rule set only through core's
// shipping entry, so lane selection and the legacy fallback are the same on every build. The test
// seams (packaged override, service set, lane observer, a raw bundle) never appear in a build.
const source = readFileSync(resolve(process.cwd(), "entrypoints/content/index.ts"), "utf8");

describe("ext-chromium shipping content entry", () => {
  it("uses core's shipping entry at document_start", () => {
    expect(source).toContain('import { createShippingContentEntry } from "@still/core/content";');
    expect(source).toContain('runAt: "document_start"');
    expect(source).not.toContain("createExtensionContentEntry");
  });

  it("passes no test seam or unadmitted rule data", () => {
    for (const seam of ["packagedRuleSetV2", "format2Services", "onLane", "bundledRuleSetV2", "format2.json", "coverTiming"])
      expect(source, seam).not.toContain(seam);
  });
});

// U7-W3: Firefox V3 builds run the modern entry (early redirect for every core route; never the
// Safari cover). Chrome keeps the original entry and DNR. The condition is inline so configured
// builds fold it away and stay byte-identical; it must equal the atomicLocal gate for real inputs.
const GATE =
  "import.meta.env.FIREFOX &&\n" +
  "    (!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY) ||\n" +
  '      import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true")';

describe("ext-chromium V3 content entry gate", () => {
  it("selects the modern entry only for Firefox V3 builds, never with the Safari cover", () => {
    expect(source).toContain('import { createModernShippingContentEntry } from "@still/core/content/modern-entry";');
    expect(source).toContain(`  main:\n    ${GATE}\n      ? createModernShippingContentEntry({`);
    expect(source).not.toContain("pendingCover");
    // The other branch is the unchanged construction (Chrome keeps DNR for Shorts).
    expect(source).toContain("      : createShippingContentEntry({\n          storage: chrome.storage.local,\n" +
      "          prod: import.meta.env.PROD,\n          earlyRedirect: import.meta.env.FIREFOX,");
  });

  it.each([
    [true, "", "", ""],
    [true, "https://x.invalid", "key", ""],
    [true, "https://x.invalid", "key", "true"],
    [true, "https://x.invalid", "", ""],
    [true, undefined, undefined, undefined],
    [false, "", "", ""],
  ])("firefox %s, url %s, key %s, modern %s: the inline gate is Firefox && atomicLocal", (firefox, url, key, modern) => {
    const condition = GATE.replaceAll("import.meta.env.", "env.").replaceAll("\n", " ");
    const inline = new Function("env", `return Boolean(${condition});`) as (env: object) => boolean;
    const env = { FIREFOX: firefox, VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key, VITE_MODERN_SETTINGS_SYNC_ENABLED: modern };
    expect(inline(env)).toBe(firefox && tiktokBlockedPageEnabled(env));
  });
});
