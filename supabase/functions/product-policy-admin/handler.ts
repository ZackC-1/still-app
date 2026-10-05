// Owner-only product policy operations (U6): read, preview, preview-rollback and apply.
//
// Authority. A verified, unexpired Supabase user JWT (HS256 locally, ES256 hosted; `exp` required)
// whose subject is on the server-side allowlist private.product_policy_owners. The allowlist is
// checked by the database inside every operation, so a removed owner loses access at once. Nothing
// in the body (no email, flag or account id) can make a caller an owner.
//
// Flow. preview stages the exact canonical body against the actual current revision and returns an
// operation id, a preview hash over every bound field and a five-minute expiry. apply submits that
// exact operation (same owner, namespace, environment, expected revision, hash and body); the
// database compares-and-sets the revision and is idempotent per operation id, so a retry after a
// lost reply returns the committed result and never applies twice. Success is reported only after an
// authoritative readback matches what was committed; otherwise the answer is "checking" and the
// owner retries the same apply. Rollback is a preview of an earlier revision's values at the next
// revision. Every response is `Cache-Control: no-store`.
//
// Paid. A sales body is only the remote second key; packaged builds AND it with their compiled
// switch. Migration 0016 refuses any cutoff snapshot, so an activating sales body with no cutoff on
// record answers "cutoff_required" and writes nothing, whatever cutoff.ts holds.
import { authenticatedClaims, verifyJwt } from "../_shared/jwt.ts";
import type { AuthDeps } from "../_shared/auth.ts";
import { jsonResponse, optionsResponse } from "../_shared/store.ts";
import { isUuid } from "../_shared/types.ts";
import {
  boundedJson,
  canonicalPolicyBody,
  exactKeys,
  isEnvironment,
  isNamespace,
  isRevision,
  MAX_POLICY_REVISION,
  parsePolicyBody,
  remoteSurfaceSummary,
  renderDraft,
} from "../product-policy/policy-wire.ts";
import type { PaidCutoffSnapshot } from "./cutoff.ts";
import {
  type PolicyAdminStore,
  PolicyOwnerRequired,
  PolicyRequestRejected,
} from "./store.ts";
import type {
  ProductPolicyEnvironment,
  ProductPolicyNamespace,
} from "../../../packages/shared-types/src/product-policy.ts";

/** The production auth wiring: HS256 secret (local) or the project JWKS (hosted), and the expected
 * authenticated-user claims (project issuer, aud and role "authenticated"). A validly signed anon,
 * service_role or foreign-issuer token is refused before the store is reached. */
export function ownerAuthDeps(
  supabaseUrl: string,
  jwtSecret: string,
): AuthDeps {
  return {
    jwtSecret,
    jwksUrl: supabaseUrl
      ? `${supabaseUrl}/auth/v1/.well-known/jwks.json`
      : undefined,
    expected: authenticatedClaims(supabaseUrl || undefined),
  };
}

export interface ProductPolicyAdminDeps extends AuthDeps {
  readonly store: PolicyAdminStore;
  /** The packaged first-activation snapshot (cutoff.ts). Migration 0016 refuses any non-null
   * snapshot, so today only null reaches a successful apply. */
  readonly cutoffSnapshot: PaidCutoffSnapshot | null;
}

const MAX_REQUEST = 16384;
const NO_STORE = { "cache-control": "no-store" };
const HASH = /^[0-9a-f]{64}$/;
const respond = (status: number, body: unknown) =>
  jsonResponse(status, body, NO_STORE);

class BadRequest extends Error {}

function target(request: Record<string, unknown>): {
  namespace: ProductPolicyNamespace;
  environment: ProductPolicyEnvironment;
} {
  const { namespace, environment } = request;
  if (!isNamespace(namespace) || !isEnvironment(environment)) {
    throw new BadRequest();
  }
  return { namespace, environment };
}

function expected(value: unknown): number {
  if (!isRevision(value, 0) || value >= MAX_POLICY_REVISION) {
    throw new BadRequest();
  }
  return value;
}

