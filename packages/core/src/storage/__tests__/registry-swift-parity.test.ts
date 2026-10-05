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
const sorted = (a: readonly string[]) => [...a].sort();
const withoutComments = (swift: string) => swift.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const compact = (swift: string) => withoutComments(swift).replace(/\s+/g, "");

/** The wire keys a Swift `enum CodingKeys: String, CodingKey` produces: each case's explicit raw
 * value, or its name. Accepts any layout (`case a, b = "x"`, one case per line, extra whitespace);
 * anything it cannot read is returned verbatim so it can never pass as a service id. */
function codingKeyRawValues(body: string): string[] {
  const text = withoutComments(body).replace(/,\s+/g, ", ");
  return [...text.matchAll(/\bcase\s+([^\n;]+)/g)].flatMap((m) =>
    m[1]!.split(",").map((item) => {
      const key = item.trim().match(/^(\w+)(?:\s*=\s*"((?:[^"\\]|\\.)*)")?$/);
      return key ? (key[2] ?? key[1]!) : `<unparsed ${item.trim()}>`;
    }),
  );
}

const SERVICES_KEYS = /(struct\s+StillServices\b[\s\S]*?enum\s+CodingKeys\s*:\s*String\s*,\s*CodingKey\s*\{)([\s\S]*?)(\})/;

/** Every way the Swift sources disagree with the TypeScript registry; empty means parity. */
function swiftRegistryDrift(src: Sources): string[] {
  const drift: string[] = [];
  const features = [
    ...src.registry.matchAll(
      /PackagedFeature\(\s*id:\s*("[^"]*")\s*,\s*service:\s*("[^"]*")\s*,\s*name:\s*("(?:[^"\\]|\\.)*")\s*,\s*tier:\s*("[^"]*")\s*,\s*freshDefault:\s*(true|false)\s*\)/g,
    ),
  ].map((m) => ({
    id: JSON.parse(m[1]!), service: JSON.parse(m[2]!), name: JSON.parse(m[3]!), tier: JSON.parse(m[4]!), freshDefault: m[5] === "true",
  }));
  if (!same(features, FEATURE_REGISTRY)) drift.push("PackagedFeatureRegistry.features differs from FEATURE_REGISTRY");

  const services = strings(src.registry.match(/static\s+let\s+serviceIDs\s*=\s*\[([^\]]*)\]/)?.[1]);
  if (!same(services, SERVICE_IDS)) drift.push(`PackagedFeatureRegistry.serviceIDs ${JSON.stringify(services)} != SERVICE_IDS`);
  const fields = ["globalOn", ...services.map((id) => `services.${id}`), ...features.map((f) => `sites.${f.id}`)];
  if (
    !compact(src.registry).includes(compact('settingsFields = ["globalOn"] + serviceIDs.map { "services.\\($0)" } + featureIDs.map { "sites.\\($0)" }')) ||
    !same(fields, SETTINGS_FIELDS)
  )
    drift.push("PackagedFeatureRegistry.settingsFields differs from SETTINGS_FIELDS");
  if (strings(src.registry.match(/static\s+let\s+tiktokAlias\s*=\s*("[^"]*")/)?.[1])[0] !== TIKTOK_ALIAS.id)
    drift.push("PackagedFeatureRegistry.tiktokAlias differs from TIKTOK_ALIAS.id");
  if (strings(src.registry.match(/static\s+let\s+tiktokField\s*=\s*("[^"]*")/)?.[1])[0] !== TIKTOK_ALIAS.field)
    drift.push("PackagedFeatureRegistry.tiktokField differs from TIKTOK_ALIAS.field");

  // The legacy service record the App Group and bridge still carry.
  // Key order does not reach the wire, so only the set of raw values must equal SERVICE_IDS.
  const servicesStruct = src.settings.match(SERVICES_KEYS)?.[2];
  const keys = codingKeyRawValues(servicesStruct ?? "");
  if (!same(sorted(keys), sorted(SERVICE_IDS))) drift.push(`StillServices.CodingKeys ${JSON.stringify(keys)} != SERVICE_IDS`);
  // Held field overrides in the shared store must reach every service the projection carries.
  const held = [...src.store.matchAll(/case\s+"services\.(\w+)"\s*:\s*projected\.settings\.services\.(\w+)\s*=\s*on\b/g)];
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
    // A raw value changes the wire key even though the case name still matches. The anchor finds
    // the case in any layout, so these controls survive a reformat of StillSettings.swift.
    expect(mutate("settings", /\bcase\s+youtube\b/, 'case youtube = "yt"').join()).toMatch(/StillServices\.CodingKeys .*"yt"/);
    expect(mutate("settings", /\bcase\s+youtube\b/, "case youtubeKids").join()).toMatch(/StillServices\.CodingKeys/);
    expect(mutate("store", 'case "services.facebook": projected.settings.services.facebook = on', "")).toContain(
      "SharedSettingsStore held-field projection does not cover SERVICE_IDS",
    );
    expect(mutate("migration", "PackagedFeatureRegistry.featureIDs", '["youtube.shorts"]').join()).toMatch(/spells registry ids youtube\.shorts/);
  });

  it("does not report drift for a reformat that keeps the same values", () => {
    const src = read();
    const reformat = (key: keyof Sources, from: string | RegExp, to: string) => {
      const next = src[key].replace(from, to);
      expect(next, `reformat of ${key} must apply`).not.toBe(src[key]);
      return swiftRegistryDrift({ ...src, [key]: next });
    };
    // Replaces the whole StillServices CodingKeys body, so it holds whatever layout the file has now.
    const keys = (body: string) => {
      expect(SERVICES_KEYS.test(src.settings)).toBe(true);
      return swiftRegistryDrift({ ...src, settings: src.settings.replace(SERVICES_KEYS, `$1${body}$3`) });
    };
    expect(keys("\n    case youtube, instagram, tiktok, facebook\n  ")).toEqual([]);
    expect(keys('\n    case   youtube =  "youtube" , // wire key\n      instagram\n    case facebook\n    case tiktok\n  ')).toEqual([]);
    expect(keys("\n    case youtube\n    case instagram\n    case tiktok\n    case facebook\n  ")).toEqual([]);
    expect(keys('\n    case youtube = "yt", instagram, tiktok, facebook\n  ').join()).toMatch(/StillServices\.CodingKeys/);
    expect(reformat("registry", '"youtube", "instagram", "tiktok", "facebook"]', '\n    "youtube",\n    "instagram",\n    "tiktok",\n    "facebook",\n  ]')).toEqual([]);
    expect(reformat("registry", "public static let tiktokField = ", "public static let tiktokField   =   ")).toEqual([]);
    expect(reformat("store", 'case "services.facebook": projected', 'case "services.facebook" :  projected')).toEqual([]);
  });
});
