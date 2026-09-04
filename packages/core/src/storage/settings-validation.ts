import { SERVICE_IDS, type ServiceId, type StillSettings } from "@still/shared-types";
import type {
  SettingsSyncMetadata,
  StoredSettingsRecord,
  SyncedSettingsEnvelope,
} from "./adapter.js";

// The ONE place the StillSettings wire shape is validated and untrusted JSON is parsed defensively.
// Shared by the WKWebView storage adapter and the Safari background reconcile (full shape guard), and
// by the native action bridge (safeParse only — its replies are credential/purchase shapes, NOT
// settings, so they must not be routed through the settings guard). The Swift SettingsBridge.parse
// mirrors this shape guard; StillKit's SettingsTests assert the two stay in parity. This is the single
// point to harden (e.g. depth / __proto__ checks) if needed.

/** Coerce a value (a parsed object or a JSON string) into StillSettings, or null if it isn't the
 * expected shape. Reconstructs from a whitelist so unknown fields cannot ride along. */
export function parseSettings(value: unknown): StillSettings | null {
  if (value == null || value === "") return null;
  const obj: unknown = typeof value === "string" ? safeParse(value) : value;
  if (!obj || typeof obj !== "object") return null;
  const s = obj as Partial<StillSettings>;
  if (typeof s.globalOn !== "boolean" || typeof s.updatedAt !== "number" || !Number.isFinite(s.updatedAt)) {
    return null;
  }
  const services = parseServices(s.services);
  if (!services) return null;
  // `pauses` is optional for back-compat (a blob that predates the field must not be discarded —
  // dropping the whole object makes readProfile() return null and silently wipes the user's synced
  // settings on upgrade), and a present-but-malformed pauses is still rejected, preserving the
  // whitelist guarantee. But VALID stored pauses are deliberately ignored (normalized to []): the
  // pause-on-this-site UI was removed 2026-07-06 (PR #42) while the engine and the Chromium DNR
  // gate still honor stored pauses — so an upgraded user with e.g. youtube.com paused would have
  // Still silently disabled there with no reachable way to resume it. Ignoring pauses at the ONE
  // parse choke point neutralizes the orphaned state everywhere (and the next persisted write
  // clears it). If the pause feature returns, restore `[...s.pauses]` here.
  if (s.pauses !== undefined && !(Array.isArray(s.pauses) && s.pauses.every((p) => typeof p === "string"))) {
    return null;
  }
  return {
    globalOn: s.globalOn,
    services,
    pauses: [],
    updatedAt: s.updatedAt,
  };
}

export function parseSettingsSyncMetadata(value: unknown): SettingsSyncMetadata | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as {
    version?: unknown;
    serverUpdatedAt?: unknown;
    lastWriteId?: unknown;
  };
  if (
    typeof obj.version !== "number" ||
    !Number.isSafeInteger(obj.version) ||
    obj.version < 0 ||
    typeof obj.serverUpdatedAt !== "string" ||
    Number.isNaN(Date.parse(obj.serverUpdatedAt)) ||
    !(obj.lastWriteId === null || typeof obj.lastWriteId === "string")
  ) {
    return null;
  }
  return {
    version: obj.version,
    serverUpdatedAt: obj.serverUpdatedAt,
    lastWriteId: obj.lastWriteId,
  };
}

/** Parse the canonical server envelope returned by read/write/realtime. */
export function parseSyncedSettingsEnvelope(value: unknown): SyncedSettingsEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as {
    settings?: unknown;
    settings_version?: unknown;
    settings_server_updated_at?: unknown;
    settings_last_write_id?: unknown;
    version?: unknown;
    serverUpdatedAt?: unknown;
    lastWriteId?: unknown;
  };
  const settings = parseSettings(obj.settings);
  if (!settings) return null;
  const version = obj.settings_version ?? obj.version;
  const serverUpdatedAt = obj.settings_server_updated_at ?? obj.serverUpdatedAt;
  const lastWriteId = obj.settings_last_write_id ?? obj.lastWriteId ?? null;
  const metadata = parseSettingsSyncMetadata({ version, serverUpdatedAt, lastWriteId });
  return metadata ? { settings, ...metadata } : null;
}

/** Parse extension/App Group storage. Backward compatible with old settings-only records. Accepts a
 * parsed object OR a JSON string — the Swift SettingsBridge replies with the record JSON-encoded, so
 * the record branch must see through strings exactly like parseSettings does. */
export function parseStoredSettingsRecord(value: unknown): StoredSettingsRecord | null {
  const direct = parseSettings(value);
  if (direct) return { settings: direct, syncMetadata: null };

  const decoded: unknown = typeof value === "string" ? safeParse(value) : value;
  if (!decoded || typeof decoded !== "object") return null;
  const obj = decoded as { settings?: unknown; syncMetadata?: unknown; metadata?: unknown };
  const settings = parseSettings(obj.settings);
  if (!settings) return null;
  const rawMetadata = obj.syncMetadata ?? obj.metadata ?? null;
  const syncMetadata = rawMetadata === null ? null : parseSettingsSyncMetadata(rawMetadata);
  if (rawMetadata !== null && syncMetadata === null) return null;
  // The reconcile epoch is reconstructed like everything else, or the whitelist above would strip
  // it and every context would go back to arbitrating a shared browser for itself. Absence is
  // preserved rather than defaulted, because absent and zero mean different things to the cache: a
  // record with no counter came from a store that does not carry one.
  const rawEpoch = (decoded as { syncEpoch?: unknown }).syncEpoch;
  const syncEpoch = typeof rawEpoch === "number" && Number.isSafeInteger(rawEpoch) && rawEpoch >= 0
    ? rawEpoch
    : undefined;
  return syncEpoch === undefined ? { settings, syncMetadata } : { settings, syncMetadata, syncEpoch };
}

/** JSON.parse that returns null instead of throwing on malformed input. */
export function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseServices(value: unknown): Readonly<Record<ServiceId, boolean>> | null {
  if (!value || typeof value !== "object") return null;
  const incoming = value as Partial<Record<ServiceId, unknown>>;
  const services = {} as Record<ServiceId, boolean>;
  for (const id of SERVICE_IDS) {
    const on = incoming[id];
    // A service absent from the blob defaults OFF (back-compat: a settings object written before a
    // newer service id existed must not be discarded). A present-but-non-boolean value is still
    // rejected as corruption/injection.
    if (on === undefined) {
      services[id] = false;
    } else if (typeof on === "boolean") {
      services[id] = on;
    } else {
      return null;
    }
  }
  return services;
}
