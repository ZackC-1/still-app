import { SERVICE_IDS, type ServiceId, type StillSettings } from "@still/shared-types";

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
  if (!Array.isArray(s.pauses) || !s.pauses.every((p) => typeof p === "string")) return null;
  return {
    globalOn: s.globalOn,
    services,
    pauses: [...s.pauses],
    updatedAt: s.updatedAt,
  };
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
    if (typeof on !== "boolean") return null;
    services[id] = on;
  }
  return services;
}
