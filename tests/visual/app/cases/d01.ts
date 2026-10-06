// D01 desktop popup: ui_kits/still-app/desktop-popup.html + DesktopPopup.babel.
import DesktopPopup from "../../../../packages/core/src/ui/v3/DesktopPopup.svelte";
import type { DesktopPopupProps } from "../../../../packages/core/src/ui/v3/presentation.js";
import type { ServiceId } from "@still/shared-types";
import {
  accessAll,
  labelsFor,
  noop,
  settingsFor,
  DESIGN_IDS,
  type DesignId,
} from "../fixtures.js";
import type { ScreenCases, VisualCase } from "../types.js";
import { OWNER_SYNC_COPY } from "./shared.js";

const screen = "d01-desktop-popup";

function popup(
  overrides: Partial<DesktopPopupProps> & { open?: ServiceId },
): () => { component: typeof DesktopPopup; props: Record<string, unknown> } {
  const { open, ...rest } = overrides;
  return () => ({
    component: DesktopPopup,
    props: {
      settings: settingsFor(),
      access: accessAll("locked"),
      browser: "Chrome",
      privacyUrl: "#",
      onGlobalChange: noop,
      onServiceChange: noop,
      onFeatureChange: noop,
      onSignIn: noop,
      onSettings: noop,
      sectionMemory: { read: () => open ?? null, write: noop },
      ...rest,
    } satisfies DesktopPopupProps,
  });
}

const base = {
  screen,
  component: "DesktopPopup",
  width: 380,
  textScale: 1,
} as const;
const DE: { id: DesignId; label: string }[] = [
  { id: "yt_related", label: "Ähnliche Videos" },
  { id: "yt_endscreen", label: "Vorschläge am Ende des Videos" },
  { id: "yt_autoplay", label: "Automatische Wiedergabe verhindern" },
  { id: "yt_comments", label: "Kommentare" },
  { id: "yt_livechat", label: "Livechat" },
];
const signedOut = [OWNER_SYNC_COPY];

const cases: VisualCase[] = [
  {
    ...base,
    id: "d01-01",
    reference: "01-light-pro-not-owned-457px-tall.png",
    caption: "Light · Pro not owned",
    theme: "light",
    frame: { kind: "popup" },
    render: popup({ access: accessAll("locked"), onPurchase: noop }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d01-02",
    reference: "02-dark-pro-purchased-522px-tall.png",
    caption: "Dark · Pro purchased",
    theme: "dark",
    frame: { kind: "popup" },
    render: popup({
      access: accessAll("purchased"),
      open: "instagram",
      settings: settingsFor({ values: { ig_stories: true, ig_explore: true } }),
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d01-03",
    reference: "03-fresh-install-collapsed-457px-tall.png",
    caption: "Fresh install · collapsed",
    theme: "light",
    frame: { kind: "popup" },
    render: popup({ access: accessAll("locked"), onPurchase: noop }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d01-04",
    reference: "04-expanded-youtube-purchased-522px-tall.png",
    caption: "Expanded · YouTube, purchased",
    theme: "light",
    frame: { kind: "popup" },
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
    id: "d01-05",
    reference: "05-still-off-choices-kept-522px-tall.png",
    caption: "Still off · choices kept",
    theme: "dark",
    frame: { kind: "popup" },
    render: popup({
      access: accessAll("purchased"),
      open: "youtube",
      settings: settingsFor({ on: false, values: { yt_comments: true } }),
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d01-06",
    reference: "06-checking-access-signed-in-syncing-531px-tall.png",
    caption: "Checking access · signed in, syncing",
    theme: "light",
    frame: { kind: "popup" },
    render: popup({
      access: accessAll("checking"),
      open: "facebook",
      settings: settingsFor({ values: { fb_stories: true } }),
      account: {
        address: "sam@example.com",
        status: { tone: "pending", text: "Syncing your settings…" },
      },
    }),
  },
  {
    ...base,
    id: "d01-07",
    reference: "07-needs-verification-sync-failed-569px-tall.png",
    caption: "Needs verification · sync failed",
    theme: "dark",
    frame: { kind: "popup" },
    render: popup({
      access: accessAll("verify"),
      open: "instagram",
      settings: settingsFor({ values: { ig_stories: true } }),
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
    id: "d01-09",
    reference: "09-150-text-text-scale-scrolls-inside-582px-tall.png",
    caption: "150% text (--text-scale) · scrolls inside",
    theme: "light",
    textScale: 1.5,
    frame: { kind: "popup", innerTextScale: 1.5 },
    render: popup({ access: accessAll("purchased"), open: "youtube" }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d01-10",
    reference: "10-long-text-de-522px-tall.png",
    caption: "Long text (de)",
    theme: "light",
    frame: { kind: "popup" },
    render: popup({
      access: accessAll("purchased"),
      open: "youtube",
      settings: settingsFor({ values: { yt_endscreen: true } }),
      services: ["youtube", "tiktok"],
      features: DE.map((row) => DESIGN_IDS[row.id]),
      labels: labelsFor(DE),
      heroTitle: "Still ist aktiv",
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d01-11",
    reference: "11-focus-on-the-youtube-expander-457px-tall.png",
    caption: "Focus on the YouTube expander",
    theme: "light",
    frame: { kind: "popup", cls: "kbd" },
    render: popup({ access: accessAll("locked"), onPurchase: noop }),
    focus: { selector: '[aria-controls="site-youtube-panel"]' },
    deviations: signedOut,
  },
];

export const D01: ScreenCases = {
  screen,
  page: "ui_kits/still-app/desktop-popup.html",
  cases,
};
