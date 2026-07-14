/**
 * A small, host-supplied explanation of where Still lives after setup. Keeping the copy here makes
 * the shared UI present the same accessible treatment on every host, while each package selects
 * only the guidance that is true for its browser or native surface.
 */
export interface SurfaceGuidance {
  readonly title: string;
  readonly body: string;
}

/** Chromium browsers put extensions in the Extensions (puzzle) menu until a user pins them. */
export const CHROMIUM_SURFACE_GUIDANCE: SurfaceGuidance = {
  title: "Find Still in your browser",
  body: "Open the Extensions menu (the puzzle icon), then pin Still to keep it on your toolbar.",
};

/** Firefox lets a user move the action later, but new Still installs start in the toolbar. */
export const FIREFOX_SURFACE_GUIDANCE: SurfaceGuidance = {
  title: "Find Still in Firefox",
  body: "Still starts in Firefox’s toolbar. To move it later, open Customize Toolbar and drag Still where you want it.",
};

/** Safari exposes extensions from its page menu on iPhone/iPad and from its toolbar on macOS. */
export const SAFARI_SURFACE_GUIDANCE: SurfaceGuidance = {
  title: "Use Still in Safari",
  body: "On iPhone and iPad, use Safari’s Page Menu, then Manage Extensions. On Mac, click Still in Safari’s toolbar; if it isn’t enabled, choose Safari > Settings > Extensions.",
};
