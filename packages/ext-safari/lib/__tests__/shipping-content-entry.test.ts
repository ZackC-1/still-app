import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { selectSafariV3Build } from "../safari-v3.js";

// The shipping content script must reach the packaged format-2 rule set only through core's
// shipping entry, so lane selection and the legacy fallback are the same on every build. The test
// seams (packaged override, service set, lane observer, a raw bundle) never appear in a build.
const source = readFileSync(resolve(process.cwd(), "entrypoints/content/index.ts"), "utf8");

describe("ext-safari shipping content entry", () => {
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

// U7-W3: V3 builds run the modern entry (early redirect for every core route, plus the pending
// cover). The choice is an inline build-time condition so default and configured builds fold it
// away and stay byte-identical; it must be the exact opt-in the popup and settings page use.
const GATE =
  'import.meta.env.VITE_APPLE_ATOMIC_SETTINGS === "true" &&\n' +
  "      !(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)";

describe("ext-safari V3 content entry gate", () => {
  it("selects the modern entry with the inline V3 opt-in, and only there shows the cover", () => {
    expect(source).toContain('import { createModernShippingContentEntry } from "@still/core/content/modern-entry";');
    expect(source).toContain(`if (\n      ${GATE}\n    ) {\n      await createModernShippingContentEntry({`);
    expect(source).toContain("pendingCover: window.top === window,");
    expect(source.match(/pendingCover/g)).toHaveLength(1);
    // The default branch is the unchanged legacy construction.
    expect(source).toContain("      return;\n    }\n    await createShippingContentEntry({");
  });

  it.each([
    ["true", "", ""],
    ["true", "https://x.invalid", ""],
    ["true", "", "key"],
    ["true", "https://x.invalid", "key"],
    ["TRUE", "", ""],
    ["1", "", ""],
    ["false", "", ""],
    [undefined, undefined, undefined],
  ])("flag %s, url %s, key %s: the inline gate equals selectSafariV3Build", (flag, url, key) => {
    const condition = GATE.replaceAll("import.meta.env.", "env.").replace("\n", " ");
    const inline = new Function("env", `return Boolean(${condition});`) as (env: object) => boolean;
    const env = { VITE_APPLE_ATOMIC_SETTINGS: flag, VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key };
    expect(inline(env)).toBe(selectSafariV3Build({ atomicSettingsFlag: flag, supabaseUrl: url, supabaseAnonKey: key }));
  });
});
