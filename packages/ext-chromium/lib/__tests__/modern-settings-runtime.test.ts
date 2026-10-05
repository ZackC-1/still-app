import { describe, expect, it } from "vitest";
import { modernSettingsRuntime } from "../modern-settings-runtime.js";

const url = "https://synthetic.invalid",
  key = "synthetic-public-key";
describe("paired packaged settings runtime", () => {
  it.each([undefined, "", "false", "TRUE", " true", "true ", "1"])(
    "configured flag %j retains legacy free cloud and popup",
    (flag) => {
      expect(modernSettingsRuntime(url, key, flag)).toEqual({
        supabase: { url, anonKey: key },
        atomicLocal: false,
        modernCloud: false,
      });
    },
  );
  it("literal true enables canonical backend and committed popup together", () => {
    expect(modernSettingsRuntime(url, key, "true")).toEqual({
      supabase: { url, anonKey: key },
      atomicLocal: true,
      modernCloud: true,
    });
  });
  it.each([
    [undefined, undefined],
    [url, ""],
    ["", key],
  ])(
    "missing public config %j/%j stays atomic local only even with true",
    (endpoint, anonKey) => {
      expect(modernSettingsRuntime(endpoint, anonKey, "true")).toEqual({
        supabase: null,
        atomicLocal: true,
        modernCloud: false,
      });
    },
  );
});
