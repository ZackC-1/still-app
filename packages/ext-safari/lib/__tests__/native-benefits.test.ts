import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initialAccessSnapshot, packagedAccessContext } from "@still/core/entitlement";
import { parseNativeBenefitReply } from "../native-benefits.js";

// A purchased snapshot as the native handler commits it (shape only; values are synthetic).
const base = initialAccessSnapshot(packagedAccessContext("safari", "desktop"));
const snapshot = { ...base, states: { ...base.states, "youtube.comments": "purchased" } };
const lane = (body: unknown) => ({ entitlement: JSON.stringify(body) });

describe("parseNativeBenefitReply", () => {
  it("reads the snapshot from the handler's entitlement lane", () => {
    const parsed = parseNativeBenefitReply(lane({ ok: true, snapshot }));
    expect(parsed.states["youtube.comments"]).toBe("purchased");
    expect(parsed.generation).toBe(snapshot.generation);
  });

  it("fails closed on the settings lane, ok:false, malformed JSON and a bad snapshot", () => {
    for (const reply of [
      { settings: JSON.stringify({ ok: true, snapshot }) },
      lane({ ok: false }),
      lane({ ok: true, snapshot: { ...snapshot, states: {} } }),
      { entitlement: "{" },
      { entitlement: { ok: true, snapshot } },
      null,
      "",
    ]) expect(() => parseNativeBenefitReply(reply)).toThrow();
  });

  it("matches the lane the Safari handler actually replies on", () => {
    const handler = readFileSync(new URL("../../../../apps/apple/Still/Shared (Extension)/SafariWebExtensionHandler.swift", import.meta.url), "utf8");
    expect(handler).toContain('payload = ["entitlement": entitlementJSON]');
    expect(handler).toContain("EntitlementBridge.safariExtension(store: .appGroup())");
  });

  it("is reached from the background only inside the folded paid branch", () => {
    const background = readFileSync(new URL("../../entrypoints/background.ts", import.meta.url), "utf8");
    expect(background).toContain("if (PAID_TIER_ENABLED) return parseNativeBenefitReply(reply);");
    expect(background.match(/parseNativeBenefitReply/g)).toHaveLength(2); // the import and the folded call
  });
});
