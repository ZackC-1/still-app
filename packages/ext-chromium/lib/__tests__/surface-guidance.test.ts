import { describe, expect, it } from "vitest";
import {
  CHROMIUM_SURFACE_GUIDANCE,
  FIREFOX_SURFACE_GUIDANCE,
} from "@still/core/ui/surface-guidance";
import { pickSurfaceGuidance } from "../surface-guidance";

describe("surface guidance selection", () => {
  it("gives Firefox builds the Firefox toolbar guidance", () => {
    expect(pickSurfaceGuidance(true)).toBe(FIREFOX_SURFACE_GUIDANCE);
  });

  it("gives Chromium-family builds the Extensions-menu/pinning guidance", () => {
    expect(pickSurfaceGuidance(false)).toBe(CHROMIUM_SURFACE_GUIDANCE);
  });
});
