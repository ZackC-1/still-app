/** A confirmed account deletion, separate from provider analytics erasure. The retained endpoint's
 * analyticsDeleted describes only its legacy account-UUID deletion; per-device erasure can still
 * be pending. Neither that Boolean nor an absent field proves all shared data was erased. */
export interface AccountDeletionResult {
  readonly deleted: true;
  readonly analyticsDeleted: boolean | null;
  readonly analyticsErasure: "unconfirmed";
}

/** Parse the retained delete-user response without promoting optional provider metadata to proof.
 * A malformed optional status cannot undo a confirmed account deletion; it stays unreported. */
export function readAccountDeletionResult(value: unknown): AccountDeletionResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as { deleted?: unknown; analyticsDeleted?: unknown };
  if (response.deleted !== true) return null;
  return {
    deleted: true,
    analyticsDeleted: typeof response.analyticsDeleted === "boolean" ? response.analyticsDeleted : null,
    analyticsErasure: "unconfirmed",
  };
}
