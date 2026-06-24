import { describe, it, expect } from "vitest";
import seed from "../../../rules/seed.json";
import type { RuleSetPayload, SignedRuleSet } from "@still/shared-types";
import { signRuleSet, verifyRuleSet, publicKeyHexFor } from "../signature.js";
import { DEV_RULE_SET_KEYS, RULE_SET_MIN_VERSION } from "../trusted-keys.js";

const devOpts = { allowedKeys: DEV_RULE_SET_KEYS, minVersion: RULE_SET_MIN_VERSION };

describe("verifyRuleSet", () => {
  it("verifies the bundled seed against the dev key allowlist", async () => {
    const result = await verifyRuleSet(seed as unknown as SignedRuleSet, devOpts);
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered payload (selector changed after signing)", async () => {
    const tampered = JSON.parse(JSON.stringify(seed)) as SignedRuleSet;
    (tampered.services.youtube!.surfaces[1] as unknown as { selectors: string[] }).selectors.push("body");
    const result = await verifyRuleSet(tampered, devOpts);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown signing kid", async () => {
    const result = await verifyRuleSet(seed as unknown as SignedRuleSet, {
      allowedKeys: [{ kid: "some-other-kid", publicKeyHex: DEV_RULE_SET_KEYS[0]!.publicKeyHex }],
      minVersion: RULE_SET_MIN_VERSION,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a validly-signed set below the version floor (rollback defense)", async () => {
    const result = await verifyRuleSet(seed as unknown as SignedRuleSet, {
      allowedKeys: DEV_RULE_SET_KEYS,
      minVersion: "2.0.0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/floor/);
  });

  it("round-trips sign → verify with a freshly chosen key", async () => {
    const priv = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const kid = "test-key";
    const payload = { version: "1.2.0", services: seed.services } as unknown as RuleSetPayload;
    const signed = await signRuleSet(payload, priv, kid);
    const pub = await publicKeyHexFor(priv);
    const ok = await verifyRuleSet(signed, { allowedKeys: [{ kid, publicKeyHex: pub }], minVersion: "1.0.0" });
    expect(ok.ok).toBe(true);

    // ...and the same signature fails under a different key.
    const wrongPub = DEV_RULE_SET_KEYS[0]!.publicKeyHex;
    const bad = await verifyRuleSet(signed, { allowedKeys: [{ kid, publicKeyHex: wrongPub }], minVersion: "1.0.0" });
    expect(bad.ok).toBe(false);
  });
});
