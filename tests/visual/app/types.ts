import type { Component } from "svelte";

/**
 * Review framing reproduced outside the component, matching the element the design package's
 * capture script screenshotted. These are review chrome only, never product UI.
 * - "popup": D01's `.p-frame` (380 wide, 10px radius) from desktop-popup.html.
 * - "device": review.babel's `Device` (`.r-device.r-<kind>`), with its sheet, tab bar or title bar.
 * - "gallery": the gallery's `.g-frame.still-ui` pane.
 * - "card": D03's single-card `Card` panel.
 */
export type FrameSpec =
  | { kind: "popup"; cls?: string; innerTextScale?: number }
  | {
      kind: "device";
      device:
        | "iphone"
        | "android"
        | "popover"
        | "tab"
        | "mac"
        | "iphoneapp"
        | "ipadapp";
      w: number;
      h: number;
      safeTop?: number;
      safeBottom?: number;
      scale?: number;
      url?: string;
      title?: string;
      cls?: string;
    }
  | { kind: "gallery"; width: number; height?: number }
  /** SettingsPage.babel `Card`: an auto-height `.r-device.r-tab.still-ui` panel, no tab bar. */
  | { kind: "card"; w?: number };

// Each case renders a different component; its props are checked where the case builds them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyComponent = Component<any>;
export interface Rendered {
  component: AnyComponent;
  props: Record<string, unknown>;
}

export interface VisualCase {
  /** Stable id: `<screen code>-<reference index>`, e.g. `d01-01`. */
  id: string;
  /** Reference directory slug under handoff/reference. */
  screen: string;
  /** Reference PNG file name inside the screen directory. */
  reference: string;
  caption: string;
  /** Repository component under test (for the report). */
  component: string;
  theme: "light" | "dark";
  width: number;
  textScale: number;
  frame: FrameSpec;
  /** The merged component and the fixture props reproducing the reference state. */
  render: () => Rendered | Promise<Rendered>;
  /** Reach this element with real Tab presses before capture (focus frames). */
  focus?: { selector: string; maxTabs?: number };
  /** Real input applied by the runner after mount, before focus/capture (e.g. open a dialog). */
  actions?: ({ click: string } | { press: string })[];
  /**
   * Known differences from the reference (owner-approved copy, owner-accepted behaviour, reference
   * review artefacts). Never a mask and never the verdict: a failing frame always reports the
   * measured pixel difference, then each deviation with the differing pixels found inside its
   * region, then whatever remains outside every declared region.
   */
  deviations?: (string | Deviation)[];
  /** The frame proves layout with this caller-supplied copy, not production caller wiring. */
  callerCopy?: string;
  notes?: string;
}

export interface Deviation {
  reason: string;
  /** Implementation elements that carry the difference (CSS selector inside the frame)... */
  selector?: string;
  /** ...or the elements whose own text contains this string. */
  text?: string;
  /** CSS px added around each matched element (focus rings sit outside the box). Default 2. */
  pad?: number;
}

export interface ScreenCases {
  screen: string;
  /** Reference page under the design package, for its review-chrome styles. */
  page: string;
  cases: VisualCase[];
  /** Reference outputs this screen cannot map yet, with the reason. */
  unmapped?: Record<string, string>;
  /** Reason reported for any other reference output on this page without a case. */
  defaultUnmappedReason?: string;
}
