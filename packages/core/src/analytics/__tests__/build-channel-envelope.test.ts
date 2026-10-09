import { describe, expect, it } from "vitest";
import { buildChannelEnvelope, serverIdentifyFor } from "../events.js";

describe("buildChannelEnvelope", () => {
  it("labels only QA builds, and only as test", () => {
    expect(buildChannelEnvelope("test")).toEqual({ build_channel: "test" });
    for (const value of [undefined, "", "release", "dev", "TEST", " test", true, 1, null])
      expect(buildChannelEnvelope(value)).toBeUndefined();
  });

  it("never asks the store-project server attach from a test-labelled build", () => {
    const attach = async () => {};
    expect(serverIdentifyFor({ build_channel: "test" }, attach)).toBeUndefined();
    expect(serverIdentifyFor(undefined, attach)).toBe(attach);
    expect(serverIdentifyFor({ build_channel: "release" }, attach)).toBe(attach);
  });
});
