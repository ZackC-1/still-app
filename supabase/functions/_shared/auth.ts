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
    // CORS-carrying, non-leaking 500; details stay in the server log.
    console.error("authenticated handler failed:", error);
    return jsonResponse(500, { error: "internal" });
  }
}