async function operate(
  owner: string,
  request: unknown,
  deps: ProductPolicyAdminDeps,
): Promise<Response> {
  if (
    request === null || typeof request !== "object" || Array.isArray(request)
  ) throw new BadRequest();
  const action = (request as Record<string, unknown>).action;

  if (action === "read") {
    if (!exactKeys(request, ["action", "namespace", "environment"])) {
      throw new BadRequest();
    }
    const { namespace, environment } = target(request);
    const state = await deps.store.state(owner, namespace, environment);
    const policy = state.body === null
      ? null
      : parsePolicyBody(namespace, environment, state.body, state.revision);
    if (state.body !== null && !policy) {
      throw new Error("Stored product policy no longer parses");
    }
    return respond(200, {
      status: "current",
      revision: state.revision,
      body: state.body,
      operationId: state.operationId,
      cutoff: state.cutoff,
      remote: remoteSurfaceSummary(namespace, policy),
    });
  }

  if (action === "preview" || action === "preview-rollback") {
    const keys = action === "preview"
      ? ["action", "namespace", "environment", "expectedRevision", "draft"]
      : [
        "action",
        "namespace",
        "environment",
        "expectedRevision",
        "sourceRevision",
      ];
    if (!exactKeys(request, keys)) throw new BadRequest();
    const { namespace, environment } = target(request);
    const expectedRevision = expected(request.expectedRevision);
    let draftBody: string | null = null;
    let rollbackOf: number | null = null;
    if (action === "preview") {
      draftBody = renderDraft(
        namespace,
        environment,
        expectedRevision + 1,
        request.draft,
      );
      if (draftBody === null) return respond(400, { error: "policy-invalid" });
    } else {
      if (!isRevision(request.sourceRevision, 1)) throw new BadRequest();
      rollbackOf = request.sourceRevision;
    }
    const result = await deps.store.preview(
      owner,
      namespace,
      environment,
      expectedRevision,
      draftBody,
      rollbackOf,
    );
    if (result.status === "stale") {
      return respond(409, {
        status: "stale",
        currentRevision: result.currentRevision,
      });
    }
    // The staged body must be exactly what this server renders and clients parse.
    const after = parsePolicyBody(
      namespace,
      environment,
      result.body,
      expectedRevision + 1,
    );
    if (
      !after || canonicalPolicyBody(namespace, after) !== result.body ||
      (draftBody !== null && result.body !== draftBody) ||
      result.expectedRevision !== expectedRevision
    ) throw new Error("Staged product policy differs from the request");
    const before = result.currentBody === null ? null : parsePolicyBody(
      namespace,
      environment,
      result.currentBody,
      expectedRevision,
    );
    return respond(200, {
      status: "previewed",
      operationId: result.operationId,
      previewHash: result.previewHash,
      kind: result.kind,
      rollbackOf: result.rollbackOf,
      expectedRevision: result.expectedRevision,
      revision: result.revision,
      body: result.body,
      expiresAt: result.expiresAt,
      before: remoteSurfaceSummary(namespace, before),
      after: remoteSurfaceSummary(namespace, after),
    });
  }

  if (action === "apply") {
    const keys = [
      "action",
      "namespace",
      "environment",
      "expectedRevision",
      "operationId",
      "previewHash",
      "body",
    ];
    if (!exactKeys(request, keys)) throw new BadRequest();
    const { namespace, environment } = target(request);
    const expectedRevision = expected(request.expectedRevision);
    const { operationId, previewHash, body } = request;
    if (
      !isUuid(operationId as string) || typeof previewHash !== "string" ||
      !HASH.test(previewHash)
    ) {
      throw new BadRequest();
    }
    if (typeof body !== "string") throw new BadRequest();
    const policy = parsePolicyBody(
      namespace,
      environment,
      body,
      expectedRevision + 1,
    );
    if (!policy || canonicalPolicyBody(namespace, policy) !== body) {
      return respond(400, { error: "policy-invalid" });
    }
    const result = await deps.store.apply(owner, {
      operationId: operationId as string,
      previewHash,
      namespace,
      environment,
      expectedRevision,
      body,
    }, deps.cutoffSnapshot);
    if (result.status === "stale") {
      return respond(409, {
        status: "stale",
        currentRevision: result.currentRevision,
      });
    }
    if (result.status === "wrong_owner") {
      return respond(403, { status: "wrong_owner" });
    }
    if (result.status === "unknown_preview") {
      return respond(404, { status: "unknown_preview" });
    }
    if (result.status !== "applied") {
      return respond(409, { status: result.status });
    }
    // Accepted is not yet success: read the authoritative current state back.
    let verified = false;
    try {
      const state = await deps.store.state(owner, namespace, environment);
      verified = state.revision === result.revision &&
        state.body === result.body &&
        state.operationId === result.operationId;
    } catch {
      verified = false;
    }
    if (!verified) {
      return respond(202, {
        status: "checking",
        operationId: result.operationId,
        revision: result.revision,
      });
    }
    return respond(200, {
      status: "applied",
      verified: true,
      replay: result.replay,
      operationId: result.operationId,
      revision: result.revision,
      body: result.body,
    });
  }

  throw new BadRequest();
}

export async function handleProductPolicyAdmin(
  req: Request,
  deps: ProductPolicyAdminDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") {
    return respond(405, { error: "method_not_allowed" });
  }
  const match = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
  if (!match) return respond(401, { error: "unauthorized" });
  const claims = await verifyJwt(match[1]!, {
    hs256Secret: deps.jwtSecret,
    jwksUrl: deps.jwksUrl,
    expected: deps.expected,
  });
  // `exp` is mandatory here: an owner token without an expiry is refused.
  if (!claims || !isUuid(claims.sub) || typeof claims.exp !== "number") {
    return respond(401, { error: "unauthorized" });
  }
  let request: unknown;
  try {
    request = await boundedJson(req, MAX_REQUEST);
  } catch {
    return respond(400, { error: "request-shape" });
  }
  try {
    return await operate(claims.sub, request, deps);
  } catch (error) {
    if (error instanceof BadRequest || error instanceof PolicyRequestRejected) {
      return respond(400, { error: "request-shape" });
    }
    if (error instanceof PolicyOwnerRequired) {
      return respond(403, { error: "forbidden" });
    }
    // Fixed text only; store errors are already stripped of driver details.
    console.error("product policy admin failed");
    return respond(500, { error: "internal" });
  }
}
