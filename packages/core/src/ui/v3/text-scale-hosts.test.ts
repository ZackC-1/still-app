import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards for where text size is bound (owner decision 51). Every host binds exactly once, at the
// point it commits to a V3 screen; legacy screens and V3 components never bind; Chrome/Firefox
// gate the call with an inline build-time condition so configured 2.x builds fold it away.

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "../../../..");
const read = (path: string): string => readFileSync(resolve(packages, path), "utf8");
const calls = (source: string): number => source.match(/\bbindTextScale\(/g)?.length ?? 0;

const CHROMIUM_ENTRIES = [
  "ext-chromium/entrypoints/popup/main.ts",
  "ext-chromium/entrypoints/options/main.ts",
  "ext-chromium/entrypoints/first-run/main.ts",
  "ext-chromium/entrypoints/tiktok-blocked/main.ts",
];
const APPLE_HOSTS = [
  "ext-safari/entrypoints/popup/v3-mount.ts",
  "ext-safari/entrypoints/options/v3-mount.ts",
  "app-webview/src/main.ts",
];

// The build-time V3 condition, exactly modernSettingsRuntime().atomicLocal over the inlined values.
const INLINE_V3 =
  /if \(\s*!\(import\.meta\.env\.VITE_SUPABASE_URL && import\.meta\.env\.VITE_SUPABASE_ANON_KEY\) \|\|\s*import\.meta\.env\.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true"\s*\)\s*bindTextScale\(document, "browser"/;

describe("text size binding sites", () => {
  it.each(CHROMIUM_ENTRIES)("%s binds once, behind the inline V3 build condition", (path) => {
    const source = read(path);
    expect(calls(source)).toBe(1);
    expect(source).toMatch(INLINE_V3);
  });

  it("the inline condition is the same rule as modernSettingsRuntime's atomicLocal", () => {
    const runtime = read("ext-chromium/lib/modern-settings-runtime.ts");
    expect(runtime).toContain("atomicLocal: supabase === null || modernCloud");
    expect(runtime).toContain('modernCloud = supabase !== null && modernSyncOptIn === "true"');
  });

  it("only the Chrome/Firefox popup asks for the compact-popup and heading rules", () => {
    expect(read("ext-chromium/entrypoints/popup/main.ts")).toMatch(
      /compactPopup: true,\s*desktopPopupHeading: true/,
    );
    for (const path of CHROMIUM_ENTRIES.slice(1)) expect(read(path)).not.toContain("compactPopup");
  });

  it.each(APPLE_HOSTS)("%s binds once, from Apple's system text size", (path) => {
    const source = read(path);
    expect(calls(source)).toBe(1);
    expect(source).toContain('bindTextScale(document, "apple"');
  });

  it("the Apple app binds only inside the D04/D12 branch", () => {
    const source = read("app-webview/src/main.ts");
    const branch = source.indexOf("async function mountAppleScreens(");
    expect(branch).toBeGreaterThan(-1);
    expect(source.indexOf("bindTextScale(document")).toBeGreaterThan(branch);
  });

  it("the Safari V3 mounts remove text size again when mounting fails", () => {
    for (const path of APPLE_HOSTS.slice(0, 2)) expect(read(path)).toMatch(/catch \(error\) \{\s*unbindTextScale\(\);\s*throw error;/);
  });

  it("no legacy entry and no V3 component binds text size", () => {
    const legacy = [
      "ext-safari/entrypoints/popup/main.ts",
      "ext-safari/entrypoints/options/main.ts",
      "ext-chromium/entrypoints/popup/PopupApp.svelte",
      "ext-chromium/entrypoints/options/OptionsApp.svelte",
    ];
    for (const path of legacy) expect(read(path)).not.toContain("text-scale.js");
    for (const name of readdirSync(here).filter((file) => file.endsWith(".svelte")))
      expect(readFileSync(join(here, name), "utf8"), name).not.toContain("text-scale.js");
  });

  it("never listens to window resize (extension popups fire spurious ones)", () => {
    expect(read("core/src/ui/v3/text-scale.ts")).not.toMatch(/addEventListener\(\s*["']resize/);
  });
});

describe("every V3 font size follows --text-scale", () => {
  // The single fixed size is the desktop popup's "Settings sync" heading, which the approved D01
  // cascade draws at 17px; text-scale.ts grows it from 17px while text size is bound.
  const ALLOWED = new Set(["DesktopPopup.svelte: font-size: 17px"]);

  it("declares no fixed pixel font size outside the allowlist", () => {
    const offenders: string[] = [];
    const files = readdirSync(here).filter((file) => /\.(svelte|css)$/.test(file));
    files.push(...readdirSync(join(here, "design/tokens")).map((file) => `design/tokens/${file}`));
    for (const file of files) {
      const source = readFileSync(join(here, file), "utf8");
      for (const match of source.matchAll(/font-size:\s*([^;"]+)/g)) {
        const value = match[1]!.trim();
        if (/^[\d.]+px$/.test(value)) {
          const entry = `${file}: font-size: ${value}`;
          if (!ALLOWED.has(entry)) offenders.push(entry);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
