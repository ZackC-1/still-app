import { type ExpectedClaims, verifyJwt } from "./jwt.ts";
import { jsonResponse, optionsResponse } from "./store.ts";
import { isUuid } from "./types.ts";

// The ONE authenticated-request preamble for every browser/app-called Still function. This is the
// whole trust boundary (KTD5 IDOR defense): the subject UUID comes ONLY from the verified JWT —
// never the request body — so a user can act only on their own rows. It was previously copy-pasted
// across all four handlers; consolidating it means the gate is tested once and every future
// authenticated function inherits the exact same hardening (OPTIONS preflight, POST-only, Bearer
// shape, HS256/ES256 verification, defense-in-depth claim checks, UUID subject).

/** The auth slice every authenticated function's Deps must carry (spread into per-handler Deps). */
export interface AuthDeps {
  /** HS256 symmetric secret (local Supabase). Empty on hosted, where tokens are ES256. */
  readonly jwtSecret: string;
  /** JWKS endpoint for ES256 verification on the hosted project. */
  readonly jwksUrl?: string;
  /** Expected iss/aud/role for the authenticated user token (defense in depth). */
  readonly expected?: ExpectedClaims;
}

/**
 * Run the shared gate, then hand the VERIFIED subject UUID to the handler body. Responses:
 * OPTIONS → 204 preflight; non-POST → 405; missing/invalid/foreign token or non-UUID subject →
 * 401 — all before the body runs. The body receives only what the gate proved.
 */
export async function withAuthenticatedUser(
  req: Request,
  auth: AuthDeps,
  body: (userId: string, req: Request) => Promise<Response>,
): Promise<Response> {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  const match = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
  if (!match) return jsonResponse(401, { error: "unauthorized" });

  const claims = await verifyJwt(match[1]!, {
    hs256Secret: auth.jwtSecret,
    jwksUrl: auth.jwksUrl,
    expected: auth.expected,
  });
  if (!claims || !isUuid(claims.sub)) return jsonResponse(401, { error: "unauthorized" });

  try {
    return await body(claims.sub, req);
  } catch (error) {
    // An uncaught body throw (Postgres/RevenueCat down) would otherwise become the platform's
    // default 500 WITHOUT the CORS headers — a browser caller can't even read the status then, so
    // backend-error looks identical to offline. Catch here so every gated function inherits a
    // CORS-carrying, non-leaking 500. The log gets a coarse category only: a raw driver or GoTrue
    // error can echo the account id (a Postgres key detail, for example) or an email.
    console.error("authenticated handler failed", { reason: failureCategory(error) });
    return jsonResponse(500, { error: "internal" });
  }
}

/** An error class name: letters only (AuthApiError, PostgresError). */
const SAFE_NAME = /^[A-Z][A-Za-z]{0,39}$/;
/** A SQLSTATE (23503), a PostgREST code (PGRST116), or a snake_case code made of letter words with
 * at most one short trailing segment (settings_unavailable, user_not_found, http_5xx). */
const SAFE_CODE = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3}|[a-z]+(?:_[a-z]+){0,5}(?:_[a-z0-9]{1,4})?)$/;

/**
 * A loggable category for a thrown value, built only from fields with a fixed vocabulary: the
 * error class name, an HTTP status and a provider/SQLSTATE code, each kept only when it matches a
 * narrow pattern (no `-`, `@`, `.`, spaces or long digit runs, so no UUID, email, URL, hex id or
 * free text can pass). Never the message.
 */
export function failureCategory(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const e = error as { name?: unknown; status?: unknown; code?: unknown; reason?: unknown };
  const parts: string[] = [];
  if (typeof e.name === "string" && SAFE_NAME.test(e.name)) parts.push(e.name);
  if (typeof e.reason === "string" && e.reason.length <= 40 && SAFE_CODE.test(e.reason)) parts.push(e.reason);
  if (typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599) {
    parts.push(`status_${e.status}`);
  }
  if (typeof e.code === "string" && e.code.length <= 40 && SAFE_CODE.test(e.code)) parts.push(`code_${e.code}`);
  return parts.length > 0 ? parts.join(":") : "unknown";
}
