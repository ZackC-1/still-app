import {
  FEATURE_REGISTRY,
  FEATURE_IDS,
  SERVICE_IDS,
  SETTINGS_FIELDS,
  MAX_SETTINGS_REVISION,
  MAX_SETTINGS_LOCAL_STEP,
  type SettingsV2,
  type SettingsObject,
  type SettingsField,
  type SettingsFieldStamp,
} from "@still/shared-types";
import { canonicalize } from "../rules/canonical.js";

/** Evidence is supplied by the installation/account authority, never inferred from missing data. */
export type SettingsMigrationProvenance =
  | { readonly kind: "proven-fresh" }
  | { readonly kind: "readable-local"; readonly provenInitialization?: boolean }
  | {
      readonly kind: "acknowledged-account";
      readonly revision: number;
      readonly provenInitialization?: boolean;
    }
  | { readonly kind: "unknown" };
export type SettingsRecoveryReason =
  | "missing-provenance"
  | "provenance-conflict"
  | "missing-data"
  | "malformed"
  | "future-schema"
  | "unsupported-schema"
  | "bounds";
export type SettingsMigrationResult =
  | {
      readonly status: "ready";
      readonly settings: SettingsV2;
      readonly migrated: boolean;
    }
  | {
      readonly status: "recovery";
      readonly reason: SettingsRecoveryReason;
      readonly original: unknown;
      readonly usableFields: Readonly<Partial<Record<SettingsField, boolean>>>;
    };

const MAX_BYTES = 65_536;
const MAX_NODES = 4_096;
const MAX_DEPTH = 8;
const MAX_MEMBERS = 128;
const MAX_STRING = 8_192;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const own = (v: object, key: string): boolean => Object.hasOwn(v, key);
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null);
const integer = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;

/** Detached JSON copy rejects cycles/accessors/prototypes and enforces the same native bounds. */
function boundedObject(value: unknown): SettingsObject | null {
  let nodes = 0;
  const seen = new Set<object>();
  function check(v: unknown, depth: number): boolean {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return false;
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "number")
      return Number.isFinite(v) && Math.abs(v) <= MAX_SETTINGS_REVISION;
    if (typeof v === "string") {
      const bytes = new TextEncoder().encode(v);
      return (
        bytes.length <= MAX_STRING && new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) === v
      );
    }
    if (typeof v !== "object" || seen.has(v)) return false;
    seen.add(v);
    let valid: boolean;
    if (Array.isArray(v)) {
      const descriptors = Object.getOwnPropertyDescriptors(v);
      valid =
        v.length <= MAX_MEMBERS &&
        Object.keys(descriptors).length === v.length + 1 &&
        Object.getOwnPropertySymbols(v).length === 0 &&
        Array.from(
          { length: v.length },
          (_, i) => descriptors[String(i)],
        ).every(
          (d) => d && "value" in d && d.enumerable && check(d.value, depth + 1),
        );
    } else if (object(v)) {
      const descriptors = Object.getOwnPropertyDescriptors(v);
      const keys = Object.keys(descriptors);
      valid =
        Object.getOwnPropertySymbols(v).length === 0 &&
        keys.length <= MAX_MEMBERS &&
        keys.every(
          (key) =>
            new TextEncoder().encode(key).length <= 128 &&
            !UNSAFE_KEYS.has(key) &&
            "value" in descriptors[key]! &&
            descriptors[key]!.enumerable &&
            check(descriptors[key]!.value, depth + 1),
        );
    } else valid = false;
    seen.delete(v);
    return valid;
  }
  if (!object(value) || !check(value, 0)) return null;
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > MAX_BYTES) return null;
  return JSON.parse(json) as SettingsObject;
}

function usableFields(value: unknown): Partial<Record<SettingsField, boolean>> {
  const fields: Partial<Record<SettingsField, boolean>> = {};
  if (!object(value)) return fields;
  // Read descriptors rather than getters, even for rejected untrusted input.
  const data = (v: object, key: string): unknown =>
    Object.getOwnPropertyDescriptor(v, key)?.value;
  const global = data(value, "globalOn");
  if (typeof global === "boolean") fields.globalOn = global;
  for (const [group, ids] of [
    ["services", SERVICE_IDS],
    ["sites", FEATURE_IDS],
  ] as const) {
    const values = data(value, group);
    if (!object(values)) continue;
    for (const id of ids) {
      const v = data(values, id);
      if (typeof v === "boolean") fields[`${group}.${id}` as SettingsField] = v;
    }
  }
  return fields;
}

