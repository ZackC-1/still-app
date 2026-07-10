import { requireStaticToken } from "../_shared/token.ts";
import { jsonResponse } from "../_shared/store.ts";

// Invocation gate for the scheduler-triggered canary (verify_jwt=false). A schedule is NOT an
// access boundary: without this gate anyone who learns the function URL can trigger admin DB
// reads and outbound page fetches at will. Gated by the same shared static-token check as the
// RevenueCat webhook (requireStaticToken) — the scheduler sends the token in the Authorization
// header; a blank configured token rejects everything (fail closed).

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
  const denied = requireStaticToken(req, deps.token);
  if (denied) return denied;

  try {
    return jsonResponse(200, await deps.run());
  } catch (error) {
    console.error("selector-canary run failed:", error);
    return jsonResponse(500, { error: "canary_failed" });
  }
}
