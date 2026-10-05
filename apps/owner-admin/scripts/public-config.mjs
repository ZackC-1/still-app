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

/** Why a key may not ship in a public page, or null when it may. Refuses every server key shape
 * Supabase issues (a secret key, or a JWT whose role isn't anon). An opaque value that is neither,
 * such as CI's synthetic placeholder, is not a credential and may build. */
export function refuseKey(key) {
  if (typeof key !== "string" || key.length === 0) return "missing";
  if (/\s/.test(key)) return "malformed";
  if (key.startsWith("sb_secret_")) return "a Supabase secret key";
  if (key.startsWith("sb_")) return /^sb_publishable_[A-Za-z0-9_-]+$/.test(key) ? null : "not a publishable key";
  if (JWT.test(key)) {
    const payload = jwtPayload(key);
    if (!payload) return "an unreadable JWT";
    if (payload.role !== "anon") return `a "${String(payload.role)}" key`;
  }
  return null;
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
  const refusal = refuseKey(anonKey);
  if (refusal) throw new Error(`owner-admin: VITE_SUPABASE_ANON_KEY is ${refusal}; only the public anon key may ship`);
  return { url: origin, anonKey, origin };
}
