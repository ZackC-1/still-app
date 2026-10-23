import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Free blocking never touches Firefox's optional data-collection permissions (owner decision, 22
// Oct 2026): blocking, the TikTok block, local settings and the popup's free controls work with no
// grant at all, and nothing on startup, install or update asks for a permission or waits on one.
// The asking lives only in click handlers on extension pages (lib/data-permission.ts `ask`); the
// background only reads grants, and only inside the account session (lib/firefox-data-guard.ts).

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..");
const core = join(pkg, "..", "core", "src");

function files(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : files(path);
    return /\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const PERMISSION_TERMS = [
  "data_collection",
  "permissions.request",
  "personallyIdentifyingInfo",
  "financialAndPaymentInfo",
  "data-permission",
  "firefox-data-guard",
  "dataPermission",
];

describe("the blocking paths never ask for or wait on a data-collection permission", () => {
  const blocking = [
    ...files(join(pkg, "entrypoints", "content")),
    ...files(join(pkg, "entrypoints", "tiktok-blocked")),
    join(pkg, "lib", "navigation-dnr.ts"),
    join(pkg, "lib", "tiktok-tab-authority.ts"),
    join(pkg, "lib", "site-access.ts"),
    ...files(join(core, "content")),
    ...files(join(core, "rules")),
    ...files(join(core, "storage")),
  ];

  it.each(blocking.map((path) => [relative(join(pkg, ".."), path), path]))("%s", (_name, path) => {
    const source = readFileSync(path, "utf8");
    for (const term of PERMISSION_TERMS) expect(source, term).not.toContain(term);
  });
});

describe("the background", () => {
  const source = readFileSync(join(pkg, "entrypoints", "background.ts"), "utf8");

  /** The source with one top-level function's declaration removed. */
  function without(text: string, name: string): string {
    const start = text.search(new RegExp(`\\nfunction ${name}[(<]`));
    expect(start, name).toBeGreaterThan(-1);
    const end = text.indexOf("\n}\n", start);
    return text.slice(0, start) + text.slice(end === -1 ? text.length : end + 3);
  }

  it("never asks for a permission (asking needs a click on an extension page)", () => {
    expect(source).not.toMatch(/permissions\s*(\)\s*)?\??\.request\s*\(/);
    expect(source).not.toMatch(/\.ask\s*\(/);
    for (const path of [join(pkg, "lib", "firefox-data-guard.ts"), join(pkg, "lib", "default-on-analytics.ts")]) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/\.request\s*\(/);
    }
  });

  it("reads grants only inside the account session and account analytics, never in start-up, install, settings or blocking wiring", () => {
    // The account analytics gate (identify and subject, email grant) is account work too.
    const gate = source.indexOf("...(import.meta.env.FIREFOX ? gateAccountAnalytics(");
    expect(gate).toBeGreaterThan(-1);
    const gateEnd = source.indexOf(": accountAnalytics)", gate);
    const withoutGate = source.slice(0, gate) + source.slice(gateEnd);
    const outsideSession = without(withoutGate, "createSessionSpine")
      .split("\n")
      .filter((line) => !line.startsWith("import "))
      .join("\n");
    for (const term of ["firefoxDataGranted", "guardFirefoxDataFetch", "watchFirefoxAccountEmail(", "data_collection"]) {
      expect(outsideSession, term).not.toContain(term);
    }
  });

  it("guards account requests only in the Firefox build", () => {
    expect(source).toContain("const accountFetch = import.meta.env.FIREFOX");
    expect(source).toMatch(/const session = import\.meta\.env\.FIREFOX\s*\?\s*watchFirefoxAccountEmail\(/);
  });

  it("hands the session the Firefox check that skips a stored checkout's completion without the purchase grant", () => {
    // Without it a refused completion makes the reconcile answer "unknown" before the Still Pro
    // status read, so Still Pro could lock after the purchase permission is withdrawn.
    const start = source.indexOf("const created = ");
    const end = source.indexOf("clearAuthStorage:", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toMatch(
      /\.\.\.\(import\.meta\.env\.FIREFOX\s*\?\s*\{\s*mayCompleteCheckout:\s*\(\)\s*=>\s*firefoxDataGranted\(firefoxPermissions,\s*"purchase"\)\s*\}\s*:\s*\{\}\)/,
    );
  });
});

describe("the popup's free controls", () => {
  it("the Firefox for Android popup and the desktop popup's settings paths name no data permission", () => {
    for (const path of [
      join(pkg, "entrypoints", "popup", "FirefoxAndroidPopup.svelte"),
      join(pkg, "entrypoints", "popup", "PopupApp.svelte"),
      join(core, "ui", "v3", "MobilePopup.svelte"),
      join(core, "ui", "v3", "DesktopPopup.svelte"),
      join(core, "ui", "v3", "desktop-popup-binding.ts"),
    ]) {
      const text = readFileSync(path, "utf8");
      for (const term of PERMISSION_TERMS) expect(text, `${path}: ${term}`).not.toContain(term);
    }
  });
});
