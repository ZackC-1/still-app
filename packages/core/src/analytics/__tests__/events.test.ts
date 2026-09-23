import { describe, it, expect } from "vitest";
import { EVENT_SCHEMA, storeForSurface, validateEvent, ANALYTICS_SURFACES } from "../events.js";

describe("validateEvent", () => {
  it("accepts an event with exactly its schema properties", () => {
    expect(validateEvent("service_toggled", { service: "youtube", enabled: false })).toEqual({
      service: "youtube",
      enabled: false,
    });
    expect(validateEvent("active", undefined)).toEqual({});
    expect(validateEvent("updated", { from: "2.0.0", to: "2.1.0" })).toEqual({ from: "2.0.0", to: "2.1.0" });
  });

  it("rejects unknown events and inherited names", () => {
    expect(validateEvent("page_viewed", {})).toBeNull();
    expect(validateEvent("toString", {})).toBeNull();
    expect(validateEvent(42, {})).toBeNull();
  });

  it("rejects extra, missing or mistyped properties", () => {
    expect(validateEvent("active", { url: "https://youtube.com/shorts/abc" })).toBeNull();
    expect(validateEvent("service_toggled", { service: "youtube" })).toBeNull();
    expect(validateEvent("service_toggled", { service: "youtube", enabled: "yes" })).toBeNull();
    expect(validateEvent("blocking_worked", { service: "vimeo" })).toBeNull();
    expect(validateEvent("installed", [true])).toBeNull();
  });

  it("never lets a web address or free text through a version field", () => {
    expect(validateEvent("updated", { from: "https://youtube.com", to: "2.1.0" })).toBeNull();
    expect(validateEvent("updated", { from: "youtube.com/shorts", to: "2.1.0" })).toBeNull();
    expect(validateEvent("updated", { from: "2.0.0 beta", to: "2.1.0" })).toBeNull();
  });

  it("has no free-text property anywhere in the schema", () => {
    for (const props of Object.values(EVENT_SCHEMA)) {
      for (const spec of Object.values(props as Record<string, unknown>)) {
        expect(spec === "boolean" || spec === "version" || Array.isArray(spec)).toBe(true);
      }
    }
  });
});

describe("storeForSurface", () => {
  it("maps every surface to the store it was downloaded from", () => {
    expect(ANALYTICS_SURFACES.map(storeForSurface)).toEqual(["chrome", "firefox", "ios", "macos", "ios", "macos"]);
  });
});
