import { describe, expect, it } from "vitest";
import { privacyPolicyReady } from "../consent.js";
import { USAGE_ON_BY_DEFAULT_BUILD } from "../build-basis.js";
import { DEFAULT_ON_USAGE_POLICY } from "../default-on.js";

// No build flag set (as in every 2.x build): the default-on basis is not compiled in, so even a host
// that passed DEFAULT_ON_USAGE_POLICY would admit nothing. 2.x hosts never pass it.
//
// Vite (and Vitest's transform) inline the flags from the environment the run started with, so a
// shell or CI job that exports a V3 flag runs this file as a V3 build: then it is skipped, saying
// why, rather than failing on something other than the code. The V3 side is covered by the
// default-on tests (which mock build-basis.ts) and by the bundle identity snapshots.
const V3_ENV =
  process.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true" || process.env.VITE_APPLE_ATOMIC_SETTINGS === "true";

describe("the default-on basis in a 2.x build", () => {
  it.skipIf(V3_ENV)("is refused (skipped: this run exports a V3 build flag)", () => {
    expect(USAGE_ON_BY_DEFAULT_BUILD).toBe(false);
    expect(privacyPolicyReady(DEFAULT_ON_USAGE_POLICY)).toBe(false);
  });
});
