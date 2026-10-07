// D03 extension settings: ui_kits/still-app/d03-settings.html + SettingsPage.babel.
import ExtensionSettings from "../../../../packages/core/src/ui/v3/ExtensionSettings.svelte";
import SyncCard from "../../../../packages/core/src/ui/v3/SyncCard.svelte";
import ProOfferCard from "../../../../packages/core/src/ui/v3/ProOfferCard.svelte";
import RestoreStatusCard from "../../../../packages/core/src/ui/v3/RestoreStatusCard.svelte";
import SharingCard from "../../../../packages/core/src/ui/v3/SharingCard.svelte";
import AccountLinkCard from "../../../../packages/core/src/ui/v3/AccountLinkCard.svelte";
import SettingsSiteList from "../../../../packages/core/src/ui/v3/SettingsSiteList.svelte";
import type { ExtensionSettingsProps } from "../../../../packages/core/src/ui/v3/extension-settings-presentation.js";
import type { ServiceId } from "@still/shared-types";
import { accessAll, noop, settingsFor } from "../fixtures.js";
import type { Deviation, Rendered, ScreenCases, VisualCase } from "../types.js";
import { OWNER_SYNC_COPY, REFERENCE_DEMO_ACCOUNT } from "./shared.js";

const screen = "d03-extension-settings";

// review.babel REVIEW_PURPOSES / SAMPLE_OFFER (bracketed placeholders are the reference's own).
const PURPOSES = [
  {
    name: "Email",
    text: "[Approved purpose text: how your email is used with your usage data]",
  },
  {
    name: "Usage analytics",
    text: "[Provider]: which settings are used, so they can be improved.",
  },
  { name: "AI processing", text: "[Provider]: [approved purpose text]" },
];
const SAMPLE_OFFER = {
  price: "$9.99",
  priceNote: "One payment. Access forever. No subscription",
};
const EMAIL = "sam@example.com";

type Consent = "unasked" | "on" | "off";
/**
 * SettingsPage.babel props, translated: signed out = Sign in only; signed in = address plus
 * Sign out / Delete account; Pro not owned = the browser offer with a ready channel and sample
 * offer (signed-out "Get Still Pro" signs in first); owned = combined "Still Pro and sync" card.
 * Consent unasked = combined card with the review purposes; answered = the sharing switch with
 * no purposes and the "Delete data you already shared" request, exactly as the page wires it.
 */
function settingsPage(options: {
  access: ReturnType<typeof accessAll>;
  open?: ServiceId;
  values?: Parameters<typeof settingsFor>[0];
  owned?: boolean;
  signedIn?: boolean;
  syncStatus?: { tone: "success"; text: string };
  consent?: Consent;
  setup?: boolean;
}): () => Rendered {
  return () => {
    const consent = options.consent ?? "unasked";
    const props: ExtensionSettingsProps = {
      settings: settingsFor(options.values),
      access: options.access,
      onGlobalChange: noop,
      onServiceChange: noop,
      onFeatureChange: noop,
      sectionMemory: { read: () => options.open ?? null, write: noop },
      sync: options.signedIn
        ? {
            account: {
              address: EMAIL,
              identity: "fixture-account",
              revision: 1,
              confirmed: true,
              status: options.syncStatus,
              onSignOut: noop,
              onDeleteAccount: noop,
            },
          }
        : { onSignIn: noop },
      pro: options.owned
        ? { ownership: "owned", channel: "ready", offer: SAMPLE_OFFER }
        : {
            ownership: "none",
            channel: "ready",
            offer: SAMPLE_OFFER,
            onSignIn: noop,
            onBuy: noop,
            onRestore: noop,
          },
      sharing:
        consent === "unasked"
          ? {
              state: "unasked",
              purposes: PURPOSES,
              purposesVerified: true,
              onShare: noop,
              onDecline: noop,
            }
          : // SharingSetting on the page receives no purposes, only onRequestDeletion.
            { state: consent, onChange: noop, onRequestDeletion: noop },
      setup: options.setup
        ? {
            detail:
              "Allow Still on YouTube, Instagram, Facebook and TikTok in Chrome so it can remove short-form video there.",
            onAction: noop,
          }
        : undefined,
      help: { onGuide: noop, onSupport: noop, onPrivacy: noop },
    };
    return { component: ExtensionSettings, props: { ...props } };
  };
}

