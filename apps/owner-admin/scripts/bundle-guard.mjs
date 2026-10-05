// Post-build guard for the owner page. The finished file is scanned, not the source, so a leak
// through any dependency, define or plugin is caught too. It fails the build (exit 1) when:
//   - any server key reaches the page (a Supabase secret key, or any JWT whose role isn't anon);
//   - the value of ANY environment variable other than VITE_SUPABASE_URL and
//     VITE_SUPABASE_ANON_KEY appears in it (values are never printed, only variable names);
//   - the strict CSP meta, the noindex robots meta or the single-file shape is missing;
//   - it loads anything from elsewhere or carries an analytics or tracking script.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_ENV, jwtPayload } from "./public-config.mjs";

const SENSITIVE_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|SERVICE|JWT|DB_URL|DATABASE|CREDENTIAL|^VITE_|^SUPABASE_|^POSTHOG|^REVENUECAT|^STRIPE/i;
const MIN_SECRET_LENGTH = 12;
const TRACKERS = /posthog|google-analytics|googletagmanager|gtag\(|plausible\.io|segment\.com|mixpanel|amplitude|hotjar|sentry\.io|clarity\.ms/i;

const sha256 = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

function cspOf(html) {
  const match = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/i.exec(html);
  if (!match) return null;
  const directives = new Map();
  for (const part of match[1].split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), values);
  }
  return { index: match.index, directives };
}

/** Every problem with the built page. `env` is the build's environment (name → value);
 * `files` the names in the output directory; `origin` the configured project origin or null. */
export function scanBundle(html, { env = {}, files = ["index.html"], origin = null } = {}) {
  const problems = [];

  const extra = files.filter((file) => file !== "index.html");
  if (extra.length) problems.push(`output must be one index.html; also found ${extra.join(", ")}`);

  // supabase-js itself contains the bare prefix (it warns about misused keys); key material after
  // the prefix is what a leaked secret key looks like.
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(html)) problems.push("a Supabase secret key (sb_secret_…) is in the page");
  for (const token of html.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []) {
    const payload = jwtPayload(token);
    if (!payload || payload.role !== "anon") {
      problems.push(`a JWT with role "${String(payload?.role)}" is in the page; only the anon key may ship`);
    }
  }

  // A variable that merely repeats an allowed value (say SUPABASE_URL beside VITE_SUPABASE_URL)
  // is not a leak; any other value is.
  const allowedValues = new Set(ALLOWED_ENV.map((name) => (env[name] ?? "").trim()).filter(Boolean));
  for (const [name, value] of Object.entries(env)) {
    if (ALLOWED_ENV.includes(name) || typeof value !== "string" || allowedValues.has(value.trim())) continue;
    if (!SENSITIVE_NAME.test(name) || value.trim().length < MIN_SECRET_LENGTH) continue;
    if (html.includes(value.trim())) problems.push(`the value of ${name} is in the page; only ${ALLOWED_ENV.join(" and ")} may reach it`);
  }

  if (!/<meta\s+name="robots"\s+content="noindex, nofollow"\s*\/?>/i.test(html)) {
    problems.push('missing <meta name="robots" content="noindex, nofollow">');
  }
  if (!/<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/i.test(html)) {
    problems.push('missing <meta name="referrer" content="no-referrer">');
  }

  const csp = cspOf(html);
  if (!csp) {
    problems.push("missing the Content-Security-Policy meta");
  } else {
    const d = csp.directives;
    const only = (name, allowed) => {
      const values = d.get(name);
      if (!values) problems.push(`CSP is missing ${name}`);
      else if (values.some((v) => !allowed(v))) problems.push(`CSP ${name} allows ${values.join(" ")}`);
    };
    if ((d.get("default-src") ?? []).join(" ") !== "'none'") problems.push("CSP default-src must be 'none'");
    only("script-src", (v) => v.startsWith("'sha256-"));
    only("style-src", (v) => v.startsWith("'sha256-"));
    only("font-src", (v) => v === "data:");
    only("img-src", (v) => v === "data:");
    only("connect-src", (v) => (origin ? v === origin : v === "'none'"));
    for (const name of ["base-uri", "form-action", "object-src"]) only(name, (v) => v === "'none'");
    // Every inline script and style must be exactly one the policy lists, and appear after it.
    for (const [tag, directive] of [["script", "script-src"], ["style", "style-src"]]) {
      const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
      for (const m of html.matchAll(re)) {
        if (!(d.get(directive) ?? []).includes(sha256(m[1]))) problems.push(`an inline <${tag}> is not in CSP ${directive}`);
        if (m.index < csp.index) problems.push(`an inline <${tag}> comes before the CSP meta`);
      }
    }
  }

  if (/<script\b[^>]*\bsrc=/i.test(html)) problems.push("a <script src> loads code from a file or elsewhere");
  if (/<link\b[^>]*\bhref=/i.test(html)) problems.push("a <link href> loads a resource from elsewhere");
  if (/\b(?:src|href)="https?:/i.test(html)) problems.push("an element loads from another site");
  if (TRACKERS.test(html)) problems.push("an analytics or tracking reference is in the page");

  return problems;
}

/** The environment a build sees: this process plus the app's .env files (names only are ever
 * reported). Reading them here is what lets the guard catch a value that leaked from one. */
function buildEnvironment(appDir) {
  const env = { ...process.env };
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    const path = join(appDir, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
      if (!(m[1] in process.env)) env[m[1]] = value;
    }
  }
  return env;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const appDir = resolve(dirname(self), "..");
  const target = resolve(process.argv[2] ?? join(appDir, "dist/index.html"));
  const html = readFileSync(target, "utf8");
  const env = buildEnvironment(appDir);
  const url = (env.VITE_SUPABASE_URL ?? "").trim();
  const problems = scanBundle(html, {
    env,
    files: readdirSync(dirname(target)),
    origin: url ? new URL(url).origin : null,
  });
  if (problems.length) {
    console.error("owner-admin bundle guard FAILED:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`owner-admin bundle guard passed (${Buffer.byteLength(html)} bytes, ${url ? "configured" : "unconfigured"})`);
}
