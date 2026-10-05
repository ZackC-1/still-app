import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../wxt.config";

// Permission snapshot for the Safari build (U6). Any new permission, host permission or optional
// grant fails here and needs an explicit product and privacy review. ext-chromium pins Chrome and
// Firefox the same way.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Safari extension permission snapshot", () => {
  it("asks for exactly these permissions", () => {
    const manifest = config.manifest as Record<string, unknown>;
    expect(manifest.permissions).toEqual(["storage", "nativeMessaging", "alarms"]);
    expect(manifest.host_permissions).toEqual([
      "*://*.youtube.com/*", "*://*.instagram.com/*", "*://*.facebook.com/*", "*://*.tiktok.com/*",
    ]);
    expect(manifest).not.toHaveProperty("optional_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
  });
});

// Product policy (U6) on Safari is deliberately the Apple app's job, not the extension's. The
// policy grammar has no Safari surface: Safari maps to its Apple host (apple_mobile_host,
// apple_macos_host), purchases and Restore run in the app (owner decision 14 sends "Open Still" to
// the app's Access & purchases section), and a rating request is Apple's own sheet, shown by the
// app. A second fetch and fence in the extension would be a second, disagreeing copy of the app's
// App Group state. So the Safari extension never fetches or evaluates product policy; StillKit's
// ProductPolicyRuntime does, in the app.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (["node_modules", "dist", ".wxt", ".output", "__tests__", "public"].includes(name)) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|svelte|js)$/.test(name) ? [path] : [];
  });
}

describe("Safari defers product policy to the Apple app", () => {
  it("no Safari extension source reads product policy", () => {
    const users = [...sources(join(root, "entrypoints")), ...sources(join(root, "lib"))]
      .filter(path => /product-policy|ProductPolicy|evaluateSalesPolicy|evaluateRatingPolicy|functions\/v1/.test(readFileSync(path, "utf8")))
      .map(path => relative(root, path));
    expect(users).toEqual([]);
  });
});
