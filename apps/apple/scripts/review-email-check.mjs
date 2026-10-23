#!/usr/bin/env node
// App Review sign-in email check for Apple release archives.
//
// The Apple app's web bundle (@still/app-webview) carries VITE_REVIEW_SIGNIN_EMAIL so App Review can
// sign in with the fixed review address (packages/app-webview/src/main.ts). Without it the review
// branch is compiled out and the reviewer cannot sign in, which has cost a review round before. The
// value is owner-supplied and never committed; this check only proves it is present.
//
// Usage:
//   node review-email-check.mjs env <app-webview-dir>
//       Before building: the production build environment (exported variable first, then the
//       package's .env files, exactly as Vite resolves them) must hold a non-empty address.
//   node review-email-check.mjs bundle <app-webview-dir>
//       After `pnpm --filter @still/app-webview build`: the same value must appear exactly once in
//       <app-webview-dir>/dist/index.html, the single self-contained page the app's web view loads
//       (vite.config.ts inlines the script into it; the copy under dist/assets is not loaded).
//
// It never prints the value, only "set", "missing" or a count. `DEBUG` is removed first because
// Vite's debug output would print the values it reads.
delete process.env.DEBUG;
delete process.env.NODE_DEBUG;

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NAME = "VITE_REVIEW_SIGNIN_EMAIL";

/** True for a plausible single email address. Only the shape is checked; the value is never echoed. */
export function plausibleEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** How many times `value` occurs in the built page `<distDir>/index.html`. Throws when it is missing. */
export function countInBundle(distDir, value) {
  if (!value) return 0;
  return readFileSync(join(distDir, "index.html"), "utf8").split(value).length - 1;
}

/** The verdict for one mode, as a fixed message and exit code. Never includes the value. */
export function verdict(mode, value, distDir) {
  if (!value) return { ok: false, message: `review sign-in email: refusing to archive. ${NAME} is missing or empty for the Apple web bundle; export it (or set it in packages/app-webview/.env) with the App Review sign-in address.` };
  if (!plausibleEmail(value)) return { ok: false, message: `review sign-in email: refusing to archive. ${NAME} is not a single email address.` };
  if (mode === "env") return { ok: true, message: "review sign-in email: set" };
  let count;
  try {
    count = countInBundle(distDir, value);
  } catch {
    return { ok: false, message: "review sign-in email: refusing to archive. The web bundle has no dist/index.html; build it first (pnpm --filter @still/app-webview build)." };
  }
  if (count !== 1) return { ok: false, message: `review sign-in email: refusing to archive. The built web page (dist/index.html) contains the review address ${count} times; expected exactly once. Rebuild it with the address set.` };
  return { ok: true, message: "review sign-in email: set, and present once in the built web page" };
}

async function resolveValue(webDir) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const require = createRequire(join(repo, "packages/app-webview/package.json"));
  const vite = await import(pathToFileURL(require.resolve("vite")).href);
  return vite.loadEnv("production", webDir, "VITE_")[NAME] ?? "";
}

async function main([mode, dir, ...rest]) {
  if (!["env", "bundle"].includes(mode) || !dir || rest.length) {
    process.stderr.write("usage: review-email-check.mjs env|bundle <app-webview-dir>\n");
    return 2;
  }
  const webDir = resolve(dir);
  let value;
  try {
    value = await resolveValue(webDir);
  } catch {
    process.stderr.write("review sign-in email: refusing to archive. Could not load Vite to read the build environment (run pnpm install).\n");
    return 1;
  }
  const result = verdict(mode, value, join(webDir, "dist"));
  (result.ok ? process.stdout : process.stderr).write(`${result.message}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
