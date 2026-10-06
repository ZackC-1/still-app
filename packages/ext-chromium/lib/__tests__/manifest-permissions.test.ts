import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stillManifest } from "../../wxt.config";

// Permission snapshot for the Chrome and Firefox builds (U6). Still runs on four services only.
// Any new permission, host permission or optional grant fails here and needs an explicit product
// and privacy review (AGENTS.md: never <all_urls>, host permissions limited to the four services).
// ext-safari pins its own manifest the same way.

const FOUR_SERVICES = ["*://*.youtube.com/*", "*://*.instagram.com/*", "*://*.facebook.com/*", "*://*.tiktok.com/*"];
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("extension permission snapshot", () => {
  it("Chrome asks for exactly these permissions", () => {
    const manifest = stillManifest("chrome") as Record<string, unknown>;
    expect(manifest.permissions).toEqual(["storage", "alarms", "declarativeNetRequestWithHostAccess"]);
    expect(manifest.host_permissions).toEqual(FOUR_SERVICES);
    expect(manifest).not.toHaveProperty("optional_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
  });

  it("Firefox asks for exactly these permissions", () => {
    const manifest = stillManifest("firefox") as Record<string, unknown>;
    expect(manifest.permissions).toEqual(["storage", "alarms"]);
    expect(manifest.host_permissions).toEqual(FOUR_SERVICES);
    expect(manifest).not.toHaveProperty("optional_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
  });
});

// The product policy read reaches the project's first-party Supabase origin from the background,
// as the rule-set refresh already does today, with no host permission for that origin. That works
// because the server answers every response, including the preflight, with permissive CORS for a
// credential-free request. These pins fail if either side of that stops being true.
describe("the Supabase origin is reachable without a host permission", () => {
  it("no build grants a Supabase host pattern", () => {
    for (const browser of ["chrome", "firefox"]) {
      const hosts = (stillManifest(browser) as { host_permissions: string[] }).host_permissions;
      expect(hosts.some(host => /supabase|stillapp|<all_urls>|^\*:\/\/\*\/|^https?:\/\/\*\//.test(host))).toBe(false);
    }
  });

  it("the functions answer every origin, for a credential-free POST with a JSON body", () => {
    const store = readFileSync(join(repo, "supabase/functions/_shared/store.ts"), "utf8");
    expect(store).toContain('"access-control-allow-origin": "*"');
    expect(store).toMatch(/"access-control-allow-headers": "[^"]*\bcontent-type\b[^"]*"/);
    expect(store).toMatch(/"access-control-allow-methods": "[^"]*\bPOST\b[^"]*\bOPTIONS\b[^"]*"/);
    const handler = readFileSync(join(repo, "supabase/functions/product-policy/handler.ts"), "utf8");
    // Preflight, empty (404/400/503) and body responses all carry the CORS set.
    expect(handler).toContain('if (req.method === "OPTIONS") return optionsResponse();');
    expect(handler).toMatch(/const NO_STORE = \{\s*\.\.\.corsHeaders,/);
    expect(handler.match(/headers: (?:NO_STORE|\{ \.\.\.NO_STORE)/g)?.length).toBe(2);
  });

  it("the background already reaches that origin today: the rule-set refresh uses the same configured URL", () => {
    const background = readFileSync(join(repo, "packages/ext-chromium/entrypoints/background.ts"), "utf8");
    expect(background).toMatch(/createRuleSetRefresher\(\{[\s\S]*?url: import\.meta\.env\.VITE_SUPABASE_URL/);
  });
});