const tab = (
  w: number,
  h: number,
  extra: { scale?: number; cls?: string } = {},
) =>
  ({
    kind: "device",
    device: "tab",
    w,
    h,
    url: "Still · Settings",
    ...extra,
  }) as const;

const base = { screen, component: "ExtensionSettings", textScale: 1 } as const;

/**
 * SharingCard holds (greys) its switch until approved purposes are supplied as verified props;
 * the reference SharingSetting has no purposes concept and draws the switch enabled.
 */
const HELD_SHARING_SWITCH: Deviation = {
  reason:
    "sharing switch held (greyed) without supplied purposes; the reference draws it enabled",
  selector: '[aria-labelledby="share-t"]',
};

const cases: VisualCase[] = [
  {
    ...base,
    id: "d03-01",
    reference: "01-signed-out-pro-not-owned-consent-not-asked-560-1180.png",
    caption: "Signed out · Pro not owned · consent not asked",
    theme: "light",
    width: 560,
    frame: tab(560, 1180),
    render: settingsPage({ access: accessAll("locked"), open: "youtube" }),
    deviations: [OWNER_SYNC_COPY],
  },
  {
    ...base,
    id: "d03-02",
    reference: "02-signed-in-pro-purchased-sharing-on-560-1180.png",
    caption: "Signed in · Pro purchased · sharing on",
    theme: "dark",
    width: 560,
    frame: tab(560, 1180),
    render: settingsPage({
      access: accessAll("purchased"),
      owned: true,
      signedIn: true,
      syncStatus: { tone: "success", text: "Settings synced." },
      consent: "on",
      open: "instagram",
      values: { values: { ig_stories: true } },
    }),
    deviations: [REFERENCE_DEMO_ACCOUNT],
  },
  {
    ...base,
    id: "d03-11",
    reference: "11-permission-needed-560-720.png",
    caption: "Permission needed",
    theme: "light",
    width: 560,
    frame: tab(560, 720),
    render: settingsPage({
      access: accessAll("locked"),
      setup: true,
      consent: "off",
    }),
    deviations: [OWNER_SYNC_COPY],
  },
  {
    ...base,
    id: "d03-12",
    reference: "12-delete-account-dialog-560-720.png",
    caption: "Delete account dialog",
    theme: "dark",
    width: 560,
    frame: tab(560, 720),
    render: settingsPage({
      access: accessAll("purchased"),
      owned: true,
      signedIn: true,
      consent: "off",
    }),
    actions: [{ click: "button.link.danger" }],
    notes:
      "dialog opened with a real click on Delete account; latest reference includes a demonstration banner behind the scrim",
    deviations: [REFERENCE_DEMO_ACCOUNT],
  },
  {
    ...base,
    id: "d03-13",
    reference: "13-320-wide-1-5-text-320-900-text-1-5.png",
    caption: "320 wide · 1.5× text",
    theme: "light",
    width: 320,
    textScale: 1.5,
    frame: tab(320, 900, { scale: 1.5 }),
    render: settingsPage({
      access: accessAll("locked"),
      open: "facebook",
      consent: "off",
    }),
    deviations: [OWNER_SYNC_COPY],
  },
  {
    ...base,
    id: "d03-14",
    reference: "14-keyboard-focus-on-sign-in-560-900.png",
    caption: "Keyboard · focus on Sign in",
    theme: "dark",
    width: 560,
    frame: tab(560, 900, { cls: "kbd-signin" }),
    render: settingsPage({ access: accessAll("locked"), consent: "off" }),
    focus: {
      selector: "section.card:has(> h2.section-label) > button.primary.block",
    },
    deviations: [
      OWNER_SYNC_COPY,
      {
        reason:
          "reference review artefact: its simulated .kbd-signin outline rings every primary block button (Get Still Pro too); real Tab focus rings only Sign in",
        selector: ".card button.primary.block:not(:focus)",
        pad: 6,
      },
      HELD_SHARING_SWITCH,
    ],
  },
];

