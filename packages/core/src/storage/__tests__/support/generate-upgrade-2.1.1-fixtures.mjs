// Regenerates packages/shared-types/fixtures/upgrade-2.1.1.json from the SHIPPED 2.1.1 writers.
//
// Provenance, from docs/release/history/2026-09-25-release-status.md:
//   - Chrome and Firefox 2.1.1 packages were built from ec1e68b.
//   - iOS and macOS 2.1.0 (build 9) were archived from 8a67977, which has the same app source as
//     ec1e68b (8a67977 only adds a release document).
//
// The script never imports current code to produce a stored shape. It extracts the 2.1.1 storage
// sources with `git archive ec1e68b`, runs the 2.1.1 TypeScript SettingsCache against an in-memory
// chrome.storage stand-in, and compiles the 2.1.1 Swift StillSettings/SharedSettingsStore to write
// App Group bytes exactly as the 2.1.0 app did. Every value is synthetic: no real account, write id,
// timestamp or choice from any person is used.
//
// Needs the ec1e68b objects (a full clone), Node 24 (--experimental-transform-types) and swiftc.
// It is a maintenance tool, not a CI step. Usage, from the repository root:
//   node packages/core/src/storage/__tests__/support/generate-upgrade-2.1.1-fixtures.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BROWSER_COMMIT = "ec1e68b";
const APPLE_COMMIT = "8a67977";
const root = resolve(fileURLToPath(new URL("../../../../../../", import.meta.url)));
const output = join(root, "packages/shared-types/fixtures/upgrade-2.1.1.json");

// Synthetic constants shared by both writers.
const CLOCK = 1_758_000_000_000; // 2025-09-16T05:20:00Z, an arbitrary fixed epoch-ms
const ACCOUNT_WRITE = "00000000-0000-4000-8000-0000000000a1";
const DEVICE_WRITE = "00000000-0000-4000-8000-0000000000b2";

