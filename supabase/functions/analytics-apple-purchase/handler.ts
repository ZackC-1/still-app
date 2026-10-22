import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import {
  type AppleAccessVerifier,
  isAppleEvidence,
  type VerifiedAppleTransaction,
} from "../_shared/apple-access.ts";
import { readBoundedBody } from "../_shared/request-body.ts";
import {
  clientIp,
  limiterAddress,
  type RateLimiter,
} from "../_shared/rate-limit.ts";
import { jsonResponse, optionsResponse } from "../_shared/store.ts";
import {
  type AppleAnalyticsScope,
  type AppleAnalyticsState,
  type AppleAnalyticsStore,
} from "./store.ts";

export interface AppleAnalyticsDeps extends AuthDeps {
  readonly enabled: boolean;
  readonly projectKeySha256: string | null;
  readonly limiter: RateLimiter | null;
  readonly store: AppleAnalyticsStore | null;
  readonly verifier: AppleAccessVerifier | null;
}
const hex = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const unavailable = () =>
  jsonResponse(200, { schema: 1, status: "unavailable" });
export async function capabilityHash(capability: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(capability),
      ),
    ),
  ].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function sameTransaction(
  a: VerifiedAppleTransaction,
  b: VerifiedAppleTransaction,
): boolean {
  return a.key === b.key && a.transactionId === b.transactionId &&
    a.originalTransactionId === b.originalTransactionId &&
    a.bundleId === b.bundleId && a.productId === b.productId &&
    a.environment === b.environment && a.localOnly === b.localOnly;
}
function descriptors(state: AppleAnalyticsState) {
  const properties = {
    product: "still-pro-v3",
    purchase_origin: state.surface === "app-ios"
      ? "app_store"
      : "mac_app_store",
  };
  return [
    ...(state.purchasedAt === null ? [] : [{
      uuid: state.saleId,
      event: "purchase_recorded",
      timestamp: new Date(state.purchasedAt).toISOString(),
      properties,
    }]),
    ...(state.refundedAt === null ? [] : [{
      uuid: state.refundId,
      event: "purchase_refunded",
      timestamp: new Date(state.refundedAt).toISOString(),
      properties,
    }]),
  ];
}
/** Optional analytics only. This route cannot mutate purchase rights or issue an access proof. */
export async function handleApplePurchaseAnalytics(
  req: Request,
  deps: AppleAnalyticsDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }
  try {
    if (
      !deps.enabled || !deps.store || !deps.verifier || !deps.limiter ||
      !deps.projectKeySha256 || req.signal.aborted
    ) return unavailable();
    const ip = clientIp(req);
    if (
      !ip ||
      await deps.limiter.consume(
          `apple-analytics:ip:${limiterAddress(ip)}`,
          12,
          60,
        ) > 0
    ) return unavailable();
    const bytes = await readBoundedBody(req, { maxBytes: 36_000 });
    if (bytes === null) return unavailable();
    let body: unknown;
    try {
      body = JSON.parse(bytes);
    } catch {
      return unavailable();
    }
    if (
      !object(body) || !hex(body.originProof) ||
      body.projectKeySha256 !== deps.projectKeySha256 ||
      !["prepare", "commit", "observe"].includes(body.action as string) ||
      !object(body.scope)
    ) return unavailable();
    const anonymous = body.scope.kind === "anonymous";
    if (
      anonymous
        ? Object.keys(body.scope).sort().join(",") !== "anonIndex,kind" ||
          !Number.isInteger(body.scope.anonIndex) ||
          (body.scope.anonIndex as number) < 0 ||
          (body.scope.anonIndex as number) > 255
        : body.scope.kind !== "subject" ||
          Object.keys(body.scope).join(",") !== "kind"
    ) return unavailable();
    const expected = body.action === "prepare"
      ? "action,appVersion,originProof,projectKeySha256,scope,surface"
      : body.action === "commit"
      ? "action,capability,originProof,projectKeySha256,scope,transaction"
      : "action,capability,originProof,projectKeySha256,scope";
    if (Object.keys(body).sort().join(",") !== expected) return unavailable();
    const b = body;
    const work = async (holder: string | null): Promise<Response> => {
      const scope: AppleAnalyticsScope = {
        originProof: b.originProof as string,
        projectKeySha256: deps.projectKeySha256!,
        holder,
        anonIndex: anonymous
          ? (b.scope as Record<string, unknown>).anonIndex as number
          : null,
      };
      if (b.action === "prepare") {
        if (
          !["app-ios", "app-macos"].includes(b.surface as string) ||
          typeof b.appVersion !== "string" ||
          !/^\d+(\.\d+){1,3}$/.test(b.appVersion)
        ) return unavailable();
        const capability = [...crypto.getRandomValues(new Uint8Array(32))].map(
          (x) => x.toString(16).padStart(2, "0"),
        ).join("");
        const accepted = await deps.store!.prepare(
          await capabilityHash(capability),
          scope,
          b.surface as string,
          b.appVersion,
        );
        return accepted && !req.signal.aborted
          ? jsonResponse(200, { schema: 1, status: "prepared", capability })
          : unavailable();
      }
      if (!hex(b.capability)) return unavailable();
      const hash = await capabilityHash(b.capability);
      const original = await deps.store!.read(hash, scope);
      if (!original || req.signal.aborted) return unavailable();
      let transaction: VerifiedAppleTransaction | null;
      if (b.action === "commit") {
        if (!isAppleEvidence(b.transaction)) return unavailable();
        transaction = await deps.verifier!.authenticate(b.transaction);
      } else transaction = original.transaction;
      if (
        !transaction || transaction.environment !== "production" ||
        transaction.localOnly || req.signal.aborted
      ) return unavailable();
      const fresh = await deps.verifier!.refresh(transaction);
      if (
        !fresh || !sameTransaction(transaction, fresh) || fresh.localOnly ||
        !Number.isSafeInteger(fresh.purchasedAt) || req.signal.aborted
      ) return unavailable();
      const state = await deps.store!.commit(hash, scope, fresh);
      if (!state || req.signal.aborted) return unavailable();
      // SQL commit rechecks the original scope and erasure AFTER Apple/provider latency.
      return jsonResponse(200, {
        schema: 1,
        status: "canonical",
        events: descriptors(state),
      });
    };
    return anonymous
      ? await work(null)
      : await withAuthenticatedUser(req, deps, (holder) => work(holder));
  } catch {
    return unavailable();
  }
}
