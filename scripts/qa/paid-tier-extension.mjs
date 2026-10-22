#!/usr/bin/env node
// Builds the browser extensions with the paid tier compiled on, for the free-outcome Playwright
// guard (tests/playwright/paid-tier-free-outcome.spec.ts, ISS-0036).
//
//   node scripts/qa/paid-tier-extension.mjs [all | chrome firefox safari (any of them)]
//
// Every shipped 2.x build has PAID_TIER_ENABLED off, so the ordinary CI lanes never run the tier
// gate that V3 Pro builds and paid sandbox QA builds run. This builds the same V3 web resources as
// `scripts/qa/v3-profile.mjs local` (modern runtime flags on, no backend, no analytics, no access
// keys), except that a build-time transform compiles `PAID_TIER_ENABLED` as true. No source file
// is modified. Output: `.output/test-paid-tier/<surface>/` (an unpacked extension) plus
// `.output/test-paid-tier/<surface>.paid-tier.json`, the marker the spec checks so it can never
// pass against a paid-off build by mistake. Nothing here is a store or QA package.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FLAG_FILE = resolve(ROOT, "packages/shared-types/src/entitlement.ts");
const FLAG_OFF = "export const PAID_TIER_ENABLED = false;";
const FLAG_ON = "export const PAID_TIER_ENABLED = true;";
const TARGETS = Object.freeze({
  chrome: { pkg: "ext-chromium", browser: "chrome" },
  firefox: { pkg: "ext-chromium", browser: "firefox" },
  safari: { pkg: "ext-safari", browser: "safari" },
});

/** Only V3 runtime flags; every inherited VITE_* value and debug switch is dropped. */
export function buildEnvironment(input = process.env) {
  const env = Object.fromEntries(
    Object.entries(input).filter(([key]) => !key.startsWith("VITE_") && !key.startsWith("STILL_QA_") &&
      !["DEBUG", "NODE_DEBUG", "NODE_OPTIONS"].includes(key)),
  );
  return { ...env, NODE_ENV: "production", VITE_MODERN_SETTINGS_SYNC_ENABLED: "true", VITE_APPLE_ATOMIC_SETTINGS: "true" };
}

/**
 * The flag module with the paid tier on. Accepts exactly one `false` literal (flipped) or, once a release
 * line ships the paid tier, exactly one `true` literal (returned unchanged). Anything else refuses.
 */
export function flipPaidFlag(source) {
  const off = source.split(FLAG_OFF).length - 1;
  const on = source.split(FLAG_ON).length - 1;
  if (off === 1 && on === 0) return source.replace(FLAG_OFF, FLAG_ON);
  if (off === 0 && on === 1) return source;
  throw new Error(`The paid flag module must hold exactly one "${FLAG_OFF}" or exactly one "${FLAG_ON}"`);
}

/** A module id or file path in one comparable form: forward slashes, no query, no virtual prefix. */
export function normalizeId(id) {
  return id.replace(/^\0/, "").split("?")[0].replaceAll("\\", "/");
}

/**
 * A build-only Vite transform: the flag module compiles with the paid tier on; the file is untouched.
 * Any other module that still carries the paid-off literal stops the build, so no bundle can reach
 * the flag through a path this transform did not flip.
 */
export function paidTierPlugin(flagFile = FLAG_FILE) {
  const state = { flipped: 0 };
  const flag = normalizeId(flagFile);
  return {
    state,
    plugin: {
      name: "still-test-paid-tier-on",
      enforce: "pre",
      transform(code, id) {
        if (normalizeId(id) !== flag) {
          if (code.includes(FLAG_OFF)) throw new Error(`The paid flag reached the build through ${id}; refusing a mixed build`);
          return null;
        }
        state.flipped += 1;
        return { code: flipPaidFlag(code), map: null };
      },
    },
  };
}

async function worker(surface, output) {
  const packageDir = join(ROOT, "packages", TARGETS[surface].pkg);
  const require = createRequire(join(packageDir, "package.json"));
  const css = spawnSync(process.execPath, [join(ROOT, "packages/core/scripts/gen-content-css.mjs"), "entrypoints/content"],
    { cwd: packageDir, env: process.env, stdio: "inherit" });
  if (css.status !== 0) throw new Error("Content CSS generation failed");
  const { build } = await import(pathToFileURL(require.resolve("wxt")).href);
  const paid = paidTierPlugin();
  // This process's empty cwd isolates WXT's dotenv loader; envDir isolates Vite's.
  await build({ root: packageDir, mode: "production", browser: TARGETS[surface].browser,
    outDir: dirname(output), outDirTemplate: basename(output),
    vite: () => ({ envDir: process.cwd(), plugins: [paid.plugin] }) });
  if (paid.state.flipped === 0) throw new Error("The paid flag module never reached the build; refusing an unproven paid build");
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === "--worker") return worker(args[1], args[2]);
  const choices = args.length ? args : ["all"];
  if (choices.some((choice) => choice !== "all" && !Object.hasOwn(TARGETS, choice)) || (choices.includes("all") && choices.length > 1))
    throw new Error("Usage: paid-tier-extension.mjs [all | chrome firefox safari (any of them)]");
  const surfaces = choices[0] === "all" ? Object.keys(TARGETS) : [...new Set(choices)];
  const output = join(ROOT, ".output", "test-paid-tier");
  await mkdir(output, { recursive: true });
  const envDir = await mkdtemp(join(tmpdir(), "still-paid-tier-env-"));
  try {
    for (const surface of surfaces) {
      const target = join(output, surface);
      await rm(target, { recursive: true, force: true });
      await rm(`${target}.paid-tier.json`, { force: true });
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker", surface, target],
        { cwd: envDir, env: buildEnvironment(), stdio: "inherit" });
      if (result.error || result.status !== 0) throw new Error(`Paid-tier build failed for ${surface}`);
      if (!(await readdir(target)).includes("manifest.json")) throw new Error(`No extension was built for ${surface}`);
      await writeFile(`${target}.paid-tier.json`, `${JSON.stringify({ paidTierEnabled: true, surface }, null, 2)}\n`);
      process.stdout.write(`${surface}: paid tier on; ${target}\n`);
    }
  } finally {
    await rm(envDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
