import { describe, expect, it } from "vitest";
import { buildChannelEnvelope } from "../events.js";

describe("buildChannelEnvelope", () => {
  it("labels only QA builds, and only as test", () => {
    expect(buildChannelEnvelope("test")).toEqual({ build_channel: "test" });
    for (const value of [undefined, "", "release", "dev", "TEST", " test", true, 1, null])
      expect(buildChannelEnvelope(value)).toBeUndefined();
  });
});
