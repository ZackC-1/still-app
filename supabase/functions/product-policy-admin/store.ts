// The owner-only product policy store (U6). Handlers depend on this interface; the Postgres
// implementation (pg-policy-admin-store.ts) connects as still_policy_admin.
import type {
  ProductPolicyEnvironment,
  ProductPolicyNamespace,
} from "../../../packages/shared-types/src/product-policy.ts";
import type { PaidCutoffSnapshot } from "./cutoff.ts";

/** The authoritative current state for one namespace and environment. Revision 0 means no policy
 * has ever been published there (Off). */
export interface PolicyState {
  readonly revision: number;
  readonly body: string | null;
  readonly operationId: string | null;
  readonly cutoff: boolean;
}

export type PreviewResult =
  | { readonly status: "stale"; readonly currentRevision: number }
  | {
    readonly status: "previewed";
    readonly operationId: string;
    readonly previewHash: string;
    readonly kind: "apply" | "rollback";
    readonly rollbackOf: number | null;
    readonly expectedRevision: number;
    readonly revision: number;
    readonly body: string;
    readonly currentBody: string | null;
    /** Epoch milliseconds, database clock. */
    readonly expiresAt: number;
  };

export type ApplyRefusal =
  | "unknown_preview"
  | "wrong_owner"
  | "preview_mismatch"
  | "hash_mismatch"
  | "body_mismatch"
  | "expired"
  | "cutoff_required";

export type ApplyResult =
  | {
    readonly status: "applied";
    readonly replay: boolean;
    readonly operationId: string;
    readonly revision: number;
    readonly body: string;
  }
  /** currentRevision is absent when an already-refused operation is retried. */
  | { readonly status: "stale"; readonly currentRevision?: number }
  | { readonly status: ApplyRefusal };

export interface ApplyRequest {
  readonly operationId: string;
  readonly previewHash: string;
  readonly namespace: ProductPolicyNamespace;
  readonly environment: ProductPolicyEnvironment;
  readonly expectedRevision: number;
  readonly body: string;
}

export interface PolicyAdminStore {
  state(
    owner: string,
    namespace: ProductPolicyNamespace,
    environment: ProductPolicyEnvironment,
  ): Promise<PolicyState>;
  /** Exactly one of `body` (a new draft) and `rollbackOf` (an earlier revision) is non-null. */
  preview(
    owner: string,
    namespace: ProductPolicyNamespace,
    environment: ProductPolicyEnvironment,
    expectedRevision: number,
    body: string | null,
    rollbackOf: number | null,
  ): Promise<PreviewResult>;
  apply(
    owner: string,
    request: ApplyRequest,
    cutoff: PaidCutoffSnapshot | null,
  ): Promise<ApplyResult>;
}

/** The verified subject is not on the server-side owner allowlist. */
export class PolicyOwnerRequired extends Error {
  constructor() {
    super("Product policy owner required");
    this.name = "PolicyOwnerRequired";
  }
}

/** The database refused the request's shape (a bound it enforces itself). */
export class PolicyRequestRejected extends Error {
  constructor() {
    super("Product policy request rejected");
    this.name = "PolicyRequestRejected";
  }
}
