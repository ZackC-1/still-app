import { describe, expect, it } from "vitest";
import { packagedAccessTrust } from "../packaged-access-trust.js";
const key = {
  kid: "test-access",
  publicKeyHex: "a".repeat(64),
  purpose: "access",
  environment: "sandbox",
};
describe("compiled public access trust", () => {
  it("defaults to production with no signing keys", () => {
    expect(packagedAccessTrust()).toEqual({
      environment: "production",
      keys: [],
    });
  });
  it("accepts only exact keys matching explicit packaged environment and freezes them", () => {
    const trust = packagedAccessTrust({
      environment: "sandbox",
      publicKeys: JSON.stringify([key]),
    });
    expect(trust.keys).toEqual([key]);
    expect(Object.isFrozen(trust)).toBe(true);
    expect(Object.isFrozen(trust.keys[0])).toBe(true);
    expect(
      packagedAccessTrust({
        publicKeys: JSON.stringify([{ ...key, environment: "production" }]),
      }).keys,
    ).toHaveLength(1);
  });
  it.each(["test", "sandbox ", "SANDBOX", ""])(
    "unknown environment %s accepts no keys",
    (environment) => {
      expect(
        packagedAccessTrust({ environment, publicKeys: JSON.stringify([key]) }),
      ).toEqual({ environment: "production", keys: [] });
    },
  );
  it("fails closed on mixed/unknown purposes, malformed keys, duplicates and oversize input", () => {
    for (const publicKeys of [
      "invalid",
      JSON.stringify({ keys: [key] }),
      JSON.stringify([key, key]),
      JSON.stringify(Array(9).fill(key)),
      " ".repeat(16385),
      ...[
        { ...key, environment: "production" },
        { ...key, purpose: "rules" },
        { ...key, privateKeyHex: "b".repeat(64) },
        { ...key, publicKeyHex: "A".repeat(64) },
        { ...key, kid: "../test" },
      ].map((k) => JSON.stringify([k])),
    ])
      expect(
        packagedAccessTrust({ environment: "sandbox", publicKeys }).keys,
      ).toEqual([]);
  });
});
