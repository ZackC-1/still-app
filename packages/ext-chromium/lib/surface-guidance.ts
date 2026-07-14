import {
  CHROMIUM_SURFACE_GUIDANCE,
  FIREFOX_SURFACE_GUIDANCE,
  type SurfaceGuidance,
} from "@still/core/ui";

// WXT replaces these target flags at build time, so Firefox receives only Firefox guidance and
// Chromium-family builds receive the Extensions-menu/pinning guidance.
export const surfaceGuidance: SurfaceGuidance = import.meta.env.FIREFOX
  ? FIREFOX_SURFACE_GUIDANCE
  : CHROMIUM_SURFACE_GUIDANCE;
