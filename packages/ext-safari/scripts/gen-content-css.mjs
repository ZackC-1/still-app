// Generates the packaged critical CSS (KTD2) from the bundled seed rule set. Free hide rules are
// scoped under `html.still-active`; Pro hide rules are scoped under `html.still-pro-active`, which
// the content script only adds when the entitlement cache says Pro is active.
// Re-run when the seed changes: pnpm --filter @still/ext-safari gen-css

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = join(here, "..", "..", "core", "rules", "seed.json");
const outPath = join(here, "..", "entrypoints", "content", "still.css");
const proOutPath = join(here, "..", "entrypoints", "content", "still-pro.css");

const seed = JSON.parse(readFileSync(seedPath, "utf8"));
const rules = [];
const proRules = [];
// `tier` from the seed is the single source of truth for free-vs-Pro bucketing (the engine's
// ALWAYS_FREE_SURFACE_IDS is a separate *runtime* safety-net for fetched rule sets with stale tags;
// the bundled seed always tags surfaces, so duplicating that allowlist here would only invite drift).
// NOTE: this generator is byte-identical to the ext-chromium one — keep both in sync.
for (const service of Object.values(seed.services)) {
  for (const surface of service.surfaces) {
    if (surface.action === "hide" && surface.enabledByDefault && surface.selectors) {
      for (const selector of surface.selectors) {
        const target = surface.tier === "free" ? rules : proRules;
        const root = target === rules ? "still-active" : "still-pro-active";
        target.push(`html.${root} ${selector}{display:none!important}`);
      }
    }
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `/* Generated from packages/core/rules/seed.json — do not edit by hand. */\n${rules.join("\n")}\n`);
writeFileSync(proOutPath, `/* Generated from packages/core/rules/seed.json — do not edit by hand. */\n${proRules.join("\n")}\n`);
console.log(`wrote ${outPath} (${rules.length} free hide rules)`);
console.log(`wrote ${proOutPath} (${proRules.length} pro hide rules)`);
