// D04 Apple app settings: ui_kits/still-app/d04-apple-settings.html + AppleSettings.babel.
import AppleSettings from "../../../../packages/core/src/ui/v3/AppleSettings.svelte";
import type { AppleSettingsProps } from "../../../../packages/core/src/ui/v3/apple-settings-presentation.js";
import type { ServiceId } from "@still/shared-types";
import { accessAll, noop, settingsFor } from "../fixtures.js";
import type { FrameSpec, Rendered, ScreenCases, VisualCase } from "../types.js";
import { OWNER_SYNC_COPY, REFERENCE_DEMO_ACCOUNT } from "./shared.js";

const screen = "d04-apple-app-settings";

// review.babel SAMPLE_OFFER (a labelled sample; the price itself is never drawn on D04).
const SAMPLE_OFFER = {
  price: "$9.99",
  priceNote: "One payment. Access forever. No subscription",
};
const SETUP_STEPS = {
  ios: [
    "Open the Settings app.",
    "Go to Apps, then Safari, then Extensions.",
    "Turn on Still and allow it on every website.",
  ],
  mac: [
    "Open Safari, then Settings, then Extensions.",
    "Turn on Still.",
    "Allow it on every website.",
  ],
};
const ACCOUNT = "sam@example.com";

/**
 * AppleSettings.babel props translated to the component's ports. `pro` is the babel `pro`
 * ownership ("none" | "owned" | "verify"); `offerState` its ProOffer state. Sharing "off" has no
 * approved purposes (HANDOFF §7 keeps them open), so the component holds its switch.
 */
function settingsPage(options: {
  platform?: "ios" | "mac";
  access: ReturnType<typeof accessAll>;
  open?: ServiceId;
  values?: Parameters<typeof settingsFor>[0];
  pro?: "none" | "owned" | "verify";
  offerState?: "idle" | "pending";
  restore?: "failed" | "verify" | "nothing";
  signedIn?: boolean;
  sync?: { tone: "success"; text: string };
  linkInvite?: boolean;
  link?: "confirm";
  consent?: "on" | "off";
  setup?: boolean;
}): () => Rendered {
  const platform = options.platform ?? "ios";
  const pro = options.pro ?? "none";
  return () => ({
    component: AppleSettings,
    props: {
      platform,
      settings: settingsFor(options.values),
      access: options.access,
      onGlobalChange: noop,
      onServiceChange: noop,
      onFeatureChange: noop,
      sectionMemory: { read: () => options.open ?? null, write: noop },
      sync: options.signedIn
        ? {
            account: {
              address: ACCOUNT,
              confirmed: true,
              status: options.sync,
              onSignOut: noop,
              onDeleteAccount: noop,
              identity: "account-visual-fixture",
              revision: 1,
            },
          }
        : { onSignIn: noop },
      pro: {
        ownership: pro,
        channel: "ready",
        offer: SAMPLE_OFFER,
        state: options.offerState ?? "idle",
        onBuy: noop,
        onRestore: noop,
      },
      restore: options.restore
        ? { state: options.restore, onAction: noop }
        : undefined,
      link: options.link
        ? {
            state: options.link,
            email: ACCOUNT,
            onConfirm: noop,
            onChooseOther: noop,
          }
        : undefined,
      linkInvitation: options.linkInvite
        ? { eligibleLaterVisit: true, onLink: noop, onDismiss: noop }
        : undefined,
      sharing: { state: options.consent ?? "off", onChange: noop },
      setup: options.setup
        ? {
            title: "Turn on Still in Safari",
            detail:
              "Still works inside Safari. Your choices are saved and start working once it's on.",
            steps: SETUP_STEPS[platform],
            actionLabel:
              platform === "mac" ? "Open Safari Settings" : "Open Settings",
            onAction: noop,
          }
        : undefined,
      help: { onGuide: noop, onSupport: noop, onPrivacy: noop },
    } satisfies AppleSettingsProps,
  });
}

const iphone15 = (scale?: number): FrameSpec => ({
  kind: "device",
  device: "iphoneapp",
  w: 393,
  h: 852,
  safeTop: 59,
  safeBottom: 34,
  ...(scale ? { scale } : {}),
});
const base = { screen, component: "AppleSettings", textScale: 1 } as const;
const signedOut = [OWNER_SYNC_COPY];
const demoMark = REFERENCE_DEMO_ACCOUNT;

