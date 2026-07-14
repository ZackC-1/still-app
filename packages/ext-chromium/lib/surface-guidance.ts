// The deep path (not the "@still/core/ui" barrel, which re-exports Svelte components) keeps this
// module loadable in this package's node-environment vitest.
import {
  CHROMIUM_SURFACE_GUIDANCE,
  FIREFOX_SURFACE_GUIDANCE,
  type SurfaceGuidance,
} from "@still/core/ui/surface-guidance";

/** Pure branch so tests can cover both targets without WXT's build-time flag replacement. */
export function pickSurfaceGuidance(isFirefox: boolean): SurfaceGuidance {
  return isFirefox ? FIREFOX_SURFACE_GUIDANCE : CHROMIUM_SURFACE_GUIDANCE;
}

// WXT replaces these target flags at build time, so Firefox receives only Firefox guidance and
// Chromium-family builds receive the Extensions-menu/pinning guidance.
export const surfaceGuidance: SurfaceGuidance = pickSurfaceGuidance(
  Boolean(import.meta.env.FIREFOX),
);
