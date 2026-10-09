import { describe, expect, it } from "vitest";
import { FEATURE_REGISTRY } from "@still/shared-types";
import { settingsFeatures } from "../settings-features.js";

const HIDDEN = ["youtube.endscreen", "youtube.livechat", "facebook.sponsored"];
const FREE = FEATURE_REGISTRY.filter((row) => row.tier === "free").map((row) => row.id);

describe("settings page rows", () => {
  it.each(["android", "unknown", null] as const)("Firefox with platform %s draws only phone-layout rows, free rows kept", (platform) => {
    const rows = settingsFeatures(true, platform);
    expect(rows).toBeInstanceOf(Array);
    for (const id of HIDDEN) expect(rows, id).not.toContain(id);
    for (const id of [...FREE, "youtube.autoplay", "youtube.comments", "youtube.related"]) expect(rows, id).toContain(id);
  });

  it("desktop Firefox and Chromium draw every row", () => {
    expect(settingsFeatures(true, "desktop")).toBeUndefined();
    for (const platform of ["desktop", "android", "unknown", null] as const) expect(settingsFeatures(false, platform)).toBeUndefined();
  });
});
