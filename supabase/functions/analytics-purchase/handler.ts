import { withAuthenticatedUser, type AuthDeps } from "../_shared/auth.ts";
import { isOriginProof } from "../_shared/erasure-store.ts";
import { readBoundedBody } from "../_shared/request-body.ts";
import { enforceRateLimit, type RateLimiter } from "../_shared/rate-limit.ts";
import { jsonResponse } from "../_shared/store.ts";
import type {
  PurchaseAnalyticsClaim,
  PurchaseAnalyticsStore,
} from "./store.ts";

export interface PurchaseAnalyticsDeps extends AuthDeps {
  readonly enabled: boolean;
  readonly projectKeySha256: string | null;
  readonly store: PurchaseAnalyticsStore | null;
  readonly limiter: RateLimiter | null;
  readonly send: (
    claim: PurchaseAnalyticsClaim,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly now?: () => number;
}
/** One originating-device request, at most two events and four seconds of dispatch lifetime.
 * No timer/worker retries. Cancellation is best effort: erasure fences plus bounded late-write
 * sweeps remain necessary for a provider request already in flight. */
export function handlePurchaseAnalytics(
  req: Request,
  deps: PurchaseAnalyticsDeps,
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const deadline = now() + 4_000;
  return withAuthenticatedUser(req, deps, async (account) => {
    if (!deps.enabled || !deps.projectKeySha256 || !deps.store || !deps.limiter)
      return jsonResponse(503, { error: "unavailable" });
    let input: unknown;
    try {
      input = JSON.parse(await readBoundedBody(req, { maxBytes: 512 }));
    } catch {
      return jsonResponse(400, { error: "invalid_request" });
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      return jsonResponse(400, { error: "invalid_request" });
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).sort().join(",") !== "originProof,projectKeySha256" ||
      !isOriginProof(body.originProof) ||
      !isOriginProof(body.projectKeySha256)
    )
      return jsonResponse(400, { error: "invalid_request" });
    if (body.projectKeySha256 !== deps.projectKeySha256)
      return jsonResponse(200, { state: "test_channel" });
    // Share the existing closed per-account/per-address identity budget; no unlimited new bucket.
    const limited = await enforceRateLimit(
      deps.limiter,
      "analytics-identify",
      account,
      req,
      { maxPerUser: 30, maxPerIp: 120, windowSeconds: 600 },
      { network: true },
    );
    if (limited) return limited;
    let delivered = 0;
    for (let i = 0; i < 2 && now() < deadline && !req.signal.aborted; i++) {
      const claim = await deps.store.claim(account, body.originProof);
      if (!claim) break;
      let sent = false;
      try {
        if (
          now() >= deadline ||
          req.signal.aborted ||
          !(await deps.store.current(account, body.originProof, claim)) ||
          now() >= deadline ||
          req.signal.aborted
        )
          break;
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.signal.addEventListener("abort", abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const remaining = Math.min(1_000, deadline - now());
          if (remaining <= 0 || req.signal.aborted) break;
          sent = await Promise.race([
            deps.send(claim, controller.signal).catch(() => false),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => {
                controller.abort();
                resolve(false);
              }, remaining);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          req.signal.removeEventListener("abort", abort);
          controller.abort();
        }
      } finally {
        await deps.store.finish(claim, sent);
      }
      if (!sent) break;
      delivered++;
    }
    return jsonResponse(200, { state: "checked", delivered });
  });
}
