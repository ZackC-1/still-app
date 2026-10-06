#!/usr/bin/env node
// Sustained five-page session harness (U19). Runs against the BUILT unconfigured Chromium
// extension; build it first:
//   VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= pnpm --filter @still/ext-chromium build
//
// Usage (from the repository root):
//   node tests/sustained/run.mjs                      full run, 5 minutes
//   node tests/sustained/run.mjs --minutes=30         full run, 30 minutes
//   node tests/sustained/run.mjs --smoke              short run (about 1 minute of rounds)
//   node tests/sustained/run.mjs --control=long-task  negative control: must FAIL
//        (controls: observer-leak, listener-leak, long-task)
//   --timing=advisory   report timing budgets but fail only on structural checks
//   --report=path.json  where to write the JSON report (default test-results/sustained/)
//
// Always one worker. The report lists every check as pass, fail or baseline.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);
const known = new Set(["minutes", "smoke", "control", "timing", "report"]);
for (const key of Object.keys(args)) if (!known.has(key)) {
  console.error(`Unknown option --${key}`);
  process.exit(2);
}
const env = { ...process.env };
env.STILL_SUSTAINED_MODE = args.smoke === "true" ? "smoke" : "full";
if (args.minutes) env.STILL_SUSTAINED_MINUTES = args.minutes;
if (args.control) env.STILL_SUSTAINED_CONTROL = args.control;
if (args.timing) env.STILL_SUSTAINED_TIMING = args.timing;
if (args.report) env.STILL_SUSTAINED_REPORT = resolve(args.report);
const result = spawnSync(
  "pnpm",
  ["exec", "playwright", "test", "-c", resolve(here, "playwright.config.ts"), "--workers=1"],
  { stdio: "inherit", env, cwd: resolve(here, "../..") },
);
process.exit(result.status ?? 1);
