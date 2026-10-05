// D28 rating prompt: ui_kits/still-app/d28-rating.html + Rating.babel (review.babel Device).
// The invitation is the real PopupInvitation inside the merged DesktopPopup (invitationVariant
// "d28") or MobilePopup (Firefox Android). Fixture observations admit exactly the invitation the
// reference frame shows; the caller-owned eligibility facts are test values, not product state.
import DesktopPopup from "../../../../packages/core/src/ui/v3/DesktopPopup.svelte";
import MobilePopup from "../../../../packages/core/src/ui/v3/MobilePopup.svelte";
import type { DesktopPopupProps } from "../../../../packages/core/src/ui/v3/presentation.js";
import type { MobilePopupProps } from "../../../../packages/core/src/ui/v3/mobile-presentation.js";
import type { PopupInvitationPresentation } from "../../../../packages/core/src/ui/v3/invitation-presentation.js";
import { accessAll, noop, settingsFor } from "../fixtures.js";
import type { Rendered, ScreenCases, VisualCase } from "../types.js";
import { OWNER_SYNC_COPY } from "./shared.js";

const screen = "d28-rating-prompt";

function invitation(
  kind: "rating" | "sync",
  surface: "chrome" | "firefox" | "firefox-android",
): PopupInvitationPresentation {
  const identity = {
    installation: "visual-install",
    opening: "visual-opening",
    surface,
  };
  const port = {
    verified: true,
    status: "ready" as const,
    identity: { ...identity },
    request: noop,
  };
  return {
    kind,
    identity,
    verified: true,
    fresh: true,
    status: "ready",
    ordinaryOpening: true,
    rating: {
      allowance: { verified: true, fresh: true, global: true, surface: true },
      eligibility: {
        verified: true,
        ageDays: 7,
        distinctUseDays: 3,
        laterOpening: true,
      },
      display: {
        verified: true,
        fresh: true,
        status: "admitted",
        receiptId: "visual-admission",
        identity: { ...identity },
      },
    },
    accept: { ...port, identity: { ...identity } },
    dismiss: { ...port, identity: { ...identity } },
  };
}

function desktop(overrides: Partial<DesktopPopupProps>): () => Rendered {
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
      invitationVariant: "d28",
      ...overrides,
    } satisfies DesktopPopupProps,
  });
}

const popover = { kind: "device", device: "popover", w: 380, h: 600 } as const;
const base = {
  screen,
  component: "DesktopPopup + PopupInvitation (d28)",
  width: 380,
  textScale: 1,
} as const;

const cases: VisualCase[] = [
  {
    ...base,
    id: "d28-01",
    reference: "01-chrome-popup-380-600.png",
    caption: "Chrome popup",
    theme: "light",
    frame: popover,
    render: desktop({ invitation: invitation("rating", "chrome") }),
    deviations: [OWNER_SYNC_COPY],
  },
  {
    ...base,
    id: "d28-02",
    reference: "02-firefox-popup-380-600.png",
    caption: "Firefox popup",
    theme: "dark",
    frame: popover,
    render: desktop({
      browser: "Firefox",
      access: accessAll("purchased"),
      invitation: invitation("rating", "firefox"),
    }),
    deviations: [OWNER_SYNC_COPY],
  },
  {
    ...base,
    id: "d28-03",
    reference: "03-firefox-android-illustrative-360-780.png",
    caption: "Firefox Android (illustrative)",
    component: "MobilePopup + PopupInvitation",
    theme: "light",
    width: 360,
    frame: {
      kind: "device",
      device: "android",
      w: 360,
      h: 780,
      safeTop: 24,
      safeBottom: 16,
    },
    render: () => ({
      component: MobilePopup,
      props: {
        settings: settingsFor(),
        access: accessAll("locked"),
        host: "firefox",
        // MobilePopup admits a Firefox Android invitation only on a verified channel; no
        // onPurchase is supplied, so no purchase button appears (the reference shows none).
        channelReady: true,
        privacyUrl: "#",
        onGlobalChange: noop,
        onServiceChange: noop,
        onFeatureChange: noop,
        onSignIn: noop,
        onSettings: noop,
        invitation: invitation("rating", "firefox-android"),
      } satisfies MobilePopupProps,
    }),
    deviations: [OWNER_SYNC_COPY],
  },
  {
    ...base,
    id: "d28-04",
    reference: "04-sync-invitation-wins-380-600.png",
    caption: "Sync invitation wins",
    theme: "light",
    frame: popover,
    render: desktop({ invitation: invitation("sync", "chrome") }),
    deviations: [OWNER_SYNC_COPY],
  },
  {
    ...base,
    id: "d28-05",
    reference: "05-setup-needed-no-invitation-380-600.png",
    caption: "Setup needed · no invitation",
    theme: "dark",
    frame: popover,
    render: desktop({
      desktopSetup: {
        title: "Still can't block on these websites yet.",
        detail: "Allow Still on these websites so it can block there.",
        actionLabel: "Allow",
      },
    }),
    deviations: [OWNER_SYNC_COPY],
  },
  {
    ...base,
    id: "d28-06",
    reference: "06-sync-error-no-invitation-380-600.png",
    caption: "Sync error · no invitation",
    theme: "light",
    frame: popover,
    render: desktop({
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
    id: "d28-09",
    reference: "09-chrome-popup-1-5-text-380-600-text-1-5.png",
    caption: "Chrome popup · 1.5× text",
    theme: "light",
    textScale: 1.5,
    frame: { ...popover, scale: 1.5 },
    render: desktop({ invitation: invitation("rating", "chrome") }),
    deviations: [OWNER_SYNC_COPY],
  },
];

export const D28: ScreenCases = {
  screen,
  page: "ui_kits/still-app/d28-rating.html",
  cases,
  unmapped: {
    "07-apple-host-native.png":
      "Apple host frame is a placeholder for Apple's native review prompt (StoreKit); Still draws nothing there, so no Svelte component exists to mount",
    "08-owner-view-draft.png":
      "Owner rating allowance view (OwnerAllowances) has no merged V3 Svelte component on main",
  },
};
