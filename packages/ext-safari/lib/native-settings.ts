import { parseStoredSettingsRecord, type StoredSettingsRecord } from "@still/core/storage";
import type { LeftoverAdoption } from "./app-group-reconcile.js";

// The native App-Group message the extension uses to WRITE settings into the app's shared container
// (KTD4). Shared by the background reconciler and the popup: on iOS Safari the background may be
// asleep when the user toggles a setting in the popup, so the popup pushes its own edit directly —
// otherwise the write sits in browser.storage.local and never reaches the app until some later
// content-script reconcile happens to run.

/** The native host id (the app's bundle id); browser.runtime.sendNativeMessage targets it. */
export const NATIVE_APP = "com.chartash.still";

/** Write a settings record to the App Group via the app's SafariWebExtensionHandler. Best-effort:
 * a missing native host (extension running outside the app container) is swallowed. */
export async function pushSettingsToApp(record: StoredSettingsRecord): Promise<void> {
  try {
    await browser.runtime.sendNativeMessage(NATIVE_APP, {
      kind: "set",
      settings: JSON.stringify(record),
    });
  } catch {
    /* native host unavailable */
  }
}

/** Offer the retained browser-storage copy to the app after a reinstall (owner decision 30). The
 * app's handler replaces its record only while that record is still the untouched first record.
 * Resolves null when the app cannot be reached or the reply is unreadable. */
export async function adoptIntoApp(record: StoredSettingsRecord): Promise<LeftoverAdoption | null> {
  try {
    const { intentCommitted: _committed, ...stored } = record;
    const reply: unknown = await browser.runtime.sendNativeMessage(NATIVE_APP, {
      kind: "settingsAdopt",
      settings: JSON.stringify(stored),
    });
    return parseAdoptionReply(reply);
  } catch {
    return null; /* native host unavailable */
  }
}

/** Parse the handler's `{ settings: "<json>" }` envelope around `{status, record}`. */
export function parseAdoptionReply(reply: unknown): LeftoverAdoption | null {
  if (!reply || typeof reply !== "object") return null;
  const raw = (reply as { settings?: unknown }).settings;
  if (typeof raw !== "string" || raw === "") return null;
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return null; }
  if (!body || typeof body !== "object") return null;
  const { status, record } = body as { status?: unknown; record?: unknown };
  if (status !== "adopted" && status !== "kept" && status !== "refused") return null;
  if (record === null) return { status, record: null };
  const parsed = parseStoredSettingsRecord(record);
  return parsed ? { status, record: parsed } : null;
}
