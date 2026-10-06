// The owner page's only build-time configuration: the public Supabase project URL and its anon
// (publishable) key, exactly the pair the extensions already bake in. Both are public by design;
// the server-side owner allowlist is the boundary. Anything that looks like a server key is refused
// here, at build time, and again by bundle-guard.mjs over the finished file.

/** The only two variables this page may read. Every other variable is kept out of the bundle. */
export const ALLOWED_ENV = Object.freeze(["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]);

const JWT = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/;

/** Decode a JWT payload without verifying it; null when it isn't one. */
export function jwtPayload(token) {
  const match = JWT.exec(token);
  if (!match) return null;
  try {
    const json = Buffer.from(match[1], "base64url").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** Hosts that can never be a real project: CI's synthetic `.invalid` URL and loopback stacks. */
export function isPlaceholderHost(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.endsWith(".invalid") || hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

/** The project ref of a hosted Supabase URL (https://<ref>.supabase.co), or null. */
export function hostedProjectRef(url) {
  try {
    const match = /^([a-z0-9]+)\.supabase\.co$/.exec(new URL(url).hostname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** A synthetic stand-in such as CI's "public-audit-placeholder": lowercase words and hyphens that
 * say "placeholder". No real credential has that shape. */
const PLACEHOLDER = /^[a-z0-9-]*placeholder[a-z0-9-]*$/;

/** Why a key may not ship in a public page, or null when it may. Accepted, and nothing else:
 *  - a publishable key (sb_publishable_…);
 *  - a JWT whose role claim is "anon" (on a hosted <ref>.supabase.co URL it must also be issued by
 *    "supabase" and, when it names a project ref, name that same project);
 *  - an obvious placeholder, and only when the project URL is a placeholder host (`.invalid` or
 *    loopback), so it can never pair with a real project.
 * Everything else is refused: secret keys, personal access tokens (sbp_…), raw JWT signing
 * secrets, database URLs, other providers' keys (sk_live_…) and any other opaque value. */
export function refuseKey(key, url = "") {
  if (typeof key !== "string" || key.length === 0) return "missing";
  if (key.startsWith("sb_publishable_")) return /^sb_publishable_[A-Za-z0-9_-]+$/.test(key) ? null : "a malformed publishable key";
  if (key.startsWith("sb_secret_")) return "a Supabase secret key";
  if (JWT.test(key)) {
    const payload = jwtPayload(key);
    if (!payload) return "an unreadable JWT";
    if (payload.role !== "anon") return `a "${String(payload.role)}" key`;
    // On a hosted project (<ref>.supabase.co) the key must be that project's own anon key.
    const hosted = hostedProjectRef(url);
    if (hosted) {
      if (payload.iss !== "supabase") return `an anon key from another issuer ("${String(payload.iss)}")`;
      if (payload.ref !== undefined && payload.ref !== hosted) return `the anon key of another project ("${String(payload.ref)}")`;
    }
    return null;
  }
  if (key.length <= 64 && PLACEHOLDER.test(key) && isPlaceholderHost(url)) return null;
  return "not a publishable or anon key";
}

/** The URL's origin when it is an acceptable project URL: https, or plain http on loopback only
 * (local stacks and the smoke test). Null otherwise. */
export function projectOrigin(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null;
  return parsed.origin;
}

/** Validate the pair. Both blank is an unconfigured build (the page shows "Not available here").
 * One without the other, a non-project URL or a server key throws, failing the build. */
export function resolvePublicConfig(env) {
  const url = (env.VITE_SUPABASE_URL ?? "").trim();
  const anonKey = (env.VITE_SUPABASE_ANON_KEY ?? "").trim();
  if (!url && !anonKey) return { url: "", anonKey: "", origin: null };
  if (!url || !anonKey) throw new Error("owner-admin: set both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, or neither");
  const origin = projectOrigin(url);
  if (!origin) throw new Error("owner-admin: VITE_SUPABASE_URL must be an https project URL with no path");
  const refusal = refuseKey(anonKey, origin);
  if (refusal) throw new Error(`owner-admin: VITE_SUPABASE_ANON_KEY is ${refusal}; only the public anon key may ship`);
  return { url: origin, anonKey, origin };
}
