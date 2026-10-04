import type { DesktopPopupProps } from "./presentation.js";

/** Controlled mobile presentation only; platform support and action authority belong to the caller. */
export interface MobilePopupProps extends Omit<
  DesktopPopupProps,
  "browser" | "heroTitle"
> {
  host: "safari" | "firefox";
  /** Supplied only after the actual Firefox Android managed channel is verified. */
  channelReady?: boolean;
  /** Supplied only when the Safari-to-app route has been verified. */
  onSeePro?: () => void;
  /** Reference setup wording remains unverified; this does not request permissions. */
  setup?: { onAction?: () => void };
}
