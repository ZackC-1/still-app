import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scanBundle } from "./bundle-guard.mjs";
import { refuseKey, resolvePublicConfig } from "./public-config.mjs";

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (role: string) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", role })}.c2lnbmF0dXJl`;
const ANON = jwt("anon");
const SERVICE = jwt("service_role");
const ORIGIN = "https://project.supabase.co";
const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

function page({ script = `const k="${ANON}";`, style = "body{}", extraHead = "", csp }: { script?: string; style?: string; extraHead?: string; csp?: string } = {}) {
  const policy = csp ?? [
    "default-src 'none'",
    `script-src ${hash(script)}`,
    `style-src ${hash(style)}`,
    "font-src data:",
    "img-src data:",
    `connect-src ${ORIGIN}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">${extraHead}
<script type="module">${script}</script><style>${style}</style></head><body></body></html>`;
}

describe("bundle guard", () => {
  it("passes a clean single-file page with only the anon key", () => {
    expect(scanBundle(page(), { origin: ORIGIN, env: { VITE_SUPABASE_ANON_KEY: ANON } })).toEqual([]);
  });

  it("fails when a service_role key is in the page", () => {
    const script = `const k="${SERVICE}";`;
    expect(scanBundle(page({ script }), { origin: ORIGIN }).join()).toMatch(/role "service_role"/);
  });

  it("ignores supabase-js's own bare prefix check", () => {
    const script = `const k="${ANON}";const f=e=>e.startsWith(\`sb_secret_\`);`;
    expect(scanBundle(page({ script }), { origin: ORIGIN })).toEqual([]);
  });

  it("fails on a Supabase secret key", () => {
    const script = `const k="sb_secret_abcdefghijklmnop";`;
    expect(scanBundle(page({ script }), { origin: ORIGIN }).join()).toMatch(/sb_secret_/);
  });

  it("fails when any other environment variable's value reaches the page", () => {
    const leaked = "phc_this_is_a_project_key_123";
    const script = `const k="${ANON}";const p="${leaked}";`;
    const problems = scanBundle(page({ script }), { origin: ORIGIN, env: { VITE_POSTHOG_KEY: leaked, VITE_SUPABASE_ANON_KEY: ANON } });
    expect(problems.join()).toMatch(/VITE_POSTHOG_KEY/);
    expect(problems.join()).not.toContain(leaked); // names only, never values
  });

  it("does not flag a variable that only repeats an allowed value", () => {
    expect(scanBundle(page(), { origin: ORIGIN, env: { VITE_SUPABASE_ANON_KEY: ANON, SUPABASE_ANON_KEY: ANON } })).toEqual([]);
  });

  it("fails without the CSP, with an unlisted inline script, or with a loose directive", () => {
    expect(scanBundle(page().replace(/<meta http-equiv[^>]+>/, ""), { origin: ORIGIN }).join()).toMatch(/Content-Security-Policy/);
    const tampered = page().replace("<style>", "<script>alert(1)</script><style>");
    expect(scanBundle(tampered, { origin: ORIGIN }).join()).toMatch(/inline <script> is not in CSP/);
    const loose = page({ csp: "default-src 'none'; script-src 'unsafe-inline'" });
    expect(scanBundle(loose, { origin: ORIGIN }).join()).toMatch(/script-src allows 'unsafe-inline'/);
    expect(scanBundle(page(), { origin: "https://other.supabase.co" }).join()).toMatch(/connect-src/);
  });

  it("fails without noindex, with extra output files, external loads or trackers", () => {
    expect(scanBundle(page().replace(/<meta name="robots"[^>]+>/, ""), { origin: ORIGIN }).join()).toMatch(/noindex/);
    expect(scanBundle(page(), { origin: ORIGIN, files: ["index.html", "assets"] }).join()).toMatch(/one index.html/);
    expect(scanBundle(page({ extraHead: '<script src="https://cdn.example/x.js"></script>' }), { origin: ORIGIN }).join()).toMatch(/script src/);
    const script = `const k="${ANON}";posthog.init();`;
    expect(scanBundle(page({ script }), { origin: ORIGIN }).join()).toMatch(/tracking/);
  });
});

describe("public config", () => {
  it("accepts only the anon or publishable key", () => {
    expect(refuseKey(ANON)).toBeNull();
    expect(refuseKey("sb_publishable_abc123")).toBeNull();
    expect(refuseKey(SERVICE)).toMatch(/service_role/);
    expect(refuseKey("sb_secret_abc")).toMatch(/secret/);
    expect(refuseKey("sb_temp_abc")).toMatch(/not a publishable key/);
    expect(refuseKey("eyJhbGciOiJIUzI1NiJ9.!!!.sig")).toBeNull(); // not JWT-shaped at all: opaque
    expect(refuseKey(`${ANON.split(".")[0]}.bm90LWpzb24.c2ln`)).toMatch(/unreadable JWT/);
    // CI builds every package with a synthetic opaque placeholder; it is not a credential.
    expect(refuseKey("public-audit-placeholder")).toBeNull();
  });

  it("refuses a half or non-project configuration and a service key at build time", () => {
    expect(resolvePublicConfig({})).toEqual({ url: "", anonKey: "", origin: null });
    expect(resolvePublicConfig({ VITE_SUPABASE_URL: `${ORIGIN}/`, VITE_SUPABASE_ANON_KEY: ANON }).origin).toBe(ORIGIN);
    expect(() => resolvePublicConfig({ VITE_SUPABASE_URL: ORIGIN })).toThrow(/both/);
    expect(() => resolvePublicConfig({ VITE_SUPABASE_URL: "http://project.supabase.co", VITE_SUPABASE_ANON_KEY: ANON })).toThrow(/https/);
    expect(() => resolvePublicConfig({ VITE_SUPABASE_URL: ORIGIN, VITE_SUPABASE_ANON_KEY: SERVICE })).toThrow(/service_role/);
  });
});
