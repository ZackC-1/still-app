import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FEATURE_REGISTRY,
  FEATURE_IDS,
  TIKTOK_ALIAS,
  SETTINGS_FIELDS,
} from "@still/shared-types";
import { migrateSettingsV2, serializeSettingsV2 } from "../settings-v2.js";
import { parseSettings } from "../settings-validation.js";
import vectors from "../../../../shared-types/fixtures/settings-v2.json";
import type { SettingsMigrationProvenance } from "../settings-v2.js";

const legacy = {
  globalOn: false,
  services: { youtube: false, instagram: true, facebook: false, tiktok: false },
  pauses: ["youtube.com"],
  updatedAt: 50,
};
const existing = { kind: "readable-local" } as const;
function migrated(input: unknown = legacy) {
  const result = migrateSettingsV2(input, existing);
  if (result.status !== "ready") throw new Error(result.reason);
  return result.settings;
}

describe("packaged V3 registry", () => {
  it("checks both generated registries against their authority during normal tests", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
    const script = "scripts/registry/generate.mjs";
    const authority = "packages/shared-types/src/feature-registry.json";
    const outputs = [
      "packages/shared-types/src/feature-registry.ts",
      "apps/apple/StillKit/Sources/StillKit/PackagedFeatureRegistry.swift",
    ];
    const check = (dir: string) => execFileSync(process.execPath, [join(dir, script), "--check"], { stdio: "pipe" });
    expect(() => check(root)).not.toThrow();
    const scratch = mkdtempSync(join(tmpdir(), "still-registry-"));
    try {
      for (const path of [script, authority, ...outputs]) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        copyFileSync(join(root, path), join(scratch, path));
      }
      expect(() => check(scratch)).not.toThrow();
      const registry = JSON.parse(readFileSync(join(scratch, authority), "utf8"));
      registry.features[0].name += " drift";
      writeFileSync(join(scratch, authority), JSON.stringify(registry));
      expect(() => check(scratch)).toThrow(/Generated registry drift/);
      copyFileSync(join(root, authority), join(scratch, authority));
      for (const output of outputs) {
        writeFileSync(join(scratch, output), readFileSync(join(scratch, output), "utf8") + "\n// drift\n");
        expect(() => check(scratch)).toThrow(/Generated registry drift/);
        copyFileSync(join(root, output), join(scratch, output));
      }
      expect(() => check(scratch)).not.toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("freezes fifteen features, twelve optional extras and one TikTok service alias", () => {
    expect(FEATURE_IDS).toHaveLength(15);
    expect(new Set(FEATURE_IDS).size).toBe(15);
    expect(FEATURE_REGISTRY.filter((f) => f.tier === "pro")).toHaveLength(12);
    expect(
      FEATURE_REGISTRY.every((f) => f.freshDefault === (f.tier === "free")),
    ).toBe(true);
    expect(TIKTOK_ALIAS).toEqual({
      id: "tiktok.all",
      service: "tiktok",
      field: "services.tiktok",
      tier: "free",
      freshDefault: true,
    });
    expect(SETTINGS_FIELDS).toHaveLength(20);
    expect(SETTINGS_FIELDS).not.toContain("sites.tiktok.all");
    expect(Object.isFrozen(FEATURE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(FEATURE_REGISTRY[0])).toBe(true);
  });
});

describe("preservation migration (not connected to public writers)", () => {
  it.each(vectors)(
    "executes shared native/TypeScript vector: $name",
    (vector) => {
      const r = migrateSettingsV2(vector.rawJSON ?? vector.input, {
        kind: vector.provenance,
        revision: vector.revision,
        provenInitialization: vector.provenInitialization,
      } as SettingsMigrationProvenance);
      if (vector.expected) {
        expect(r.status).toBe("ready");
        if (r.status !== "ready") return;
        expect(r.settings).toEqual(vector.expected);
        const roundtrip = migrateSettingsV2(serializeSettingsV2(r.settings), {
          kind: "readable-local",
          provenInitialization: r.settings.updatedAt === 0,
        });
        expect(roundtrip).toEqual({
          status: "ready",
          settings: r.settings,
          migrated: false,
        });
        expect(parseSettings(serializeSettingsV2(r.settings))).toMatchObject({
          globalOn: r.settings.globalOn,
          updatedAt: r.settings.updatedAt,
          pauses: [],
        });
      } else
        expect(r).toMatchObject({
          status: "recovery",
          reason: vector.reason,
          original: vector.input,
        });
    },
  );

  it("defaults only proven fresh initialization, with extras Off and no edits", () => {
    const r = migrateSettingsV2(null, { kind: "proven-fresh" });
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    expect(r.settings.globalOn).toBe(true);
    expect(Object.values(r.settings.services)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    for (const f of FEATURE_REGISTRY)
      expect(r.settings.sites[f.id]).toBe(f.freshDefault);
    expect(
      Object.values(r.settings.clocks).every(
        (c) => c.baseRevision === 0 && c.localStep === 0,
      ),
    ).toBe(true);
  });

  it("preserves saved Off/custom choices and bounded unknown supported-version data", () => {
    const input = {
      ...legacy,
      sites: {
        "youtube.comments": true,
        "youtube.shorts": false,
        "future.control": false,
      },
      services: { ...legacy.services, futureService: { value: false } },
      future: { retained: [false, "x", 7] },
    };
    const s = migrated(input);
    expect(s.globalOn).toBe(false);
    expect(s.services.youtube).toBe(false);
    expect(s.sites["youtube.comments"]).toBe(true);
    expect(s.sites["youtube.shorts"]).toBe(false);
    expect(s.sites["future.control"]).toBe(false);
    expect(s.services.futureService).toEqual({ value: false });
    expect(s.future).toEqual(input.future);
    expect(s.updatedAt).toBe(50);
    expect(s).not.toHaveProperty("pauses");
    expect(migrated(s)).toEqual(s);
    expect(parseSettings(serializeSettingsV2(s))).toEqual({
      ...legacy,
      pauses: [],
    });
  });

  it("keeps all-Off valid and missing legacy services safe", () => {
    const s = migrated({
      ...legacy,
      services: { youtube: false },
      sites: Object.fromEntries(FEATURE_IDS.map((id) => [id, false])),
    });
    expect(Object.values(s.services).every((v) => v === false)).toBe(true);
    expect(Object.values(s.sites).every((v) => v === false)).toBe(true);
    expect(
      migrated({ ...legacy, services: { youtube: false } }).sites[
        "youtube.shorts"
      ],
    ).toBe(false);
  });

  it("detaches unknown JSON and preserves all modern baseline/edit stamps on no-op", () => {
    const input = migrated();
    const clocks = {
      ...input.clocks,
      "sites.youtube.comments": {
        baseRevision: 90,
        localStep: 1048575,
        opaqueFuture: false,
      },
    };
    const modern = { ...input, clocks, future: { off: false } };
    const result = migrated(modern);
    expect(result.clocks).toEqual(clocks);
    expect(result.future).not.toBe(modern.future);
    modern.future.off = true;
    expect(result.future).toEqual({ off: false });
    expect(result.updatedAt).toBe(input.updatedAt);
  });

  it("rejects invalid provenance and unproven legacy zero without guessing initialization", () => {
    expect(
      migrateSettingsV2(legacy, { kind: "acknowledged-account", revision: -1 })
        .status,
    ).toBe("recovery");
    expect(
      migrateSettingsV2({ ...legacy, updatedAt: 0 }, existing).status,
    ).toBe("recovery");
  });

  it("baseline-stamps supplied fields from acknowledged authority, never timestamps", () => {
    const r = migrateSettingsV2(
      {
        ...legacy,
        services: { youtube: false },
        sites: { "youtube.comments": true },
      },
      { kind: "acknowledged-account", revision: 9 },
    );
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    expect(r.settings.clocks.globalOn).toEqual({
      baseRevision: 9,
      localStep: 0,
    });
    expect(r.settings.clocks["services.youtube"]).toEqual({
      baseRevision: 9,
      localStep: 0,
    });
    expect(r.settings.clocks["services.facebook"]).toEqual({
      baseRevision: 0,
      localStep: 0,
    });
    expect(r.settings.clocks["sites.youtube.comments"]).toEqual({
      baseRevision: 9,
      localStep: 0,
    });
    expect(r.settings.clocks["sites.youtube.shorts"]).toEqual({
      baseRevision: 0,
      localStep: 0,
    });
    expect(r.settings.updatedAt).toBe(50);
  });

  it.each([
    undefined,
    null,
    {},
    "{broken",
    { ...legacy, globalOn: "no" },
    { ...legacy, updatedAt: -1 },
    { ...legacy, updatedAt: 1.5 },
    { ...legacy, updatedAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...legacy, services: [] },
    { ...legacy, pauses: [5] },
  ])("holds damaged/missing input: %j", (input) => {
    const r = migrateSettingsV2(input, existing);
    expect(r.status).toBe("recovery");
    if (r.status === "recovery") expect(r.original).toBe(input);
  });

  it("holds future schema, unknown provenance and conflicting fresh claims", () => {
    expect(
      migrateSettingsV2({ ...legacy, schemaVersion: 3 }, existing),
    ).toMatchObject({ status: "recovery", reason: "future-schema" });
    expect(migrateSettingsV2(null, { kind: "unknown" })).toMatchObject({
      status: "recovery",
      reason: "missing-provenance",
    });
    expect(migrateSettingsV2(legacy, { kind: "unknown" })).toMatchObject({
      status: "recovery",
      reason: "missing-provenance",
    });
    expect(migrateSettingsV2(legacy, { kind: "proven-fresh" })).toMatchObject({
      status: "recovery",
      reason: "provenance-conflict",
    });
  });

  it("rejects invalid clocks, second TikTok state and unbounded/unsafe JSON", () => {
    const s = migrated();
    for (const bad of [-1, 1.2, true, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        migrateSettingsV2(
          {
            ...s,
            clocks: {
              ...s.clocks,
              globalOn: { baseRevision: bad, localStep: 0 },
            },
          },
          existing,
        ).status,
      ).toBe("recovery");
    }
    expect(
      migrateSettingsV2(
        {
          ...s,
          clocks: {
            ...s.clocks,
            globalOn: { baseRevision: 0, localStep: 1048576 },
          },
        },
        existing,
      ).status,
    ).toBe("recovery");
    expect(
      migrateSettingsV2(
        { ...s, sites: { ...s.sites, "tiktok.all": false } },
        existing,
      ).status,
    ).toBe("recovery");
    expect(
      migrateSettingsV2({ ...s, huge: "x".repeat(65537) }, existing).status,
    ).toBe("recovery");
    expect(
      migrateSettingsV2(
        JSON.parse('{"__proto__": {}, "globalOn": false}'),
        existing,
      ).status,
    ).toBe("recovery");
    const cycle: Record<string, unknown> = { ...legacy };
    cycle.self = cycle;
    expect(migrateSettingsV2(cycle, existing).status).toBe("recovery");
  });

  it("retains valid damaged-record fields as repair evidence without a ready document", () => {
    const r = migrateSettingsV2(
      { ...legacy, services: { ...legacy.services, instagram: "damaged" } },
      existing,
    );
    expect(r.status).toBe("recovery");
    if (r.status !== "recovery") return;
    expect(r.usableFields).toMatchObject({
      globalOn: false,
      "services.youtube": false,
      "services.facebook": false,
    });
    expect(r.usableFields).not.toHaveProperty("services.instagram");
  });
});
