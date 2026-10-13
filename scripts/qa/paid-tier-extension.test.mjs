import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildEnvironment, flipPaidFlag, normalizeId, paidTierPlugin } from "./paid-tier-extension.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FLAG_FILE = resolve(ROOT, "packages/shared-types/src/entitlement.ts");

test("the checked-in flag module flips to exactly one paid-on literal", async () => {
  const source = await readFile(FLAG_FILE, "utf8");
  const flipped = flipPaidFlag(source);
  assert.equal(flipped.split("export const PAID_TIER_ENABLED = true;").length, 2);
  assert.ok(!flipped.includes("export const PAID_TIER_ENABLED = false;"));
});

test("refuses a flag module that is already on, missing or ambiguous", () => {
  assert.throws(() => flipPaidFlag("export const PAID_TIER_ENABLED = true;\n"), /exactly one/);
  assert.throws(() => flipPaidFlag(""), /exactly one/);
  const twice = "export const PAID_TIER_ENABLED = false;\n".repeat(2);
  assert.throws(() => flipPaidFlag(twice), /exactly one/);
});

test("the transform touches only the flag module and records that it ran", () => {
  const { plugin, state } = paidTierPlugin(FLAG_FILE);
  assert.equal(plugin.transform("export const OTHER = false;", "/elsewhere/entitlement.ts"), null);
  assert.equal(state.flipped, 0);
  const out = plugin.transform("export const PAID_TIER_ENABLED = false;", `${FLAG_FILE}?v=1`);
  assert.equal(out.code, "export const PAID_TIER_ENABLED = true;");
  assert.equal(state.flipped, 1);
});

test("builds with only the V3 runtime flags: no inherited backend, analytics or debug input", () => {
  const env = buildEnvironment({
    PATH: "/bin",
    VITE_SUPABASE_URL: "https://example.invalid",
    VITE_POSTHOG_KEY: "phc_fixture",
    STILL_QA_SUPABASE_ANON_KEY: "fixture",
    NODE_OPTIONS: "--inspect",
  });
  assert.deepEqual(env, {
    PATH: "/bin",
    NODE_ENV: "production",
    VITE_MODERN_SETTINGS_SYNC_ENABLED: "true",
    VITE_APPLE_ATOMIC_SETTINGS: "true",
  });
});

test("matches Vite's id forms (forward slashes, queries, a virtual prefix) and refuses a stray paid-off literal", () => {
  const windows = "C:\\repo\\packages\\shared-types\\src\\entitlement.ts";
  assert.equal(normalizeId(windows), "C:/repo/packages/shared-types/src/entitlement.ts");
  const { plugin, state } = paidTierPlugin(windows);
  const out = plugin.transform("export const PAID_TIER_ENABLED = false;", "\0C:/repo/packages/shared-types/src/entitlement.ts?used");
  assert.equal(out.code, "export const PAID_TIER_ENABLED = true;");
  assert.equal(state.flipped, 1);
  assert.throws(() => plugin.transform("export const PAID_TIER_ENABLED = false;", "/elsewhere/copy/entitlement.js"), /mixed build/);
});
