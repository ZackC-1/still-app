import { parseStoredSettingsRecord } from "./settings-validation.js";
import { SETTINGS_FIELDS } from "@still/shared-types";
import type { SettingsIntent } from "./atomic-settings.js";
import type { StoredSettingsRecord } from "./adapter.js";

const KIND = "still:settings-intent";
export function settingsIntentMessage(intent: SettingsIntent): unknown { return { kind: KIND, ...intent }; }
export function readSettingsIntent(message: unknown): SettingsIntent | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const value = message as Record<string, unknown>;
  if (Object.keys(value).length !== 4 || value.kind !== KIND || typeof value.path !== "string" ||
    !SETTINGS_FIELDS.includes(value.path as SettingsIntent["path"]) || typeof value.value !== "boolean" ||
    typeof value.updatedAt !== "number" || !Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0) return null;
  return { path: value.path as SettingsIntent["path"], value: value.value, updatedAt: value.updatedAt };
}

/** Free settings authority is registered independently of auth/session configuration. */
export function createSettingsIntentRouter(
  commit: (intent: SettingsIntent) => Promise<StoredSettingsRecord>, extensionId: string, extensionOrigin: string,
  replace?: (record: StoredSettingsRecord) => Promise<void>,
): (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean {
  return (message, sender, reply) => {
    if (sender.id !== extensionId || typeof sender.url !== "string" || !sender.url.startsWith(extensionOrigin)) return false;
    if (message && typeof message === "object" && (message as { kind?: unknown }).kind === "still:settings-record") {
      if (!replace || JSON.stringify(message).length > 131_072 || Object.keys(message).length !== 2) return false;
      const record = parseStoredSettingsRecord((message as { record?: unknown }).record);
      if (!record || record.atomic) return false;
      void replace(record).then(() => reply({ status: "committed" }), () => reply({ status: "unavailable" }));
      return true;
    }
    const intent = readSettingsIntent(message);
    if (!intent) return false;
    void commit(intent).then(record => reply({ status: "committed", record }), () => reply({ status: "unavailable" }));
    return true;
  };
}
