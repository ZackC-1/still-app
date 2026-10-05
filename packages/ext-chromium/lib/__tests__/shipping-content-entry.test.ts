import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
    for (const seam of ["packagedRuleSetV2", "format2Services", "onLane", "bundledRuleSetV2", "format2.json"])
      expect(source, seam).not.toContain(seam);
  });
});
