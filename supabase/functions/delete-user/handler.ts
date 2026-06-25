import { type ExpectedClaims, verifyJwt } from "../_shared/jwt.ts";
import { jsonResponse } from "../_shared/store.ts";
import { isUuid } from "../_shared/types.ts";
import type { UserStore } from "../_shared/user-store.ts";

// In-app account deletion (App Store Guideline 5.1.1 / GDPR). The subject is the verified JWT's
// user — never the body. Deleting the auth user cascades to profile + entitlement (U11).

export interface AccountDeps {
  /** HS256 symmetric secret (local Supabase). Empty on hosted, where tokens are ES256. */
  readonly jwtSecret: string;
  /** JWKS endpoint for ES256 verification on the hosted project. */
  readonly jwksUrl?: string;
  /** Expected iss/aud/role for the authenticated user token (defense in depth). */
  readonly expected?: ExpectedClaims;
  readonly store: UserStore;
}

export async function handleDeleteUser(req: Request, deps: AccountDeps): Promise<Response> {
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
  const match = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
  if (!match) return jsonResponse(401, { error: "unauthorized" });
  const claims = await verifyJwt(match[1]!, {
    hs256Secret: deps.jwtSecret,
    jwksUrl: deps.jwksUrl,
    expected: deps.expected,
  });
  if (!claims || !isUuid(claims.sub)) return jsonResponse(401, { error: "unauthorized" });

  await deps.store.deleteUser(claims.sub); // idempotent
  return jsonResponse(200, { deleted: true });
}
