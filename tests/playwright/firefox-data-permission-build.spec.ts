import { test, expect } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Firefox's optional data-collection permissions in the built bundles (owner decision, 22 Oct
// 2026: installing the free blocker never asks for the email address or payment information).
//
// Playwright cannot load an add-on into its own Firefox, and the Chromium build this project loads
// compiles the Firefox paths out, so the click-to-ask flow itself is covered by the unit tests with
// a mocked permissions API (ext-chromium lib/__tests__/data-permission.test.ts,
// purchase-wiring.permission.test.ts, browser-pro.permission.test.ts and core's
// controller-data-permission.test.ts) and by the real-Firefox lane (tests/firefox). This spec reads
// the build output, so it runs identically in both CI lanes:
//   * the Firefox manifest declares the email address and purchase status as optional;
//   * Chrome and Safari carry none of Firefox's permission code;
//   * no content script (the blocking path) and no background code asks for a permission.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIREFOX = resolve(ROOT, "packages/ext-chromium/dist/firefox-mv3");
const OTHERS = [resolve(ROOT, "packages/ext-chromium/dist/chrome-mv3"), resolve(ROOT, "packages/ext-safari/dist/safari-mv3")];
const FIREFOX_ONLY = ["personallyIdentifyingInfo", "financialAndPaymentInfo", "still:firefox-email-grant-account"];

function scripts(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return scripts(path);
    return name.endsWith(".js") ? [path] : [];
  });
}

test("the Firefox manifest asks only for the sign-in session at install", () => {
  test.skip(!existsSync(join(FIREFOX, "manifest.json")), "Firefox build missing: run pnpm build");
  const manifest = JSON.parse(readFileSync(join(FIREFOX, "manifest.json"), "utf8"));
  expect(manifest.browser_specific_settings.gecko.data_collection_permissions).toEqual({
    required: ["authenticationInfo"],
    optional: ["personallyIdentifyingInfo", "financialAndPaymentInfo", "technicalAndInteraction"],
  });
});

for (const dir of OTHERS)
  test(`${dir.split("/").slice(-1)[0]} carries none of Firefox's data-permission code`, () => {
    test.skip(!existsSync(join(dir, "manifest.json")), `${dir} missing: run pnpm build`);
    const manifest = readFileSync(join(dir, "manifest.json"), "utf8");
    expect(manifest).not.toContain("data_collection_permissions");
    for (const path of scripts(dir)) {
      const source = readFileSync(path, "utf8");
      for (const term of FIREFOX_ONLY) expect(source, `${path}: ${term}`).not.toContain(term);
    }
  });

test("the Firefox blocking path and background never ask for a data permission", () => {
  test.skip(!existsSync(join(FIREFOX, "manifest.json")), "Firefox build missing: run pnpm build");
  for (const path of scripts(join(FIREFOX, "content-scripts"))) {
    const source = readFileSync(path, "utf8");
    expect(source, path).not.toContain("data_collection");
    for (const term of FIREFOX_ONLY) expect(source, `${path}: ${term}`).not.toContain(term);
  }
  const background = readFileSync(join(FIREFOX, "background.js"), "utf8");
  expect(background).not.toMatch(/request\(\s*\{\s*data_collection/);
  // The guard reads grants for account requests; it is in the background, and it only reads.
  expect(background).toContain("financialAndPaymentInfo");
});
