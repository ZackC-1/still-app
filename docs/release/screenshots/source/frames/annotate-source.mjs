// Builds the in-page annotate script with the shipped rule set's selectors baked in, for Playwright
// (capture.mjs) and for the Safari bookmarklets (build-bookmarklet.mjs).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = resolve(HERE, "../../../../../packages/core/rules/seed.json");

/** Hide and remove rules per service, straight from the rule set Still ships. */
export function rulesByService() {
  const seed = JSON.parse(readFileSync(SEED, "utf8"));
  const out = {};
  for (const [service, { surfaces }] of Object.entries(seed.services)) {
    out[service] = surfaces
      .filter((s) => (s.action === "hide" || s.action === "remove") && s.selectors?.length)
      .map((s) => ({ id: s.id, action: s.action, selectors: s.selectors }));
  }
  return out;
}

/** The annotate script, followed by a call that runs it with `config` (plus the rule set). */
export function annotateScript(config = {}) {
  const body = readFileSync(resolve(HERE, "annotate.js"), "utf8");
  return `${body}\n;StillAnnotate.run(${JSON.stringify({ rules: rulesByService(), ...config })});`;
}

/** Just the library, for page.addInitScript followed by page.evaluate(StillAnnotate.run). */
export function annotateLibrary() {
  return readFileSync(resolve(HERE, "annotate.js"), "utf8");
}
