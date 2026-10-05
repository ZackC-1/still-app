import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_REGISTRY, SERVICE_IDS, SETTINGS_FIELDS, TIKTOK_ALIAS } from "@still/shared-types";

// Swift/TypeScript registry parity, checked from the Swift SOURCE TEXT so it runs on the Linux CI
// runner, where StillKit cannot build (it imports Darwin). scripts/registry/generate.mjs --check
// already proves both generated files match feature-registry.json; this covers what that check
// cannot see: the hand-written Swift service list and coding keys, which must equal SERVICE_IDS in
// packages/shared-types/src/rules.ts, and Swift readers that must take feature ids from the
// generated registry instead of spelling them out.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const STILLKIT = "apps/apple/StillKit/Sources/StillKit";
const FILES = {
  registry: `${STILLKIT}/PackagedFeatureRegistry.swift`,
  settings: `${STILLKIT}/StillSettings.swift`,
  store: `${STILLKIT}/SharedSettingsStore.swift`,
  migration: `${STILLKIT}/SettingsV2.swift`,
  record: `${STILLKIT}/AtomicSettingsRecord.swift`,
} as const;
type Sources = Record<keyof typeof FILES, string>;

const read = (): Sources =>
  Object.fromEntries(Object.entries(FILES).map(([k, path]) => [k, readFileSync(join(root, path), "utf8")])) as Sources;
const strings = (list: string | undefined) => [...(list ?? "").matchAll(/"([^"\\]*)"/g)].map((m) => m[1]);
const same = (a: readonly unknown[], b: readonly unknown[]) => JSON.stringify(a) === JSON.stringify(b);

/** Every way the Swift sources disagree with the TypeScript registry; empty means parity. */
function swiftRegistryDrift(src: Sources): string[] {
  const drift: string[] = [];
  const features = [
    ...src.registry.matchAll(
      /PackagedFeature\(id: ("[^"]*"), service: ("[^"]*"), name: ("(?:[^"\\]|\\.)*"), tier: ("[^"]*"), freshDefault: (true|false)\)/g,
    ),
  ].map((m) => ({
    id: JSON.parse(m[1]!), service: JSON.parse(m[2]!), name: JSON.parse(m[3]!), tier: JSON.parse(m[4]!), freshDefault: m[5] === "true",
  }));
  if (!same(features, FEATURE_REGISTRY)) drift.push("PackagedFeatureRegistry.features differs from FEATURE_REGISTRY");

  const services = strings(src.registry.match(/static let serviceIDs = \[([^\]]*)\]/)?.[1]);
  if (!same(services, SERVICE_IDS)) drift.push(`PackagedFeatureRegistry.serviceIDs ${JSON.stringify(services)} != SERVICE_IDS`);
  const fields = ["globalOn", ...services.map((id) => `services.${id}`), ...features.map((f) => `sites.${f.id}`)];
  if (
    !src.registry.includes('settingsFields = ["globalOn"] + serviceIDs.map { "services.\\($0)" } + featureIDs.map { "sites.\\($0)" }') ||
    !same(fields, SETTINGS_FIELDS)
  )
    drift.push("PackagedFeatureRegistry.settingsFields differs from SETTINGS_FIELDS");
  if (strings(src.registry.match(/static let tiktokAlias = ("[^"]*")/)?.[1])[0] !== TIKTOK_ALIAS.id)
    drift.push("PackagedFeatureRegistry.tiktokAlias differs from TIKTOK_ALIAS.id");
  if (strings(src.registry.match(/static let tiktokField = ("[^"]*")/)?.[1])[0] !== TIKTOK_ALIAS.field)
    drift.push("PackagedFeatureRegistry.tiktokField differs from TIKTOK_ALIAS.field");

  // The legacy service record the App Group and bridge still carry.
  const servicesStruct = src.settings.match(/struct StillServices[\s\S]*?enum CodingKeys: String, CodingKey \{([\s\S]*?)\}/)?.[1];
  const keys = [...(servicesStruct ?? "").matchAll(/case (\w+)/g)].map((m) => m[1]);
  if (!same(keys, SERVICE_IDS)) drift.push(`StillServices.CodingKeys ${JSON.stringify(keys)} != SERVICE_IDS`);
  // Held field overrides in the shared store must reach every service the projection carries.
  const held = [...src.store.matchAll(/case "services\.(\w+)": projected\.settings\.services\.(\w+) = on/g)];
  if (!same(held.map((m) => m[1]), SERVICE_IDS) || held.some((m) => m[1] !== m[2]))
    drift.push("SharedSettingsStore held-field projection does not cover SERVICE_IDS");

  // Readers take feature ids from the generated registry, never from their own literals.
  for (const key of ["migration", "record", "store", "settings"] as const) {
    const spelled = FEATURE_REGISTRY.map((f) => f.id).filter((id) => src[key].includes(`"${id}"`) || src[key].includes(`"sites.${id}"`));
    if (spelled.length) drift.push(`${FILES[key]} spells registry ids ${spelled.join(", ")}`);
  }
  return drift;
}

describe("Swift/TypeScript packaged registry parity (source text)", () => {
  it("has no drift in the current sources", () => {
    expect(swiftRegistryDrift(read())).toEqual([]);
  });

  it("reports drift a Swift edit would introduce", () => {
    const src = read();
    const mutate = (key: keyof Sources, from: string | RegExp, to: string) => {
      const next = src[key].replace(from, to);
      expect(next, `mutation of ${key} must apply`).not.toBe(src[key]);
      return swiftRegistryDrift({ ...src, [key]: next });
    };
    expect(mutate("registry", '"youtube", "instagram", "tiktok", "facebook"]', '"youtube", "instagram", "facebook", "tiktok"]')).toContain(
      'PackagedFeatureRegistry.serviceIDs ["youtube","instagram","facebook","tiktok"] != SERVICE_IDS',
    );
    expect(mutate("registry", 'tier: "pro", freshDefault: false)', 'tier: "free", freshDefault: false)')).toContain(
      "PackagedFeatureRegistry.features differs from FEATURE_REGISTRY",
    );
    expect(mutate("registry", 'tiktokField = "services.tiktok"', 'tiktokField = "sites.tiktok"')).toContain(
      "PackagedFeatureRegistry.tiktokField differs from TIKTOK_ALIAS.field",
    );
    expect(mutate("settings", /case youtube\n/, "case youtubeKids\n").join()).toMatch(/StillServices\.CodingKeys/);
    expect(mutate("store", 'case "services.facebook": projected.settings.services.facebook = on', "")).toContain(
      "SharedSettingsStore held-field projection does not cover SERVICE_IDS",
    );
    expect(mutate("migration", "PackagedFeatureRegistry.featureIDs", '["youtube.shorts"]').join()).toMatch(/spells registry ids youtube\.shorts/);
  });
});
