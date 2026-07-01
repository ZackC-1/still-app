import { describe, expect, it, vi } from "vitest";
import { applyNativeEntitlement, parseNativeEntitlement } from "../entitlement-pull.js";

const record = (entitled: boolean, updatedAt: number) => ({ entitled, updatedAt });
const reply = (entitled: boolean, updatedAt: number) => ({
  entitlement: JSON.stringify({ entitled, updatedAt }),
});

describe("parseNativeEntitlement", () => {
  it("parses the native { entitlement: '<json>' } envelope", () => {
    expect(parseNativeEntitlement(reply(true, 42))).toEqual(record(true, 42));
    expect(parseNativeEntitlement(reply(false, 7))).toEqual(record(false, 7));
  });

  it("returns null for an empty reply (nothing stored in the App Group yet)", () => {
    expect(parseNativeEntitlement({ entitlement: "" })).toBeNull();
  });

  it("returns null for missing/malformed envelopes and payloads", () => {
    expect(parseNativeEntitlement(null)).toBeNull();
    expect(parseNativeEntitlement(undefined)).toBeNull();
    expect(parseNativeEntitlement("json string")).toBeNull();
    expect(parseNativeEntitlement({ settings: "{}" })).toBeNull(); // settings lane, not entitlement
    expect(parseNativeEntitlement({ entitlement: "{not json" })).toBeNull();
    expect(parseNativeEntitlement({ entitlement: '"just a string"' })).toBeNull();
    expect(parseNativeEntitlement({ entitlement: '{"entitled":"yes","updatedAt":1}' })).toBeNull();
    expect(parseNativeEntitlement({ entitlement: '{"entitled":true}' })).toBeNull(); // no stamp
    expect(parseNativeEntitlement({ entitlement: '{"entitled":true,"updatedAt":null}' })).toBeNull();
  });
});

describe("applyNativeEntitlement", () => {
  it("writes the record through, preserving the app's server-confirmed updatedAt", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await expect(applyNativeEntitlement(record(true, 42), { set })).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(true, 42);
  });

  it("writes an explicit revocation (entitled:false)", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await expect(applyNativeEntitlement(record(false, 9), { set })).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(false, 9);
  });

  it("no-ops on a null record — an unreadable pull never downgrades local storage", async () => {
    const set = vi.fn();
    await expect(applyNativeEntitlement(null, { set })).resolves.toBe(false);
    expect(set).not.toHaveBeenCalled();
  });
});
