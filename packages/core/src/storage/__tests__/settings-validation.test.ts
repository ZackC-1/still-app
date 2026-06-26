import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { parseSettings, safeParse } from "../settings-validation.js";

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
