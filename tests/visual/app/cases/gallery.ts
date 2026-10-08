// All latest System Gallery specimens. Production components are measured inside review-only
// compositions; caller observations are fixture data and prove no backend/native authority.
import TikTokBlocked from "../../../../packages/core/src/ui/v3/TikTokBlocked.svelte";
import type {
  TikTokActionPort,
  TikTokBlockedPresentation,
} from "../../../../packages/core/src/ui/v3/tiktok-blocked-presentation.js";
import DesktopPopup from "../../../../packages/core/src/ui/v3/DesktopPopup.svelte";
import MobilePopup from "../../../../packages/core/src/ui/v3/MobilePopup.svelte";
import ExtensionSettings from "../../../../packages/core/src/ui/v3/ExtensionSettings.svelte";
import GallerySpecimen from "../GallerySpecimen.svelte";
import OwnerAllowanceSpecimen from "../OwnerAllowanceSpecimen.svelte";
import type { DesktopPopupProps } from "../../../../packages/core/src/ui/v3/presentation.js";
import type { MobilePopupProps } from "../../../../packages/core/src/ui/v3/mobile-presentation.js";
import type { ExtensionSettingsProps } from "../../../../packages/core/src/ui/v3/extension-settings-presentation.js";
import { accessAll, noop, settingsFor } from "../fixtures.js";
import { OWNER_SYNC_COPY, REFERENCE_DEMO_ACCOUNT } from "./shared.js";
import type { ScreenCases, VisualCase } from "../types.js";

const screen = "system-gallery";

/**
 * A current, verified caller observation with every action port ready, so nothing renders
 * held. These are fixture bindings only; they prove no native tab allowance.
 */
function presentation(
  host: TikTokBlockedPresentation["host"],
  state: TikTokBlockedPresentation["state"],
): TikTokBlockedPresentation {
  const identity = {
    request: "visual-request",
    tab: "visual-tab",
    document: "visual-document",
  };
  const binding = {
    identity,
    observation: "visual-observation",
    verified: true,
    fresh: true,
  };
  const port = (): TikTokActionPort => ({
    ...binding,
    identity: { ...identity },
    status: "ready",
    request: noop,
  });
  return {
    ...binding,
    host,
    state,
    capability: { ...binding, identity: { ...identity }, status: "supported" },
    requestConfirmation: port(),
    confirmOpen: port(),
    cancel: port(),
    settings: port(),
    reload: port(),
    outcome:
      state === "reload"
        ? {
            ...binding,
            identity: { ...identity },
            status: "granted-reload-needed",
            destinationValidated: true,
          }
        : undefined,
  };
}

const base = {
  screen,
  component: "TikTokBlocked",
  width: 300,
  textScale: 1,
  frame: { kind: "gallery", width: 300, height: 420 },
} as const;

const tiktokCases: VisualCase[] = [
  {
    ...base,
    id: "d29-28",
    reference: "28-browser.png",
    caption: "Browser",
    theme: "light",
    render: () => ({
      component: TikTokBlocked,
      props: { presentation: presentation("browser", "blocked") },
    }),
  },
  {
    ...base,
    id: "d29-29",
    reference: "29-confirmation.png",
    caption: "Confirmation",
    theme: "dark",
    render: () => ({
      component: TikTokBlocked,
      props: { presentation: presentation("browser", "confirmation") },
    }),
  },
  {
    ...base,
    id: "d29-30",
    reference: "30-iphone-safari-reload-needed.png",
    caption: "iPhone Safari · reload needed",
    theme: "light",
    render: () => ({
      component: TikTokBlocked,
      props: { presentation: presentation("ios", "reload") },
    }),
  },
];

const fixtureNote =
  "Component specimen with inert callbacks and caller-supplied observations; layout only, not a verified account, grant, purchase, deletion or native/provider journey.";

