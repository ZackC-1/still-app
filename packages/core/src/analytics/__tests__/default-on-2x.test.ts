import { describe, expect, it } from "vitest";
import { privacyPolicyReady } from "../consent.js";
import { USAGE_ON_BY_DEFAULT_BUILD } from "../build-basis.js";
import { DEFAULT_ON_USAGE_POLICY } from "../default-on.js";

// No build flag set (as in every 2.x build): the default-on basis is not compiled in, so even a host
// that passed DEFAULT_ON_USAGE_POLICY would admit nothing. 2.x hosts never pass it.
describe("the default-on basis in a 2.x build", () => {
  it("is refused", () => {
    expect(USAGE_ON_BY_DEFAULT_BUILD).toBe(false);
    expect(privacyPolicyReady(DEFAULT_ON_USAGE_POLICY)).toBe(false);
  });
});