const CARD_CAPTIONS: Record<string, [string, string]> = {
  "03-sync-failed-retry.png": ["Sync failed · retry", "SyncCard"],
  "04-purchase-pending.png": ["Purchase pending", "ProOfferCard"],
  "05-restore-nothing-found-conclusive.png": [
    "Restore · nothing found (conclusive)",
    "RestoreStatusCard",
  ],
  "06-restore-couldn-t-finish.png": [
    "Restore · couldn't finish",
    "RestoreStatusCard",
  ],
  "07-checking-access.png": ["Checking access", "ProOfferCard"],
  "08-sharing-off-deletion-requested.png": [
    "Sharing off · deletion requested",
    "SharingCard",
  ],
  "09-linking-a-purchase-confirm-account.png": [
    "Linking a purchase · confirm account",
    "AccountLinkCard",
  ],
  "10-still-off-choices-kept.png": [
    "Still off · choices kept",
    "SettingsSiteList",
  ],
};

/** SettingsPage.babel `Card` panes: one card rendered alone in a 432-wide panel. */
const CARD_RENDERS: Record<
  string,
  { theme: "light" | "dark"; render: () => Rendered }
> = {
  "03-sync-failed-retry.png": {
    theme: "light",
    render: () => ({
      component: SyncCard,
      props: {
        account: {
          address: EMAIL,
          confirmed: true,
          status: {
            tone: "failed",
            text: "Sync didn't finish.",
            detail: "Your settings are saved on this device.",
            actionLabel: "Try again",
            onAction: noop,
          },
        },
      },
    }),
  },
  "04-purchase-pending.png": {
    theme: "dark",
    render: () => ({
      component: ProOfferCard,
      props: {
        ownership: "none",
        channel: "ready",
        offer: SAMPLE_OFFER,
        confirmedAccount: true,
        knownMissing: true,
        state: "pending",
        onBuy: noop,
        onRestore: noop,
      },
    }),
  },
  "05-restore-nothing-found-conclusive.png": {
    theme: "light",
    render: () => ({
      component: RestoreStatusCard,
      props: { state: "nothing" },
    }),
  },
  "06-restore-couldn-t-finish.png": {
    theme: "dark",
    render: () => ({
      component: RestoreStatusCard,
      props: { state: "failed", onAction: noop },
    }),
  },
  "07-checking-access.png": {
    theme: "light",
    render: () => ({
      component: ProOfferCard,
      props: {
        ownership: "checking",
        channel: "ready",
        confirmedAccount: false,
        knownMissing: false,
      },
    }),
  },
  "08-sharing-off-deletion-requested.png": {
    theme: "dark",
    render: () => ({
      component: SharingCard,
      props: { state: "off", withdrawal: "requested", onChange: noop },
    }),
  },
  "09-linking-a-purchase-confirm-account.png": {
    theme: "light",
    render: () => ({
      component: AccountLinkCard,
      props: {
        state: "confirm",
        email: EMAIL,
        onConfirm: noop,
        onChooseOther: noop,
      },
    }),
  },
  "10-still-off-choices-kept.png": {
    theme: "dark",
    render: () => ({
      component: SettingsSiteList,
      props: {
        settings: settingsFor({ on: false, values: { yt_comments: true } }),
        access: accessAll("purchased"),
        services: ["youtube"],
        sectionMemory: { read: () => "youtube", write: noop },
        onServiceChange: noop,
        onFeatureChange: noop,
      },
    }),
  },
};

const CARD_DEVIATIONS: Record<string, Deviation[]> = {
  "08-sharing-off-deletion-requested.png": [HELD_SHARING_SWITCH],
};
// Measured 2026-10-05: supplying the owner-approved purposes (owner decision 8) as verified props
// enables the switch but also draws the purpose list, which the reference frame has no place for.
// The reference state is "no purposes shown", so the fixture keeps purposes absent.
const CARD_NOTES: Record<string, string> = {
  "08-sharing-off-deletion-requested.png":
    "reference state shows no purpose list; with the owner-approved purposes supplied the card grows to 480 device px tall against the reference's 292, so purposes stay absent",
};

cases.push(
  ...Object.entries(CARD_RENDERS).map(
    ([reference, { theme, render }]): VisualCase => {
      const [caption, component] = CARD_CAPTIONS[reference]!;
      return {
        screen,
        id: `d03-${reference.slice(0, 2)}`,
        reference,
        caption,
        component,
        theme,
        width: 432,
        textScale: 1,
        frame: { kind: "card", w: 432 },
        render,
        notes: CARD_NOTES[reference],
        deviations: CARD_DEVIATIONS[reference],
      };
    },
  ),
);
cases.sort((a, b) => a.id.localeCompare(b.id));

export const D03: ScreenCases = {
  screen,
  page: "ui_kits/still-app/d03-settings.html",
  cases,
};