function specimen(
  index: number,
  reference: string,
  caption: string,
  width: number,
  theme: "light" | "dark",
  component: string,
  render: VisualCase["render"],
  extra: Partial<VisualCase> = {},
): VisualCase {
  return {
    id: `gallery-${String(index).padStart(2, "0")}`,
    screen,
    reference,
    caption,
    component,
    width,
    theme,
    textScale: 1,
    frame: { kind: "gallery", width },
    render,
    notes: fixtureNote,
    ...extra,
  };
}
function sample(props: Record<string, unknown>) {
  return () => ({ component: GallerySpecimen, props });
}
function popup(paused = false, purchased = true) {
  return () => ({
    component: DesktopPopup,
    props: {
      settings: settingsFor({
        on: !paused,
        values: { yt_comments: purchased, yt_autoplay: purchased && !paused },
      }),
      access: accessAll(purchased ? "purchased" : "locked"),
      browser: "Chrome",
      privacyUrl: "#",
      onGlobalChange: noop,
      onServiceChange: noop,
      onFeatureChange: noop,
      onSignIn: noop,
      onSettings: noop,
      onPurchase: purchased ? undefined : noop,
      onSeePro: noop,
      sectionMemory: {
        read: () => (purchased ? "youtube" : null),
        write: noop,
      },
    } satisfies DesktopPopupProps,
  });
}
function safari() {
  return {
    component: MobilePopup,
    props: {
      settings: settingsFor(),
      access: accessAll("locked"),
      host: "safari",
      privacyUrl: "#",
      onGlobalChange: noop,
      onServiceChange: noop,
      onFeatureChange: noop,
      onSignIn: noop,
      onSettings: noop,
      onSeePro: noop,
      sectionMemory: { read: () => "facebook", write: noop },
    } satisfies MobilePopupProps,
  };
}
function settings() {
  return {
    component: ExtensionSettings,
    props: {
      settings: settingsFor({
        values: { yt_comments: true, ig_explore: true, ig_stories: true },
      }),
      access: accessAll("locked", {
        ig_explore: "unsupported",
        ig_stories: "checking",
        ig_suggested: "verify",
      }),
      sectionMemory: { read: () => "instagram", write: noop },
      onGlobalChange: noop,
      onServiceChange: noop,
      onFeatureChange: noop,
      sync: {
        account: {
          address: "sam@example.com",
          identity: "specimen-account",
          revision: 1,
          confirmed: true,
          onSignOut: noop,
          onDeleteAccount: noop,
        },
      },
      pro: {
        ownership: "none",
        channel: "ready",
        offer: {
          price: "$9.99",
          priceNote: "One payment. Access forever. No subscription",
        },
        onBuy: noop,
        onSignIn: noop,
        onRestore: noop,
      },
      sharing: { state: "off", onChange: noop, onRequestDeletion: noop },
      help: { onPrivacy: noop, onGuide: noop, onSupport: noop },
    } satisfies ExtensionSettingsProps,
  };
}
const ownerNote = `${fixtureNote} Existing private OwnerAllowances retains its truthful no-approved-builds warning and reports no live surfaces. Local draft clicks do not Apply or write policy.`;
const safariNote = `${fixtureNote} Reference composes a standalone Safari offer that has no merged standalone Svelte equivalent; this case measures the actual existing Safari MobilePopup and records its raw layout difference. Native app handoff acceptance remains required.`;
const offerNote = `${fixtureNote} Production ProOfferCard with the registry-owned twelve-control specimen list. Failed purchases keep acquisition held; the reference's failed-state Buy/price differ from the approved guards and checkout-only pricing.`;

