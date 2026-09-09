import { safeParse } from "../storage/settings-validation.js";

/** Display-only status from this device's sync session; never a settings or entitlement input. */
export interface AccountSyncStatus {
  readonly accountId: string;
  readonly email: string | null;
  readonly lastSyncedAt: number | null;
  readonly pendingUpload: boolean;
  readonly cloudReachable: boolean;
  readonly updatedAt: number;
}

export function parseAccountSyncStatus(raw: unknown): AccountSyncStatus | null {
  const value: unknown = typeof raw === "string" ? safeParse(raw) : raw;
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const timestamp = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 8.64e15;
  if (typeof v.accountId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v.accountId)
    || !(v.email === null || (typeof v.email === "string" && v.email.length <= 320))
    || !(v.lastSyncedAt === null || timestamp(v.lastSyncedAt))
    || typeof v.pendingUpload !== "boolean" || typeof v.cloudReachable !== "boolean" || !timestamp(v.updatedAt)) return null;
  return { accountId: v.accountId, email: v.email, lastSyncedAt: v.lastSyncedAt,
    pendingUpload: v.pendingUpload, cloudReachable: v.cloudReachable, updatedAt: v.updatedAt };
}
