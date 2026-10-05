// D02 mobile popup: ui_kits/still-app/d02-mobile-popup.html + MobilePopup.babel + review.babel Device.
import MobilePopup from "../../../../packages/core/src/ui/v3/MobilePopup.svelte";
import type { MobilePopupProps } from "../../../../packages/core/src/ui/v3/mobile-presentation.js";
import type { ServiceId } from "@still/shared-types";
import {
  accessAll,
  labelsFor,
  noop,
  settingsFor,
  type DesignId,
} from "../fixtures.js";
import type { FrameSpec, ScreenCases, VisualCase } from "../types.js";
import { OWNER_SYNC_COPY } from "./shared.js";

const screen = "d02-mobile-popup";

function popup(
  overrides: Partial<MobilePopupProps> & { open?: ServiceId },
): () => { component: typeof MobilePopup; props: Record<string, unknown> } {
  const { open, ...rest } = overrides;
  const host = rest.host ?? "safari";
  return () => ({
    component: MobilePopup,
    props: {
      settings: settingsFor(),
      access: accessAll("locked"),
      host,
      // Safari lock rows and "See Still Pro" open the Still app (reference: working route).
      onSeePro: host === "safari" ? noop : undefined,
      privacyUrl: "#",
      onGlobalChange: noop,
      onServiceChange: noop,
      onFeatureChange: noop,
      onSignIn: noop,
      onSettings: noop,
      sectionMemory: { read: () => open ?? null, write: noop },
      ...rest,
    } satisfies MobilePopupProps,
  });
}

const iphoneSE = (scale?: number): FrameSpec => ({
  kind: "device",
  device: "iphone",
  w: 375,
  h: 667,
  safeTop: 20,
  ...(scale ? { scale } : {}),
});
const iphone15: FrameSpec = {
  kind: "device",
  device: "iphone",
  w: 393,
  h: 852,
  safeTop: 59,
  safeBottom: 34,
};
const android: FrameSpec = {
  kind: "device",
  device: "android",
  w: 360,
  h: 780,
  safeTop: 24,
  safeBottom: 16,
};
const signedOut = [OWNER_SYNC_COPY];
const base = { screen, component: "MobilePopup", textScale: 1 } as const;
const DE_YT: { id: DesignId; label: string }[] = [
  { id: "yt_shorts", label: "Shorts" },
  { id: "yt_related", label: "Ähnliche Videos" },
  { id: "yt_endscreen", label: "Vorschläge am Ende des Videos" },
  { id: "yt_autoplay", label: "Automatische Wiedergabe verhindern" },
  { id: "yt_comments", label: "Kommentare" },
  { id: "yt_livechat", label: "Livechat" },
];

const cases: VisualCase[] = [
  {
    ...base,
    id: "d02-01",
    reference: "01-iphone-se-fresh-install-375-667.png",
    caption: "iPhone SE · fresh install",
    theme: "light",
    width: 375,
    frame: iphoneSE(),
    render: popup({ access: accessAll("locked") }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d02-02",
    reference: "02-iphone-15-pro-bought-in-the-still-app-393-852.png",
    caption: "iPhone 15 · Pro bought in the Still app",
    theme: "dark",
    width: 393,
    frame: iphone15,
    render: popup({
      access: accessAll("purchased"),
      open: "youtube",
      settings: settingsFor({
        values: { yt_comments: true, yt_autoplay: true },
      }),
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d02-03",
    reference: "03-iphone-15-safari-pro-not-owned-393-852.png",
    caption: "iPhone 15 · Safari, Pro not owned",
    theme: "light",
    width: 393,
    frame: iphone15,
    render: popup({ access: accessAll("locked"), open: "facebook" }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d02-04",
    reference: "04-safari-permission-needed-375-667.png",
    caption: "Safari · permission needed",
    theme: "light",
    width: 375,
    frame: iphoneSE(),
    render: popup({ access: accessAll("locked"), setup: { onAction: noop } }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d02-05",
    reference: "05-firefox-android-permission-needed-illustrative-360-780.png",
    caption: "Firefox Android · permission needed (illustrative)",
    theme: "dark",
    width: 360,
    frame: android,
    render: popup({
      host: "firefox",
      access: accessAll("locked"),
      setup: { onAction: noop },
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d02-06",
    reference: "06-instagram-mixed-access-393-852.png",
    caption: "Instagram · mixed access",
    theme: "light",
    width: 393,
    frame: iphone15,
    render: popup({
      access: accessAll("locked", {
        ig_stories: "purchased",
        ig_explore: "unsupported",
        ig_suggested: "checking",
        ig_threads: "verify",
      }),
      open: "instagram",
      settings: settingsFor({
        values: { ig_stories: true, ig_explore: true, ig_suggested: true },
      }),
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d02-07",
    reference: "07-still-off-signed-in-sync-failed-393-852.png",
    caption: "Still off · signed in, sync failed",
    theme: "dark",
    width: 393,
    frame: iphone15,
    render: popup({
      access: accessAll("purchased"),
      open: "youtube",
      settings: settingsFor({ on: false, values: { yt_comments: true } }),
      account: {
        address: "sam@example.com",
        status: {
          tone: "failed",
          text: "Sync didn't finish. Your settings are saved on this device.",
          retry: noop,
        },
      },
    }),
  },
  {
    ...base,
    id: "d02-08",
    reference: "08-ipad-safari-popover-380-600.png",
    caption: "iPad · Safari popover",
    theme: "light",
    width: 380,
    frame: { kind: "device", device: "popover", w: 380, h: 600 },
    render: popup({ access: accessAll("locked"), open: "youtube" }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d02-09",
    reference:
      "09-firefox-android-pro-not-owned-channel-unverified-360-780.png",
    caption: "Firefox Android · Pro not owned, channel unverified",
    theme: "light",
    width: 360,
    frame: android,
    render: popup({
      host: "firefox",
      access: accessAll("locked"),
      open: "instagram",
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d02-10",
    reference: "10-iphone-se-xxxlarge-375-667-text-1-35.png",
    caption: "iPhone SE · xxxLarge",
    theme: "light",
    width: 375,
    textScale: 1.35,
    frame: iphoneSE(1.35),
    render: popup({ access: accessAll("locked"), open: "youtube" }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d02-11",
    reference: "11-iphone-se-accessibility-size-375-667-text-2.png",
    caption: "iPhone SE · accessibility size",
    theme: "dark",
    width: 375,
    textScale: 2,
    frame: iphoneSE(2),
    render: popup({ access: accessAll("locked") }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d02-12",
    reference: "12-firefox-android-german-360-780.png",
    caption: "Firefox Android · German",
    theme: "light",
    width: 360,
    frame: android,
    render: popup({
      host: "firefox",
      access: accessAll("purchased"),
      open: "youtube",
      settings: settingsFor({ values: { yt_endscreen: true } }),
      labels: labelsFor(DE_YT),
    }),
    deviations: signedOut,
  },
];

export const D02: ScreenCases = {
  screen,
  page: "ui_kits/still-app/d02-mobile-popup.html",
  cases,
};