const cases: VisualCase[] = [
  specimen(1, "01-light.png", "Light", 380, "light", "DesktopPopup", popup(), {
    deviations: [OWNER_SYNC_COPY],
  }),
  specimen(2, "02-dark.png", "Dark", 380, "dark", "DesktopPopup", popup(), {
    deviations: [OWNER_SYNC_COPY],
  }),
  specimen(
    3,
    "03-global-off-choices-kept.png",
    "Global Off · choices kept",
    380,
    "light",
    "DesktopPopup",
    popup(true),
    { deviations: [OWNER_SYNC_COPY] },
  ),
  specimen(
    4,
    "04-pro-not-owned-purchase-cta.png",
    "Pro not owned · Purchase CTA",
    380,
    "light",
    "DesktopPopup",
    popup(false, false),
    { deviations: [OWNER_SYNC_COPY] },
  ),
  specimen(
    5,
    "05-safari-popup-pro-not-owned.png",
    "Safari popup · Pro not owned",
    380,
    "dark",
    "MobilePopup (Safari)",
    safari,
    {
      deviations: [OWNER_SYNC_COPY],
      notes: `${fixtureNote} Actual Safari popup shell differs from reference compact desktop-style composition.`,
    },
  ),
  specimen(
    6,
    "06-light.png",
    "Light",
    432,
    "light",
    "ExtensionSettings",
    settings,
    {
      deviations: [REFERENCE_DEMO_ACCOUNT],
      notes: `${fixtureNote} Actual settings card order/help remain; reference Gallery SettingsSpec omits Help and reorders cards.`,
    },
  ),
  specimen(
    7,
    "07-dark.png",
    "Dark",
    432,
    "dark",
    "ExtensionSettings",
    settings,
    {
      deviations: [REFERENCE_DEMO_ACCOUNT],
      notes: `${fixtureNote} Actual settings card order/help remain; reference Gallery SettingsSpec omits Help and reorders cards.`,
    },
  ),
  specimen(
    8,
    "08-light.png",
    "Light",
    420,
    "light",
    "FeatureRow access states",
    sample({ kind: "access" }),
  ),
  specimen(
    9,
    "09-dark.png",
    "Dark",
    420,
    "dark",
    "FeatureRow access states",
    sample({ kind: "access" }),
  ),
  specimen(
    10,
    "10-light.png",
    "Light",
    400,
    "light",
    "SharingCard consent",
    sample({ kind: "consent" }),
    {
      callerCopy:
        "Reference bracketed purposes, not an approved provider configuration.",
    },
  ),
  specimen(
    11,
    "11-dark.png",
    "Dark",
    400,
    "dark",
    "SharingCard consent",
    sample({ kind: "consent" }),
    {
      callerCopy:
        "Reference bracketed purposes, not an approved provider configuration.",
    },
  ),
  ...(["requested", "verifying", "deleted", "failed"] as const).map(
    (withdrawal, i) =>
      specimen(
        12 + i,
        `${12 + i}-withdrawal-${withdrawal}.png`,
        `Withdrawal · ${withdrawal}`,
        290,
        "light",
        "SharingCard withdrawal",
        sample({ kind: "withdrawal", withdrawal }),
      ),
  ),
  specimen(
    16,
    "16-browser-failed.png",
    "Browser · failed",
    300,
    "light",
    "ProOfferCard failed",
    sample({
      kind: "offer",
      signedIn: true,
      offerState: "failed",
      showControls: true,
    }),
    { notes: offerNote },
  ),
  specimen(
    17,
    "17-browser-signed-out.png",
    "Browser · signed out",
    300,
    "dark",
    "ProOfferCard signed out",
    sample({ kind: "offer" }),
  ),
  specimen(
    18,
    "18-channel-unverified.png",
    "Channel unverified",
    300,
    "light",
    "ProOfferCard channel unverified",
    sample({ kind: "offer", signedIn: true, channel: "unverified" }),
  ),
  specimen(
    19,
    "19-safari-popup.png",
    "Safari popup",
    300,
    "dark",
    "MobilePopup (Safari; standalone offer absent)",
    safari,
    { notes: safariNote },
  ),
  specimen(
    20,
    "20-apple-host-waiting-for-storekit.png",
    "Apple host · waiting for StoreKit",
    300,
    "light",
    "NativeProOfferCard pending",
    sample({ kind: "native-offer" }),
    {
      notes: `${fixtureNote} Existing Svelte pending presentation only; actual native StoreKit purchase/review UI is not drawn or proved.`,
    },
  ),
  specimen(
    21,
    "21-checking-rights.png",
    "Checking rights",
    300,
    "light",
    "ProOfferCard checking",
    sample({ kind: "checking" }),
  ),
  specimen(
    22,
    "22-restore-outcomes.png",
    "Restore outcomes",
    460,
    "light",
    "RestoreStatusCard outcomes",
    sample({ kind: "restore" }),
  ),
  specimen(
    23,
    "23-linking-confirm-failed.png",
    "Linking · confirm, failed",
    300,
    "dark",
    "AccountLinkCard",
    sample({ kind: "link" }),
  ),
  specimen(
    24,
    "24-light.png",
    "Light",
    380,
    "light",
    "PopupInvitation specimens",
    sample({ kind: "invitations" }),
  ),
  specimen(
    25,
    "25-dark.png",
    "Dark",
    380,
    "dark",
    "PopupInvitation specimens",
    sample({ kind: "invitations" }),
  ),
  specimen(
    26,
    "26-draft-idle.png",
    "Draft · idle",
    400,
    "light",
    "OwnerAllowances",
    () => ({ component: OwnerAllowanceSpecimen, props: {} }),
    { notes: ownerNote },
  ),
  specimen(
    27,
    "27-stale.png",
    "Stale",
    400,
    "dark",
    "OwnerAllowances",
    () => ({ component: OwnerAllowanceSpecimen, props: { stale: true } }),
    {
      notes: ownerNote,
      actions: [
        { click: '[aria-labelledby="al-global"]' },
        { click: '[aria-labelledby="al-firefox_desktop"]' },
      ],
    },
  ),
  ...tiktokCases.map((c) => ({ ...c, notes: fixtureNote })),
  specimen(
    31,
    "31-focus.png",
    "Focus",
    320,
    "light",
    "Toggle and production button styles",
    sample({ kind: "focus" }),
    {
      focus: { selector: ".gallery-focus .toggle" },
      notes: `${fixtureNote} Real Tab focus on the first switch. The reference draws simultaneous simulated rings on several controls; no additional focus ring is fabricated.`,
    },
  ),
  specimen(
    32,
    "32-150-text-text-scale-320-wide.png",
    "150% text (--text-scale) · 320 wide",
    320,
    "dark",
    "FeatureRow 150% text",
    sample({ kind: "large-text", scale: 1.5 }),
    { textScale: 1.5 },
  ),
  specimen(
    33,
    "33-long-text.png",
    "Long text",
    320,
    "light",
    "FeatureRow + StatusLine long text",
    sample({ kind: "long-text" }),
    {
      callerCopy:
        "Reference German-length label, description and failed status text; presentation specimen only.",
    },
  ),
];

export const GALLERY: ScreenCases = {
  screen,
  page: "gallery/index.html",
  cases,
};
