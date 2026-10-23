import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Firefox's optional data-collection permissions (ext-chromium lib/data-permission.ts and
// lib/firefox-data-guard.ts) never reach the Safari extension: Safari has no such permission API,
// so its analytics, sign-in and Still Pro paths must report and behave exactly as before. Core's
// shared analytics takes no part in that gating either; it lives only in the Chromium/Firefox host.

const here = dirname(fileURLToPath(import.meta.url));
const safari = join(here, "..", "..");
const coreAnalytics = join(safari, "..", "core", "src", "analytics");

function sources(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" || name === "dist" || name === ".output" || name === ".wxt" ? [] : sources(path);
    return /\.(ts|svelte)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

const FIREFOX_ONLY = [
  "data-permission",
  "firefox-data-guard",
  "gateAccountAnalytics",
  "requireEmailGrant",
  "dataPermission",
  "personallyIdentifyingInfo",
  "financialAndPaymentInfo",
];

describe("Safari carries none of Firefox's data-permission gating", () => {
  it.each([...sources(join(safari, "lib")), ...sources(join(safari, "entrypoints")), ...sources(coreAnalytics)])("%s", (path) => {
    const text = readFileSync(path, "utf8");
    for (const term of FIREFOX_ONLY) expect(text, term).not.toContain(term);
  });
});
