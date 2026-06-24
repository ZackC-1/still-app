// Generates the packaged critical CSS (KTD2) from the bundled seed rule set: the manifest
// content_scripts CSS that hides static short-form chrome, scoped under `html.still-active` so an
// off/paused user has nothing hidden (the content script adds the class only when a service is on).
// Re-run when the seed changes: pnpm --filter @still/ext-safari gen-css

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = join(here, "..", "..", "core", "rules", "seed.json");
const outPath = join(here, "..", "entrypoints", "content", "still.css");

const seed = JSON.parse(readFileSync(seedPath, "utf8"));
const rules = [];
for (const service of Object.values(seed.services)) {
  for (const surface of service.surfaces) {
    if (surface.action === "hide" && surface.enabledByDefault && surface.selectors) {
      for (const selector of surface.selectors) {
        rules.push(`html.still-active ${selector}{display:none!important}`);
      }
    }
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `/* Generated from packages/core/rules/seed.json — do not edit by hand. */\n${rules.join("\n")}\n`);
console.log(`wrote ${outPath} (${rules.length} hide rules)`);
