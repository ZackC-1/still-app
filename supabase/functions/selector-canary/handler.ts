import { constantTimeEqual } from "../_shared/token.ts";
import { jsonResponse } from "../_shared/store.ts";

// Invocation gate for the scheduler-triggered canary (verify_jwt=false). A schedule is NOT an
// access boundary: without this gate anyone who learns the function URL can trigger admin DB
// reads and outbound page fetches at will. Same pattern as the RevenueCat webhook (KTD5): the
// scheduler sends a static token in the Authorization header, compared constant-time; a blank
// configured token rejects everything (fail closed). The token is never logged.

export interface CanaryRequestDeps {
  /** SELECTOR_CANARY_INVOCATION_TOKEN — shared only with the scheduler. */
  readonly token: string;
  /** Loads the current rule set and runs the canary; returns the run report. */
  readonly run: () => Promise<unknown>;
}

export async function handleCanaryRequest(
  req: Request,
  deps: CanaryRequestDeps,
): Promise<Response> {
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  const auth = req.headers.get("Authorization") ?? "";
  if (deps.token.length === 0 || !constantTimeEqual(auth, deps.token)) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  try {
    return jsonResponse(200, await deps.run());
  } catch (error) {
    console.error("selector-canary run failed:", error);
    return jsonResponse(500, { error: "canary_failed" });
  }
}
