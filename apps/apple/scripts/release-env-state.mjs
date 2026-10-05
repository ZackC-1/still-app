#!/usr/bin/env node
// Release-build env state for the Apple archive guard (U3-W4 P6).
//
// Usage: node release-env-state.mjs <app-webview-dir> <ext-safari-dir>
//
// Resolves what each package's PRODUCTION build would see for the variables the guard cares about,
// using the real loaders from the repo's installed dependencies rather than a reimplementation:
//   • app-webview is a plain Vite build: vite.loadEnv("production", dir, "VITE_"). Vite lets a
//     process variable win, even an empty one.
//   • ext-safari is a WXT build. WXT first loads its own file list (.env, .env.local, .env.production,
//     .env.production.local, then the .env.safari* variants) with node:util parseEnv and dotenv-expand
//     into process.env, where an EMPTY process variable does not win; Vite then reads the result.
//     WXT does not export that loader, so it is imported by file path from the installed package
//     (dist/core/utils/env.mjs, the real code, not a copy). If it cannot be found the helper fails
//     (exit 2) and the guard refuses: it never guesses.
//
// Output: state tokens only, one per line, e.g. "app-webview.configured=configured". It never prints
// a value. Tokens: configured = configured|unconfigured|partial; modern, atomic = on|off ("on" only
// for the exact value "true", which is what the app and extension code compare against).
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const [webDir, extDir] = process.argv.slice(2).map((p) => resolve(p));

function fail(reason) {
  process.stderr.write(`release env state: ${reason}\n`);
  process.exit(2);
}
if (!webDir || !extDir) fail("usage: release-env-state.mjs <app-webview-dir> <ext-safari-dir>");

async function loadVite() {
  const require = createRequire(join(repo, "packages/app-webview/package.json"));
  try {
    return await import(pathToFileURL(require.resolve("vite")).href);
  } catch {
    fail("cannot load the installed vite (run pnpm install)");
  }
}

async function loadWxtEnv() {
  const require = createRequire(join(repo, "packages/ext-safari/package.json"));
  try {
    const entry = require.resolve("wxt"); // <wxt>/dist/index.mjs or similar
    let dir = dirname(entry);
    while (dir !== dirname(dir) && !existsSync(join(dir, "core/utils/env.mjs"))) dir = dirname(dir);
    const file = join(dir, "core/utils/env.mjs");
    if (!existsSync(file)) throw new Error("missing");
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.loadEnv !== "function") throw new Error("missing");
    return mod.loadEnv;
  } catch {
    fail("cannot load WXT's environment loader (run pnpm install, or update this helper for the new WXT)");
  }
}

function tokens(label, env) {
  const url = env.VITE_SUPABASE_URL ?? "";
  const key = env.VITE_SUPABASE_ANON_KEY ?? "";
  const configured = url && key ? "configured" : !url && !key ? "unconfigured" : "partial";
  const on = (name) => (env[name] === "true" ? "on" : "off");
  return [
    `${label}.configured=${configured}`,
    `${label}.modern=${on("VITE_MODERN_SETTINGS_SYNC_ENABLED")}`,
    `${label}.atomic=${on("VITE_APPLE_ATOMIC_SETTINGS")}`,
  ];
}

const vite = await loadVite();
const out = [];
// app-webview first, from the untouched process environment.
out.push(...tokens("app-webview", vite.loadEnv("production", webDir, "VITE_")));
// ext-safari: WXT's loader (relative to its cwd) fills process.env, then Vite reads it.
const wxtLoadEnv = await loadWxtEnv();
process.chdir(extDir);
wxtLoadEnv("production", "safari");
out.push(...tokens("ext-safari", vite.loadEnv("production", extDir, "VITE_")));
process.stdout.write(`${out.join("\n")}\n`);
