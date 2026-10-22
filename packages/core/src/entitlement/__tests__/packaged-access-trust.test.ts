import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { packagedAccessTrust } from "../packaged-access-trust.js";

const root = resolve(__dirname, "../../../../..");
/** The keys list of a trust file, re-serialized the way store builds pass it (VITE_ACCESS_PUBLIC_KEYS). */
const trustFileKeys = (path: string): string =>
  JSON.stringify(
    (
      JSON.parse(readFileSync(resolve(root, path), "utf8")) as {
        keys: unknown[];
      }
    ).keys,
  );
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

describe("pinned store trust files", () => {
  it("the TEST-ONLY fixture parses to two production keys and nothing under any other environment", () => {
    const publicKeys = trustFileKeys(
      "tests/fixtures/access-trust/TEST-ONLY-production-access-keys.json",
    );
    const trust = packagedAccessTrust({
      environment: "production",
      publicKeys,
    });
    expect(trust.environment).toBe("production");
    expect(trust.keys.map((k) => k.kid)).toEqual([
      "test-only-access-current",
      "test-only-access-standby",
    ]);
    expect(trust.keys.every((k) => k.environment === "production")).toBe(true);
    expect(
      packagedAccessTrust({ environment: "sandbox", publicKeys }).keys,
    ).toEqual([]);
  });
  it("every row of the real pinned file is accepted as production trust (none is silently dropped)", () => {
    const publicKeys = trustFileKeys(
      "scripts/release/production-access-keys.json",
    );
    const rows = JSON.parse(publicKeys) as unknown[];
    const trust = packagedAccessTrust({
      environment: "production",
      publicKeys,
    });
    expect(trust.environment).toBe("production");
    expect(trust.keys).toHaveLength(rows.length);
    expect(rows.length).toBeLessThanOrEqual(2);
  });
});
