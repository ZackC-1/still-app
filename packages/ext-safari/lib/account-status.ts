import { parseAccountSyncStatus } from "@still/core/sync";
import { parseStoredSettingsRecord, sendSafariNativeMessage, type StoredSettingsRecord } from "@still/core/storage";
import type { AccountStatusSnapshot } from "@still/core/ui";

/**
 * Only popup/options call this. Account metadata never enters content-script storage. Both reads
 * take their turn on the page's one native channel, never overlapping a settings save (ISS-0050).
 */
export async function readAccountStatus(
  current: StoredSettingsRecord | (() => StoredSettingsRecord),
): Promise<AccountStatusSnapshot | null> {
  const accountReply = (await sendSafariNativeMessage({ kind: "getAccountSyncStatus" })) as { accountSyncStatus?: unknown } | undefined;
  const settingsReply = (await sendSafariNativeMessage({ kind: "get" })) as { settings?: unknown } | undefined;
  // Compared with this page's settings as they are now: saves queued ahead of this read have
  // already reached both sides, so they are not a pending upload.
  const local = typeof current === "function" ? current() : current;
  if (!accountReply || !("accountSyncStatus" in accountReply)) throw new Error("Still app unavailable");
  if (accountReply.accountSyncStatus === null) return null;
  const status = parseAccountSyncStatus(accountReply.accountSyncStatus);
  const app = parseStoredSettingsRecord(settingsReply?.settings);
  if (!status || !app) throw new Error("Still app status unavailable");
  const matches = local.settings.globalOn === app.settings.globalOn &&
    (Object.keys(local.settings.services) as (keyof typeof local.settings.services)[])
      .every((service) => local.settings.services[service] === app.settings.services[service]);
  return {
    ...status,
    extensionMatchesApp: matches,
    // A popup edit can reach the App Group while the containing app is asleep. Its historical
    // success must not describe newer local settings as uploaded.
    pendingUpload: status.pendingUpload || !matches || app.settings.updatedAt > status.updatedAt,
  };
}