/** Pure lazy migration only. Integration must use U3's atomic authority before persisting schema2. */
export function migrateSettingsV2(
  raw: unknown,
  provenance: SettingsMigrationProvenance,
): SettingsMigrationResult {
  let decoded: unknown = raw;
  let stringBounds = false;
  let stringMalformed = false;
  if (typeof raw === "string") {
    stringBounds = new TextEncoder().encode(raw).length > MAX_BYTES;
    if (!stringBounds) {
      try {
        decoded = JSON.parse(raw);
      } catch {
        stringMalformed = true;
      }
    }
  }
  const recovery = (
    reason: SettingsRecoveryReason,
  ): SettingsMigrationResult => ({
    status: "recovery",
    reason,
    original: raw,
    usableFields: usableFields(decoded),
  });
  if (
    !provenance ||
    provenance.kind === "unknown" ||
    !["proven-fresh", "readable-local", "acknowledged-account"].includes(
      provenance.kind,
    )
  )
    return recovery("missing-provenance");
  if (
    provenance.kind === "acknowledged-account" &&
    !integer(provenance.revision, MAX_SETTINGS_REVISION)
  )
    return recovery("missing-provenance");
  if (provenance.kind === "proven-fresh") {
    if (raw !== null && raw !== undefined)
      return recovery("provenance-conflict");
    const services = Object.fromEntries(SERVICE_IDS.map((id) => [id, true]));
    const sites = Object.fromEntries(
      FEATURE_REGISTRY.map((f) => [f.id, f.freshDefault]),
    );
    const clocks = Object.fromEntries(
      SETTINGS_FIELDS.map((field) => [
        field,
        { baseRevision: 0, localStep: 0 },
      ]),
    );
    return {
      status: "ready",
      settings: {
        schemaVersion: 2,
        globalOn: true,
        services,
        sites,
        clocks,
        updatedAt: 0,
      } as SettingsV2,
      migrated: true,
    };
  }
  if (raw === null || raw === undefined) return recovery("missing-data");
  if (stringBounds) return recovery("bounds");
  if (stringMalformed) return recovery("malformed");
  const input = boundedObject(decoded);
  if (!input) return recovery("bounds");
  const version = input.schemaVersion;
  if (typeof version === "number" && version > 2)
    return recovery("future-schema");
  if (version !== undefined && version !== 1 && version !== 2)
    return recovery("unsupported-schema");
  if (
    typeof input.globalOn !== "boolean" ||
    !integer(input.updatedAt, MAX_SETTINGS_REVISION) ||
    (input.updatedAt === 0 && !provenance.provenInitialization) ||
    !object(input.services)
  )
    return recovery("malformed");
  if (
    own(input, "pauses") &&
    (!Array.isArray(input.pauses) ||
      !input.pauses.every((v) => typeof v === "string"))
  )
    return recovery("malformed");
  if (own(input, "sites") && !object(input.sites)) return recovery("malformed");
  const services = { ...input.services };
  const sites = { ...(input.sites as SettingsObject | undefined) };
  if (own(sites, "tiktok") || own(sites, "tiktok.all"))
    return recovery("malformed");
  for (const id of SERVICE_IDS) {
    if (own(services, id) && typeof services[id] !== "boolean")
      return recovery("malformed");
    if (version === 2 && !own(services, id)) return recovery("malformed");
    if (!own(services, id)) services[id] = false;
  }
  for (const f of FEATURE_REGISTRY) {
    if (own(sites, f.id) && typeof sites[f.id] !== "boolean")
      return recovery("malformed");
    if (version === 2 && !own(sites, f.id)) return recovery("malformed");
    if (!own(sites, f.id))
      sites[f.id] = f.tier === "free" ? (services[f.service] ?? false) : false;
  }
  let clocks: Record<string, SettingsFieldStamp>;
  if (version === 2) {
    if (!object(input.clocks)) return recovery("malformed");
    clocks = { ...input.clocks } as Record<string, SettingsFieldStamp>;
    if (own(clocks, "sites.tiktok") || own(clocks, "sites.tiktok.all"))
      return recovery("malformed");
    for (const [field, stamp] of Object.entries(clocks)) {
      if (
        !object(stamp) ||
        !integer(stamp.baseRevision, MAX_SETTINGS_REVISION) ||
        !integer(stamp.localStep, MAX_SETTINGS_LOCAL_STEP)
      )
        return recovery("malformed");
      if (
        !SETTINGS_FIELDS.includes(field as SettingsField) &&
        !field.startsWith("services.") &&
        !field.startsWith("sites.")
      )
        return recovery("malformed");
    }
    if (!SETTINGS_FIELDS.every((field) => own(clocks, field)))
      return recovery("malformed");
  } else {
    // Unversioned stamps cannot be safely reinterpreted as untouched baseline metadata.
    if (own(input, "clocks")) return recovery("malformed");
    let revision = 0;
    if (provenance.kind === "acknowledged-account") {
      if (!integer(provenance.revision, MAX_SETTINGS_REVISION))
        return recovery("missing-provenance");
      revision = Math.max(1, provenance.revision);
    }
    clocks = Object.fromEntries(
      SETTINGS_FIELDS.map((field) => {
        const supplied =
          field === "globalOn" ||
          (field.startsWith("services.")
            ? own(input.services as object, field.slice(9))
            : object(input.sites) && own(input.sites, field.slice(6)));
        return [field, { baseRevision: supplied ? revision : 0, localStep: 0 }];
      }),
    );
  }
  const settings: Record<string, unknown> = {
    ...input,
    schemaVersion: 2,
    services,
    sites,
    clocks,
  };
  delete settings.pauses;
  if (!boundedObject(settings)) return recovery("bounds");
  return {
    status: "ready",
    settings: settings as SettingsV2,
    migrated: version !== 2,
  };
}

/** Deterministic output retains legacy global/services/updatedAt, with no retired pause emission. */
export function serializeSettingsV2(settings: SettingsV2): string {
  const checked = migrateSettingsV2(settings, {
    kind: "readable-local",
    provenInitialization: settings.updatedAt === 0,
  });
  if (checked.status !== "ready")
    throw new Error(`Settings recovery required: ${checked.reason}`);
  return canonicalize(checked.settings);
}
