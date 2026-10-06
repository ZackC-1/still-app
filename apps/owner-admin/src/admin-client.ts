// The product-policy-admin protocol (supabase/functions/product-policy-admin/handler.ts), as the
// owner page speaks it. Every request carries the signed-in user's own session JWT; the page holds
// no other credential. Every response is validated field by field: anything unexpected is an
// `error`, never a success.
import type { ProductPolicyEnvironment, ProductPolicyNamespace } from "@still/shared-types/product-policy";

export type Namespace = ProductPolicyNamespace;
export type Environment = ProductPolicyEnvironment;

/** One HTTP exchange. status 0 is a transport failure (offline, CORS, aborted). */
export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}
export type AdminTransport = (request: Record<string, unknown>) => Promise<HttpResult>;

export interface PolicyState {
  readonly revision: number;
  readonly body: string | null;
  readonly operationId: string | null;
  readonly cutoff: boolean;
}

type Access = { readonly kind: "forbidden" } | { readonly kind: "unauthorized" } | { readonly kind: "error" };

export type ReadOutcome = { readonly kind: "ok"; readonly state: PolicyState } | Access;

export interface Preview {
  readonly operationId: string;
  readonly previewHash: string;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly body: string;
}
export type PreviewOutcome =
  | ({ readonly kind: "previewed" } & Preview)
  | { readonly kind: "stale" }
  /** The server refused the draft or request itself; nothing was staged or written. */
  | { readonly kind: "invalid" }
  | Access;

export type ApplyRefusal =
  | "unknown_preview" | "preview_mismatch" | "hash_mismatch" | "body_mismatch" | "expired" | "cutoff_required" | "invalid";
export type ApplyOutcome =
  | { readonly kind: "applied"; readonly operationId: string; readonly revision: number; readonly body: string }
  /** Accepted, but the server's own readback didn't confirm it yet: retry the same operation. */
  | { readonly kind: "checking" }
  | { readonly kind: "stale" }
  /** Refused before anything was written. */
  | { readonly kind: "refused"; readonly reason: ApplyRefusal }
  | Access;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const REFUSALS: readonly ApplyRefusal[] = [
  "unknown_preview", "preview_mismatch", "hash_mismatch", "body_mismatch", "expired", "cutoff_required",
];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isRevision = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;

function access(result: HttpResult): Access | null {
  if (result.status === 401) return { kind: "unauthorized" };
  if (result.status === 403) return { kind: "forbidden" };
  return null;
}

export class AdminClient {
  constructor(private readonly send: AdminTransport) {}

  async read(namespace: Namespace, environment: Environment): Promise<ReadOutcome> {
    const result = await this.send({ action: "read", namespace, environment });
    const denied = access(result);
    if (denied) return denied;
    const b = result.body;
    if (
      result.status !== 200 || !isObject(b) || b.status !== "current" || !isRevision(b.revision) ||
      !(b.body === null || typeof b.body === "string") ||
      !(b.operationId === null || (typeof b.operationId === "string" && UUID.test(b.operationId))) ||
      typeof b.cutoff !== "boolean" ||
      (b.revision === 0) !== (b.body === null)
    ) return { kind: "error" };
    return { kind: "ok", state: { revision: b.revision, body: b.body, operationId: b.operationId, cutoff: b.cutoff } };
  }

  /** Stage a new draft at expectedRevision + 1. */
  preview(namespace: Namespace, environment: Environment, expectedRevision: number, draft: unknown): Promise<PreviewOutcome> {
    return this.stage({ action: "preview", namespace, environment, expectedRevision, draft }, expectedRevision);
  }

  /** Stage an earlier revision's values, republished at expectedRevision + 1. */
  previewRollback(namespace: Namespace, environment: Environment, expectedRevision: number, sourceRevision: number): Promise<PreviewOutcome> {
    return this.stage({ action: "preview-rollback", namespace, environment, expectedRevision, sourceRevision }, expectedRevision);
  }

  private async stage(request: Record<string, unknown>, expectedRevision: number): Promise<PreviewOutcome> {
    const result = await this.send(request);
    const denied = access(result);
    if (denied) return denied;
    const b = result.body;
    if (result.status === 409 && isObject(b) && b.status === "stale") return { kind: "stale" };
    if (result.status === 400) return { kind: "invalid" };
    if (
      result.status !== 200 || !isObject(b) || b.status !== "previewed" ||
      typeof b.operationId !== "string" || !UUID.test(b.operationId) ||
      typeof b.previewHash !== "string" || !HASH.test(b.previewHash) ||
      b.expectedRevision !== expectedRevision || b.revision !== expectedRevision + 1 ||
      typeof b.body !== "string"
    ) return { kind: "error" };
    return {
      kind: "previewed",
      operationId: b.operationId,
      previewHash: b.previewHash,
      expectedRevision,
      revision: expectedRevision + 1,
      body: b.body,
    };
  }

  /** Submit exactly the previewed operation. Idempotent: retrying it never applies twice. */
  async apply(namespace: Namespace, environment: Environment, preview: Preview): Promise<ApplyOutcome> {
    const result = await this.send({
      action: "apply",
      namespace,
      environment,
      expectedRevision: preview.expectedRevision,
      operationId: preview.operationId,
      previewHash: preview.previewHash,
      body: preview.body,
    });
    const denied = access(result);
    if (denied) return denied;
    const b = isObject(result.body) ? result.body : {};
    if (result.status === 200 && b.status === "applied" && b.verified === true) {
      if (b.operationId !== preview.operationId || b.revision !== preview.revision || b.body !== preview.body) {
        return { kind: "error" };
      }
      return { kind: "applied", operationId: preview.operationId, revision: preview.revision, body: preview.body };
    }
    if (result.status === 202 && b.status === "checking") return { kind: "checking" };
    if (result.status === 409 && b.status === "stale") return { kind: "stale" };
    if (result.status === 400) return { kind: "refused", reason: "invalid" };
    if ((result.status === 404 || result.status === 409) && REFUSALS.includes(b.status as ApplyRefusal)) {
      return { kind: "refused", reason: b.status as ApplyRefusal };
    }
    return { kind: "error" };
  }
}

/** The production transport: POST to the admin function with the anon key as `apikey` (the
 * gateway requires it) and the user's own session JWT as the bearer. No token, no request. */
export function httpTransport(options: {
  functionUrl: string;
  anonKey: string;
  accessToken: () => Promise<string | null>;
  fetch?: typeof fetch;
}): AdminTransport {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  return async (request) => {
    const token = await options.accessToken();
    if (!token) return { status: 401, body: null };
    try {
      const response = await doFetch(options.functionUrl, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: {
          authorization: `Bearer ${token}`,
          apikey: options.anonKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    } catch {
      return { status: 0, body: null };
    }
  };
}
