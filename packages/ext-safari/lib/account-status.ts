import { parseAccountSyncStatus } from "@still/core/sync";
import { parseStoredSettingsRecord, type StoredSettingsRecord } from "@still/core/storage";
import type { AccountStatusSnapshot } from "@still/core/ui";
import { NATIVE_APP } from "./native-settings.js";

/** Only popup/options call this. Account metadata never enters content-script storage. */
export async function readAccountStatus(local: StoredSettingsRecord): Promise<AccountStatusSnapshot | null> {
  const [accountReply, settingsReply] = await Promise.all([
    browser.runtime.sendNativeMessage(NATIVE_APP, { kind: "getAccountSyncStatus" }),
    browser.runtime.sendNativeMessage(NATIVE_APP, { kind: "get" }),
  ]);
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
