/**
 * Host context for the settings affordance's accessible name. Settings surfaces link to the
 * shared online setup guide; device-specific instructions live there.
 */
export interface SurfaceGuidance {
  readonly title: string;
}

/** Chromium browsers put extensions in the Extensions (puzzle) menu until a user pins them. */
export const CHROMIUM_SURFACE_GUIDANCE: SurfaceGuidance = {
  title: "Find Still in your browser",
};

/** Firefox's `default_area` toolbar placement covers new installs only; upgrades keep the user's layout. */
export const FIREFOX_SURFACE_GUIDANCE: SurfaceGuidance = {
  title: "Find Still in Firefox",
};

/** Safari exposes extensions from its page menu on iPhone/iPad and from its toolbar on macOS. */
export const SAFARI_SURFACE_GUIDANCE: SurfaceGuidance = {
  title: "Use Still in Safari",
};
