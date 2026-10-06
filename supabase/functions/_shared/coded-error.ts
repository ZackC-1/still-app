// A thrown error with a stable, fixed code for operators. The shared authenticated gate logs only
// the code (and an HTTP status when one is attached), never the message, so a fixed-message throw
// stays recognisable in the logs without any free text reaching them.

export type FixedErrorCode =
  | "settings_unavailable"
  | "missing_locked_settings"
  | "rate_limiter_unavailable"
  | "invalid_limiter_result"
  | "posthog_identify_failed"
  | "revenuecat_lookup_failed"
  | "web_billing_unconfigured";

export class CodedError extends Error {
  readonly code: FixedErrorCode;
  /** The upstream HTTP status, present only when the failure was an HTTP answer. */
  declare readonly status?: number;

  constructor(code: FixedErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    if (status !== undefined) Object.assign(this, { status });
  }
}

// On the prototype, so an instance carries no own property beyond its code (and status).
Object.defineProperty(CodedError.prototype, "name", { value: "CodedError" });
