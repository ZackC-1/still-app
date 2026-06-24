// User-data access for the account functions (U15). delete-user legitimately needs admin power
// (deleting the auth.users row, which cascades to profile + entitlement); export reads the caller's
// own rows. The interface is what handlers depend on so tests can inject a mock.

export interface ExportedData {
  readonly user_id: string;
  readonly profile: unknown | null;
  readonly entitlement: unknown | null;
}

export interface UserStore {
  /** Delete the auth user (cascades to profile + entitlement). Idempotent. */
  deleteUser(userId: string): Promise<void>;
  getProfile(userId: string): Promise<unknown | null>;
  getEntitlement(userId: string): Promise<unknown | null>;
}
