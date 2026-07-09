import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import {
  parseSettings,
  parseStoredSettingsRecord,
  parseSyncedSettingsEnvelope,
  safeParse,
} from "../settings-validation.js";

const valid = { ...DEFAULT_SETTINGS, updatedAt: 5 };

describe("parseSettings", () => {
  it("accepts a valid object and its JSON string equivalently", () => {
    expect(parseSettings(valid)).toEqual(valid);
    expect(parseSettings(JSON.stringify(valid))).toEqual(valid);
  });

  it("rejects wrong-shaped objects", () => {
    expect(parseSettings({ ...valid, globalOn: "yes" })).toBeNull();
    expect(parseSettings({ ...valid, updatedAt: "5" })).toBeNull();
    expect(parseSettings({ ...valid, updatedAt: Number.NaN })).toBeNull();
    expect(parseSettings({ globalOn: true, updatedAt: 5 })).toBeNull(); // no services
    expect(parseSettings({ ...valid, services: { ...valid.services, youtube: "yes" } })).toBeNull();
    expect(parseSettings({ ...valid, pauses: ["youtube.com", 7] })).toBeNull();
  });

  it("rejects null / empty / non-object / malformed JSON", () => {
    expect(parseSettings(null)).toBeNull();
    expect(parseSettings("")).toBeNull();
    expect(parseSettings(42)).toBeNull();
    expect(parseSettings("{not json")).toBeNull();
  });

  it("strips unknown fields including forged entitlement state", () => {
    const parsed = parseSettings({
      ...valid,
      entitlement: { pro: true },
      services: { ...valid.services, entitlement: true },
    });
    expect(parsed).toEqual(valid);
    expect(parsed).not.toHaveProperty("entitlement");
    expect(parsed?.services).not.toHaveProperty("entitlement");
  });

  it("ignores stored pauses while the pause UI is removed — no unreachable dead-site state", () => {
    // PR #42 removed the pause-on-this-site control, but the engine and the Chromium DNR gate still
    // honor stored pauses — an upgraded user with youtube.com paused would have Still disabled there
    // with no way to resume. Valid pauses normalize to []; malformed ones still reject (corruption).
    expect(parseSettings({ ...valid, pauses: ["youtube.com"] })).toEqual({ ...valid, pauses: [] });
    expect(
      parseSettings(JSON.stringify({ ...valid, pauses: ["youtube.com", "tiktok.com"] })),
    ).toEqual({ ...valid, pauses: [] });
  });

  it("back-compat: absent pauses defaults to [], absent service defaults off (no settings wipe)", () => {
    // A blob that predates the `pauses` field must NOT be discarded — dropping it makes readProfile()
    // return null and silently wipes the user's synced settings on upgrade.
    const noPauses = { globalOn: valid.globalOn, services: valid.services, updatedAt: valid.updatedAt };
    expect(parseSettings(noPauses)).toEqual({ ...valid, pauses: [] });

    // A blob written before a newer service id existed: the missing service defaults OFF, the rest of
    // the user's choices are preserved (vs. the whole object being rejected).
    const partialServices = { ...valid.services } as Record<string, boolean>;
    delete partialServices.facebook;
    const parsed = parseSettings({ ...valid, services: partialServices });
    expect(parsed).toEqual({ ...valid, services: { ...valid.services, facebook: false } });
  });
});

describe("safeParse", () => {
  it("parses valid JSON and returns null on malformed input", () => {
    expect(safeParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeParse("nope")).toBeNull();
  });
});

describe("settings sync envelope parsing", () => {
  it("parses a canonical Supabase envelope", () => {
    expect(parseSyncedSettingsEnvelope({
      settings: valid,
      settings_version: 7,
      settings_server_updated_at: "2026-07-09T18:00:00.000Z",
      settings_last_write_id: null,
    })).toEqual({
      settings: valid,
      version: 7,
      serverUpdatedAt: "2026-07-09T18:00:00.000Z",
      lastWriteId: null,
    });
  });

  it("ignores invalid envelopes safely", () => {
    expect(parseSyncedSettingsEnvelope({ settings: valid, settings_version: "7" })).toBeNull();
    expect(parseSyncedSettingsEnvelope({ settings: { ...valid, globalOn: "yes" }, settings_version: 7 })).toBeNull();
    expect(parseSyncedSettingsEnvelope({ settings: valid, settings_version: 7, settings_server_updated_at: "nope" })).toBeNull();
  });

  it("parses old settings-only and new stored records", () => {
    expect(parseStoredSettingsRecord(valid)).toEqual({ settings: valid, syncMetadata: null });
    expect(parseStoredSettingsRecord({
      settings: valid,
      syncMetadata: {
        version: 2,
        serverUpdatedAt: "2026-07-09T18:00:00.000Z",
        lastWriteId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      },
    })?.syncMetadata?.version).toBe(2);
  });

  it("parses a record delivered as a JSON string (the Swift encodeRecord wire shape)", () => {
    // The Apple bridge replies with the whole record JSON-encoded; rejecting the string form made
    // App-Group/WKWebView reads come back null and dropped newer native settings.
    expect(parseStoredSettingsRecord(JSON.stringify({ settings: valid }))).toEqual({
      settings: valid,
      syncMetadata: null,
    });
    const withMetadata = parseStoredSettingsRecord(
      JSON.stringify({
        settings: valid,
        syncMetadata: {
          version: 3,
          serverUpdatedAt: "2026-07-09T18:00:00.000Z",
          lastWriteId: null,
        },
      }),
    );
    expect(withMetadata?.syncMetadata?.version).toBe(3);
    // Garbage strings still parse to null, never throw.
    expect(parseStoredSettingsRecord("{not json")).toBeNull();
    expect(parseStoredSettingsRecord(JSON.stringify({ settings: { globalOn: "yes" } }))).toBeNull();
  });
});