function extract(commit, paths) {
  const dir = mkdtempSync(join(tmpdir(), `still-${commit}-`));
  const archive = execFileSync("git", ["-C", root, "archive", commit, ...paths]);
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  return dir;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Run the 2.1.1 browser writers. Node executes the TypeScript directly, so imports are pointed at
 * the .ts files and the workspace alias at the extracted shared-types package. */
function browserCases() {
  const dir = extract(BROWSER_COMMIT, ["packages/core/src/storage", "packages/shared-types/src"]);
  try {
    const shared = join(dir, "packages/shared-types/src/index.ts");
    for (const file of walk(dir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(file, "utf8")
        .replace(/from "(\.{1,2}\/[^"]+)\.js"/g, 'from "$1.ts"')
        .replace(/from "@still\/shared-types"/g, `from "${relative(join(file, ".."), shared).replace(/^(?!\.)/, "./")}"`);
      writeFileSync(file, source);
    }
    const scenario = join(dir, "scenario.ts");
    writeFileSync(scenario, `
import { DEFAULT_SETTINGS } from "./packages/shared-types/src/index.ts";
import { SettingsCache } from "./packages/core/src/storage/cache.ts";
import { ChromeStorageAdapter } from "./packages/core/src/storage/chrome-adapter.ts";
import { parseStoredSettingsRecord } from "./packages/core/src/storage/settings-validation.ts";

const KEY = "still:settings";
let area: Record<string, unknown> = {};
let writes = 0;
(globalThis as any).chrome = { storage: {
  local: {
    get: async (key: string) => (Object.hasOwn(area, key) ? { [key]: structuredClone(area[key]) } : {}),
    set: async (values: Record<string, unknown>) => { writes += 1; area = { ...area, ...structuredClone(values) }; },
  },
  onChanged: { addListener() {}, removeListener() {} },
} };
async function run(prior: unknown, body: (cache: SettingsCache) => Promise<void> | void) {
  area = prior === undefined ? {} : { [KEY]: structuredClone(prior) };
  writes = 0;
  let tick = ${CLOCK};
  const cache = new SettingsCache(new ChromeStorageAdapter(), { now: () => (tick += 60_000) });
  await cache.hydrate();
  await body(cache);
  await new Promise((r) => setTimeout(r, 0));
  return { present: Object.hasOwn(area, KEY), stored: area[KEY] ?? null, writes };
}
const meta = (version: number, minute: number, lastWriteId: string | null) => ({
  version, serverUpdatedAt: new Date(${CLOCK} + minute * 60_000).toISOString(), lastWriteId,
});
const mixed = { globalOn: true, services: { youtube: false, instagram: true, tiktok: false, facebook: true }, pauses: [], updatedAt: ${CLOCK} - 30 * 60_000 };
const out: Record<string, unknown> = {};
out.untouched = await run(undefined, () => {});
out.syncedDefaults = await run(undefined, (c) => { c.applySyncedEnvelope({ settings: DEFAULT_SETTINGS, ...meta(1, 5, "${DEVICE_WRITE}") }); });
out.allOff = await run(undefined, async (c) => {
  for (const id of ["youtube", "instagram", "tiktok", "facebook"] as const) await c.setService(id, false);
  await c.setGlobalOn(false);
});
out.mixed = await run(undefined, async (c) => { await c.setService("youtube", false); await c.setService("tiktok", false); });
out.signedIn = await run(undefined, async (c) => {
  c.adoptSyncedEnvelope({ settings: mixed, ...meta(7, 40, "${ACCOUNT_WRITE}") });
  await c.setService("instagram", false);
});
// Carried, not written: what 2.1.1 does when it starts on records an older or foreign writer left.
const legacy10 = { settings: { globalOn: true, services: { youtube: true, instagram: false, tiktok: true, facebook: false }, pauses: [], updatedAt: ${CLOCK} - 86_400_000 }, syncMetadata: null };
const legacyPauses = { settings: { globalOn: true, services: { youtube: false, instagram: true, tiktok: true, facebook: true }, pauses: ["youtube.com", "instagram.com"], updatedAt: ${CLOCK} - 2 * 86_400_000 }, syncMetadata: null };
const unknown = { ...(out.signedIn as any).stored, futureRoot: { note: "synthetic unknown root member" } };
unknown.settings = { ...unknown.settings, futureSetting: { level: 2, labels: ["synthetic"] }, services: { ...unknown.settings.services, futureService: "synthetic unknown service member" } };
for (const [name, prior] of [["legacy10", legacy10], ["legacyPauses", legacyPauses], ["unknown", unknown]] as const) {
  const result = await run(prior, () => {});
  out[name] = { ...result, acceptedBy211: parseStoredSettingsRecord(prior) !== null, view211: parseStoredSettingsRecord(prior)?.settings ?? null };
}
console.log(JSON.stringify(out));
`);
    return JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", "--no-warnings", scenario], { cwd: dir, encoding: "utf8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the 2.1.0 App Group writer (Swift) and capture the exact bytes it stores. */
function appleCases() {
  const sources = "apps/apple/StillKit/Sources/StillKit";
  const dir = extract(APPLE_COMMIT, [`${sources}/StillSettings.swift`, `${sources}/SharedSettingsStore.swift`]);
  try {
    const main = join(dir, "main.swift");
    writeFileSync(main, `
import Foundation
let clock = ${CLOCK}
func bytes(_ body: (SharedSettingsStore) -> Void) -> String {
  let backing = InMemoryBacking()
  body(SharedSettingsStore(backing: backing))
  return backing.read().map { String(decoding: $0, as: UTF8.self) } ?? ""
}
func meta(_ version: Int, _ minute: Int, _ id: String?) -> SettingsSyncMetadata {
  let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return SettingsSyncMetadata(version: version, serverUpdatedAt: f.string(from: Date(timeIntervalSince1970: Double(clock + minute * 60_000) / 1000)), lastWriteId: id)
}
let mixed = StillSettings(globalOn: true, services: StillServices(youtube: false, instagram: true, tiktok: false, facebook: true), pauses: [], updatedAt: clock + 30 * 60_000)
var out: [String: String] = [:]
out["untouched"] = bytes { _ in }
out["syncedDefaults"] = bytes { $0.applyRecord(StoredSettingsRecord(settings: .default, syncMetadata: meta(1, 5, "${DEVICE_WRITE}"), syncEpoch: 0)) }
out["allOff"] = bytes { $0.save(StillSettings(globalOn: false, services: StillServices(youtube: false, instagram: false, tiktok: false, facebook: false), pauses: [], updatedAt: clock + 5 * 60_000)) }
out["mixed"] = bytes { $0.save(StillSettings(globalOn: true, services: StillServices(youtube: false, instagram: true, tiktok: false, facebook: true), pauses: [], updatedAt: clock + 2 * 60_000)) }
out["signedIn"] = bytes { store in
  store.applyRecord(StoredSettingsRecord(settings: mixed, syncMetadata: meta(7, 40, "${ACCOUNT_WRITE}"), syncEpoch: 1))
  var edited = mixed; edited.services.instagram = false; edited.updatedAt = clock + 41 * 60_000
  store.save(edited)
}
out["legacyPauses"] = bytes { $0.save(StillSettings(globalOn: true, services: StillServices(youtube: false, instagram: true, tiktok: true, facebook: true), pauses: ["youtube.com", "instagram.com"], updatedAt: clock - 2 * 86_400_000)) }
let unknown = #"{"settings":{"globalOn":true,"services":{"youtube":false,"instagram":true,"tiktok":false,"facebook":true,"futureService":"synthetic unknown service member"},"pauses":[],"updatedAt":\\#(clock + 30 * 60_000),"futureSetting":{"level":2,"labels":["synthetic"]}},"syncMetadata":{"version":7,"serverUpdatedAt":"2025-09-16T06:00:00.000Z","lastWriteId":"${ACCOUNT_WRITE}"},"syncEpoch":1,"futureRoot":{"note":"synthetic unknown root member"}}"#
let accepted = (try? JSONDecoder().decode(StoredSettingsRecord.self, from: Data(unknown.utf8))) != nil
out["unknown"] = accepted ? unknown : "REJECTED-BY-2.1.0"
print(String(decoding: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), as: UTF8.self))
`);
    const binary = join(dir, "writer");
    execFileSync("swiftc", ["-o", binary, join(dir, sources, "StillSettings.swift"), join(dir, sources, "SharedSettingsStore.swift"), main]);
    return JSON.parse(execFileSync(binary, { encoding: "utf8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const browser = browserCases();
const apple = appleCases();
for (const name of ["legacy10", "legacyPauses", "unknown"]) {
  if (!browser[name].acceptedBy211 || browser[name].writes !== 0) throw new Error(`2.1.1 did not carry ${name} untouched`);
}
if (browser.untouched.present || browser.untouched.writes !== 0 || apple.untouched !== "") {
  throw new Error("2.1.1 wrote a record for an untouched install");
}
if (apple.unknown.startsWith("REJECTED")) throw new Error("2.1.0 Swift rejected the unknown-member record");

// What each person chose, stated from the scenario itself rather than read back from a writer. The
// upgrade tests compare every current reader against these values, so a writer that stored a choice
// differently from the person's intent would fail here rather than be copied into the expectation.
const minute = 60_000;
const day = 86_400_000;
const syncedAt = (version, minutes, lastWriteId) => ({
  version, serverUpdatedAt: new Date(CLOCK + minutes * minute).toISOString(), lastWriteId,
});
const chose = (globalOn, [youtube, instagram, tiktok, facebook], updatedAt, syncMetadata, syncEpoch, retained) => ({
  globalOn, services: { youtube, instagram, tiktok, facebook }, updatedAt, syncMetadata, syncEpoch,
  ...(retained ? { retained } : {}),
});
const RETAINED = {
  root: { futureRoot: { note: "synthetic unknown root member" } },
  settings: { futureSetting: { level: 2, labels: ["synthetic"] } },
  services: { futureService: "synthetic unknown service member" },
};
const ON = true;
const OFF = false;

const browserCase = (name, origin, key, writer, expected) => ({
  name, surface: "browser-storage", origin, writer,
  present: browser[key].present, stored: browser[key].stored, expected,
});
const appleCase = (name, origin, key, writer, expected) => ({
  name, surface: "app-group", origin, writer,
  present: apple[key] !== "", rawJSON: apple[key] === "" ? null : apple[key], expected,
});

const fixture = {
  about: [
    "Exact settings records as the shipped 2.1.1 browser extension (chrome.storage.local key",
    "\"still:settings\") and the 2.1.0 Apple app (App Group UserDefaults key \"still:settings\") leave them.",
    "Generated by packages/core/src/storage/__tests__/support/generate-upgrade-2.1.1-fixtures.mjs.",
    "All values are synthetic. Do not edit by hand: regenerate, then update expectations deliberately.",
    "App Group key order is whatever the 2.1.0 JSONEncoder emitted; it varies between runs, as on devices.",
  ],
  sources: {
    browser: `${BROWSER_COMMIT} (Chrome and Firefox 2.1.1 packages)`,
    apple: `${APPLE_COMMIT} (iOS and macOS 2.1.0 build 9; same app source as ${BROWSER_COMMIT})`,
    record: "docs/release/history/2026-09-25-release-status.md",
  },
  cases: [
    browserCase("browser-defaults-never-touched", "written-by-2.1.1", "untouched", "SettingsCache.hydrate with no edits: 2.1.1 writes nothing", null),
    browserCase("browser-defaults-synced", "written-by-2.1.1", "syncedDefaults", "SettingsCache.applySyncedEnvelope(DEFAULT_SETTINGS, version 1): untouched device signed in to an empty account",
      chose(ON, [ON, ON, ON, ON], 0, syncedAt(1, 5, DEVICE_WRITE), 0)),
    browserCase("browser-all-off", "written-by-2.1.1", "allOff", "SettingsCache.setService x4 off, then setGlobalOn(false)",
      chose(OFF, [OFF, OFF, OFF, OFF], CLOCK + 5 * minute, null, 0)),
    browserCase("browser-mixed", "written-by-2.1.1", "mixed", "SettingsCache.setService youtube off, tiktok off",
      chose(ON, [OFF, ON, OFF, ON], CLOCK + 2 * minute, null, 0)),
    browserCase("browser-signed-in-synced", "written-by-2.1.1", "signedIn", "SettingsCache.adoptSyncedEnvelope(version 7), then setService instagram off",
      chose(ON, [OFF, OFF, OFF, ON], CLOCK + minute, syncedAt(7, 40, ACCOUNT_WRITE), 1)),
    browserCase("browser-legacy-1.0-no-epoch", "carried-by-2.1.1", "legacy10", "1.0-era record without syncEpoch; 2.1.1 hydrates it without rewriting",
      chose(ON, [ON, OFF, ON, OFF], CLOCK - day, null, null)),
    browserCase("browser-legacy-pauses", "carried-by-2.1.1", "legacyPauses", "pre-release record with non-empty pauses; 2.1.1 hydrates it without rewriting",
      chose(ON, [OFF, ON, ON, ON], CLOCK - 2 * day, null, null)),
    browserCase("browser-unknown-extra-fields", "carried-by-2.1.1", "unknown", "signed-in record plus unknown root, settings and services members; 2.1.1 accepts it unchanged",
      chose(ON, [OFF, OFF, OFF, ON], CLOCK + minute, syncedAt(7, 40, ACCOUNT_WRITE), 1, RETAINED)),
    appleCase("app-group-defaults-never-touched", "written-by-2.1.0", "untouched", "SharedSettingsStore with no writes: nothing stored", null),
    appleCase("app-group-defaults-synced", "written-by-2.1.0", "syncedDefaults", "SharedSettingsStore.applyRecord(defaults, version 1, epoch 0) from the bridge",
      chose(ON, [ON, ON, ON, ON], 0, syncedAt(1, 5, DEVICE_WRITE), 0)),
    appleCase("app-group-all-off", "written-by-2.1.0", "allOff", "SharedSettingsStore.save(all off)",
      chose(OFF, [OFF, OFF, OFF, OFF], CLOCK + 5 * minute, null, null)),
    appleCase("app-group-mixed", "written-by-2.1.0", "mixed", "SharedSettingsStore.save(youtube off, tiktok off)",
      chose(ON, [OFF, ON, OFF, ON], CLOCK + 2 * minute, null, null)),
    appleCase("app-group-signed-in-synced", "written-by-2.1.0", "signedIn", "SharedSettingsStore.applyRecord(version 7, epoch 1), then save(instagram off)",
      chose(ON, [OFF, OFF, OFF, ON], CLOCK + 41 * minute, syncedAt(7, 40, ACCOUNT_WRITE), 1)),
    appleCase("app-group-legacy-pauses", "written-by-2.1.0", "legacyPauses", "SharedSettingsStore.save with non-empty pauses (2.1.0 Swift keeps them verbatim)",
      chose(ON, [OFF, ON, ON, ON], CLOCK - 2 * day, null, null)),
    appleCase("app-group-unknown-extra-fields", "carried-by-2.1.0", "unknown", "signed-in bytes plus unknown members; 2.1.0 StoredSettingsRecord decodes it",
      chose(ON, [OFF, ON, OFF, ON], CLOCK + 30 * minute, syncedAt(7, 40, ACCOUNT_WRITE), 1, RETAINED)),
  ],
};
fixture.about.push(
  "\"expected\" is each person's intent: legacy globalOn/services/updatedAt, sync metadata and epoch",
  "(null = absent), and any unknown members that must survive. null expected = nothing was stored.",
);
writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${relative(root, output)} (${fixture.cases.length} cases)`);