const cases: VisualCase[] = [
  {
    ...base,
    id: "d04-01",
    reference: "01-iphone-15-safari-extension-off-393-852.png",
    caption: "iPhone 15 · Safari extension off",
    theme: "light",
    width: 393,
    frame: iphone15(),
    render: settingsPage({ access: accessAll("locked"), setup: true }),
    callerCopy:
      "proves layout with the supplied setup copy (title, detail, steps from owner decision 3, button label), not production caller wiring",
    deviations: signedOut,
  },
  {
    ...base,
    id: "d04-02",
    reference: "02-iphone-15-pro-bought-link-invitation-393-852.png",
    caption: "iPhone 15 · Pro bought, link invitation",
    theme: "dark",
    width: 393,
    frame: iphone15(),
    render: settingsPage({
      access: accessAll("purchased"),
      pro: "owned",
      linkInvite: true,
      open: "youtube",
      values: { values: { yt_comments: true } },
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d04-03",
    reference: "03-iphone-15-waiting-for-apple-393-852.png",
    caption: "iPhone 15 · waiting for Apple",
    theme: "light",
    width: 393,
    frame: iphone15(),
    render: settingsPage({
      access: accessAll("locked"),
      offerState: "pending",
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d04-04",
    reference: "04-ipad-restore-couldn-t-finish-820-760.png",
    caption: "iPad · Restore couldn't finish",
    theme: "light",
    width: 820,
    frame: {
      kind: "device",
      device: "ipadapp",
      w: 820,
      h: 760,
      safeTop: 24,
      safeBottom: 20,
    },
    render: settingsPage({
      access: accessAll("locked"),
      restore: "failed",
      open: "instagram",
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d04-05",
    reference: "05-mac-still-pro-needs-verification-720-680.png",
    caption: "Mac · Still Pro needs verification",
    theme: "dark",
    width: 720,
    frame: { kind: "device", device: "mac", w: 720, h: 680, title: "Still" },
    render: settingsPage({
      platform: "mac",
      access: accessAll("verify"),
      pro: "verify",
      restore: "verify",
      open: "facebook",
      values: { values: { fb_stories: true } },
      consent: "on",
    }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d04-06",
    reference: "06-mac-keyboard-focus-on-the-still-switch-520-680.png",
    caption: "Mac · keyboard focus on the Still switch",
    theme: "light",
    width: 520,
    frame: {
      kind: "device",
      device: "mac",
      w: 520,
      h: 680,
      title: "Still",
      cls: "kbd-hero",
    },
    render: settingsPage({
      platform: "mac",
      access: accessAll("purchased"),
      pro: "owned",
      signedIn: true,
      sync: { tone: "success", text: "Settings synced." },
    }),
    focus: { selector: '.hero [role="switch"]' },
    deviations: [demoMark],
  },
  {
    ...base,
    id: "d04-07",
    reference: "07-link-confirm-account-393-852.png",
    caption: "Link · confirm account",
    theme: "light",
    width: 393,
    frame: iphone15(),
    render: settingsPage({
      access: accessAll("purchased"),
      pro: "owned",
      link: "confirm",
      signedIn: true,
    }),
    deviations: [demoMark],
  },
  {
    ...base,
    id: "d04-08",
    reference: "08-restore-nothing-found-393-852.png",
    caption: "Restore · nothing found",
    theme: "dark",
    width: 393,
    frame: iphone15(),
    render: settingsPage({ access: accessAll("locked"), restore: "nothing" }),
    deviations: signedOut,
  },
  {
    ...base,
    id: "d04-09",
    reference: "09-iphone-15-xxxlarge-393-852-text-1-35.png",
    caption: "iPhone 15 · xxxLarge",
    theme: "light",
    width: 393,
    textScale: 1.35,
    frame: iphone15(1.35),
    render: settingsPage({ access: accessAll("locked"), setup: true }),
    callerCopy:
      "proves layout with the supplied setup copy (title, detail, steps from owner decision 3, button label), not production caller wiring",
    deviations: signedOut,
  },
  {
    ...base,
    id: "d04-10",
    reference: "10-iphone-15-accessibility-size-393-852-text-2.png",
    caption: "iPhone 15 · accessibility size",
    theme: "dark",
    width: 393,
    textScale: 2,
    frame: iphone15(2),
    render: settingsPage({
      access: accessAll("purchased"),
      pro: "owned",
      open: "youtube",
    }),
    deviations: signedOut,
  },
];

export const D04: ScreenCases = {
  screen,
  page: "ui_kits/still-app/d04-apple-settings.html",
  cases,
};
