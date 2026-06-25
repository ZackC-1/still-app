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
    expect(parseSettings({ globalOn: true, updatedAt: 5 })).toBeNull(); // no services
  });

  it("rejects null / empty / non-object / malformed JSON", () => {
    expect(parseSettings(null)).toBeNull();
    expect(parseSettings("")).toBeNull();
    expect(parseSettings(42)).toBeNull();
    expect(parseSettings("{not json")).toBeNull();
  });
});

describe("safeParse", () => {
  it("parses valid JSON and returns null on malformed input", () => {
    expect(safeParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeParse("nope")).toBeNull();
  });
});
