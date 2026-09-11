import { describe, expect, it } from "vitest";
import { pickEmailConsent } from "../email-consent.js";

// One build produces both add-ons, and each store asks for a different thing before an email
// address may be collected. Getting the branch backwards would ship a Chrome-shaped disclosure to
// Firefox reviewers, who require an explicit opt-in, so it is worth a test of its own.

describe("which consent step each browser gets", () => {
  it("Firefox requires an explicit opt-in", () => {
    expect(pickEmailConsent(true)).toBe("opt-in");
  });

  it("the Chromium family gets the point-of-collection disclosure", () => {
    expect(pickEmailConsent(false)).toBe("disclosure");
  });

  it("never answers none: both browser stores require something", () => {
    for (const isFirefox of [true, false]) {
      expect(pickEmailConsent(isFirefox)).not.toBe("none");
    }
  });
});
