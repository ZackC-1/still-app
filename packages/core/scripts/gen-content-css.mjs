// Generates the packaged critical CSS (KTD2) from the bundled seed rule set — the ONE generator
// every extension build shares (Safari, Chromium, Firefox). Free hide rules are scoped under
// `html.still-active`; Pro hide rules are scoped under `html.still-pro-active`, which the content
// script only adds when the entitlement cache says Pro is active.
//
// Usage: node packages/core/scripts/gen-content-css.mjs <content-dir> [<content-dir> ...]
//   e.g. node ../core/scripts/gen-content-css.mjs entrypoints/content   (from an extension package)
// Each <content-dir> receives still.css (free) + still-pro.css (pro).
//
// `tier` from the seed is the single source of truth for free-vs-Pro bucketing (the engine's
// ALWAYS_FREE_SURFACE_IDS is a separate *runtime* safety-net for fetched rule sets with stale tags;
// the bundled seed always tags surfaces, so duplicating that allowlist here would only invite drift).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = join(here, "..", "rules", "seed.json");

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: gen-content-css.mjs <content-dir> [<content-dir> ...]");
  process.exit(1);
}

const seed = JSON.parse(readFileSync(seedPath, "utf8"));
const rules = [];
const proRules = [];
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

const header = "/* Generated from packages/core/rules/seed.json — do not edit by hand. */\n";
for (const dir of targets) {
  const outDir = resolve(process.cwd(), dir);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "still.css");
  const proOutPath = join(outDir, "still-pro.css");
  writeFileSync(outPath, `${header}${rules.join("\n")}\n`);
  writeFileSync(proOutPath, `${header}${proRules.join("\n")}\n`);
  console.log(`wrote ${outPath} (${rules.length} free hide rules)`);
  console.log(`wrote ${proOutPath} (${proRules.length} pro hide rules)`);
}
