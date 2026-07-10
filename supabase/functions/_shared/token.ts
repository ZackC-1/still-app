// Constant-time static-token auth for the two functions that can't use a Supabase JWT: the
// RevenueCat webhook (RevenueCat has no JWT) and the scheduler-invoked selector-canary. Both are
// verify_jwt=false and gated instead by a shared secret compared constant-time. The token is never
// logged. Consolidating the gate here means the boundary is tested once and both functions inherit
// the exact same hardening (POST-only, fail closed on a blank secret, no early-exit timing leak).

import { jsonResponse } from "./store.ts";

/** Constant-time string comparison. Avoids the early-exit timing leak of `===`. */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * The static-token gate: 405 for non-POST, 401 for a missing/wrong Authorization token, and a
 * blank configured token rejects everything (fail closed). Returns the finished rejection Response
 * when the request must be denied, or null when it may proceed.
 */
export function requireStaticToken(req: Request, token: string): Response | null {
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
  const auth = req.headers.get("Authorization") ?? "";
  if (token.length === 0 || !constantTimeEqual(auth, token)) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  return null;
}
