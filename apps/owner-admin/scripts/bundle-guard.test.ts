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
    const script = `const k="${"sb_" + "secret_abcdefghijklmnop"}";`;
    expect(scanBundle(page({ script }), { origin: ORIGIN }).join()).toMatch(/sb_secret_/);
  });

  it("fails when any other environment variable's value reaches the page", () => {
    const leaked = "phc_this_is_a_project_key_123";
    const script = `const k="${ANON}";const p="${leaked}";`;
    const problems = scanBundle(page({ script }), { origin: ORIGIN, env: { VITE_POSTHOG_KEY: leaked, VITE_SUPABASE_ANON_KEY: ANON } });
    expect(problems.join()).toMatch(/VITE_POSTHOG_KEY/);
    expect(problems.join()).not.toContain(leaked); // names only, never values
  });

  it("exempts only plain names and anon-key aliases that repeat an allowed value", () => {
    const env = { VITE_SUPABASE_URL: ORIGIN, VITE_SUPABASE_ANON_KEY: ANON, SUPABASE_URL: ORIGIN, SUPABASE_ANON_KEY: ANON };
    expect(scanBundle(page(), { origin: ORIGIN, env })).toEqual([]);
  });

  it("never exempts a token or secret that has the shipped value", () => {
    const placeholderScript = `const k="public-audit-placeholder";`;
    const env = {
      VITE_SUPABASE_URL: "https://still-audit.invalid",
      VITE_SUPABASE_ANON_KEY: "public-audit-placeholder",
      SUPABASE_ACCESS_TOKEN: "public-audit-placeholder",
    };
    const problems = scanBundle(page({ script: placeholderScript }), { origin: ORIGIN, env }).join();
    expect(problems).toMatch(/SUPABASE_ACCESS_TOKEN/);
  });

  it("fails when the anon key variable is not a shippable key, whatever the page holds", () => {
    const sbp = ("sbp" + "_0123456789abcdef0123456789abcdef01234567");
    const problems = scanBundle(page({ script: `const k="${sbp}";` }), {
      origin: ORIGIN,
      env: { VITE_SUPABASE_URL: ORIGIN, VITE_SUPABASE_ANON_KEY: sbp, SUPABASE_ACCESS_TOKEN: sbp },
    }).join();
    expect(problems).toMatch(/personal access token/);
    expect(problems).toMatch(/VITE_SUPABASE_ANON_KEY is not a publishable or anon key/);
    expect(problems).toMatch(/SUPABASE_ACCESS_TOKEN/);
  });

  it("fails on other credential shapes in the page", () => {
    for (const [secret, what] of [
      [("sk" + "_live_51Habcdefghijklmnop"), /sk_\/rk_/],
      [("postgres" + "://postgres:" + "hunter2pass@db.example.co:5432/postgres"), /database URL/],
      [("sbp" + "_0123456789abcdef0123456789abcdef01234567"), /personal access token/],
    ] as const) {
      expect(scanBundle(page({ script: `const k="${ANON}";const s="${secret}";` }), { origin: ORIGIN }).join(), secret).toMatch(what);
    }
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
    expect(refuseKey("sb_" + "secret_abc")).toMatch(/secret/);
    expect(refuseKey("sb_publishable_has space")).toMatch(/malformed/);
    expect(refuseKey(`${ANON.split(".")[0]}.bm90LWpzb24.c2ln`)).toMatch(/unreadable JWT/);
  });

  it("refuses every credential that isn't a publishable or anon key", () => {
    for (const secret of [
      ("sbp" + "_0123456789abcdef0123456789abcdef01234567"), // Supabase personal access token
      ("sk" + "_live_51Habcdefghijklmnop"), // another provider's secret key
      "super-secret-jwt-token-with-at-least-32-characters-long", // a raw JWT signing secret
      ("postgres" + "://postgres:" + "hunter2pass@db.example.co:5432/postgres"), // a database URL
      "sb_temp_abc",
      "eyJhbGciOiJIUzI1NiJ9.!!!.sig",
      "anything-opaque",
    ]) {
      expect(refuseKey(secret, ORIGIN), secret).not.toBeNull();
      expect(refuseKey(secret, "https://still-audit.invalid"), secret).not.toBeNull();
      expect(() => resolvePublicConfig({ VITE_SUPABASE_URL: ORIGIN, VITE_SUPABASE_ANON_KEY: secret }), secret).toThrow();
    }
  });

  it("on a hosted project, refuses another project's anon key (ref claim must match the host)", () => {
    const keyFor = (claims: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", role: "anon", ...claims })}.c2lnbmF0dXJl`;
    expect(refuseKey(keyFor({ ref: "abcdefghij" }), "https://abcdefghij.supabase.co")).toBeNull();
    expect(refuseKey(keyFor({ ref: "otherproject" }), "https://abcdefghij.supabase.co")).toMatch(/another project/);
    expect(() => resolvePublicConfig({ VITE_SUPABASE_URL: "https://abcdefghij.supabase.co", VITE_SUPABASE_ANON_KEY: keyFor({ ref: "otherproject" }) }))
      .toThrow(/another project/);
  });

  it("on a hosted project, refuses an anon key not issued by supabase", () => {
    const foreign = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase-demo", role: "anon", ref: "abcdefghij" })}.c2lnbmF0dXJl`;
    expect(refuseKey(foreign, "https://abcdefghij.supabase.co")).toMatch(/another issuer/);
    // Local stacks issue "supabase-demo" keys; on loopback that stays accepted.
    expect(refuseKey(foreign, "http://127.0.0.1:54321")).toBeNull();
  });

  it("accepts an obvious placeholder only with a placeholder host", () => {
    // CI builds every package with this synthetic pair; neither can reach a real project.
    expect(refuseKey("public-audit-placeholder", "https://still-audit.invalid")).toBeNull();
    expect(refuseKey("public-audit-placeholder", "http://127.0.0.1:54321")).toBeNull();
    expect(refuseKey("public-audit-placeholder", ORIGIN)).not.toBeNull();
    expect(refuseKey("public-audit-placeholder")).not.toBeNull();
    expect(resolvePublicConfig({ VITE_SUPABASE_URL: "https://still-audit.invalid", VITE_SUPABASE_ANON_KEY: "public-audit-placeholder" }).origin)
      .toBe("https://still-audit.invalid");
    expect(() => resolvePublicConfig({ VITE_SUPABASE_URL: ORIGIN, VITE_SUPABASE_ANON_KEY: "public-audit-placeholder" })).toThrow();
  });

  it("refuses a half or non-project configuration and a service key at build time", () => {
    expect(resolvePublicConfig({})).toEqual({ url: "", anonKey: "", origin: null });
    expect(resolvePublicConfig({ VITE_SUPABASE_URL: `${ORIGIN}/`, VITE_SUPABASE_ANON_KEY: ANON }).origin).toBe(ORIGIN);
    expect(() => resolvePublicConfig({ VITE_SUPABASE_URL: ORIGIN })).toThrow(/both/);
    expect(() => resolvePublicConfig({ VITE_SUPABASE_URL: "http://project.supabase.co", VITE_SUPABASE_ANON_KEY: ANON })).toThrow(/https/);
    expect(() => resolvePublicConfig({ VITE_SUPABASE_URL: ORIGIN, VITE_SUPABASE_ANON_KEY: SERVICE })).toThrow(/service_role/);
  });
});
