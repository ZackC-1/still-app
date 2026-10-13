import type {
  PopupInvitationPresentation,
  InvitationIntentPort,
} from "./invitation-presentation.js";
import type { Snippet } from "svelte";
import type { SiteAccessCardProps } from "./site-access-presentation.js";
import {
  FEATURE_REGISTRY,
  PAID_TIER_ENABLED,
  type FeatureId,
  type ServiceId,
  type SettingsV2,
  type BenefitAccessSnapshot,
} from "@still/shared-types";

/**
 * Owner decision 24: true while the Still Pro rows are dormant, that is, the compiled paid flag is
 * off and the trusted snapshot holds every Pro feature `unsupported` (the dormancy gate in
 * accessCapabilities keeps them there). Hosts then present each Pro row with the existing locked
 * design, a lock and "Still Pro", instead of the unsupported note, and the row offers nothing:
 * no purchase, price or app hand-off. Presentation only. The access states, saved choices and the
 * engine (which applies nothing) are unchanged, and every purchase entry still reads the real
 * states, so none of them appears. A paid-on host that cannot run a feature keeps the honest
 * unsupported note.
 */
export function proRowsDormant(
  access: BenefitAccessSnapshot,
  paidMode: boolean = PAID_TIER_ENABLED,
): boolean {
  return (
    !paidMode &&
    FEATURE_REGISTRY.every(
      (row) => row.tier !== "pro" || access.states[row.id] === "unsupported",
    )
  );
}

/**
 * True only when access is conclusively `locked`: some Still Pro row is locked and none is still
 * checking, needs verifying, purchased or protected. Every purchase entry (the popup's Still Pro
 * card, lock chips that lead to the offer, the settings Get Still Pro) reads this, so nothing asks
 * for money while Still is unsure, and a paid-off build (every Pro row `unsupported`) offers none.
 */
export function proKnownMissing(
  access: Pick<BenefitAccessSnapshot, "states">,
): boolean {
  const states = FEATURE_REGISTRY.filter((row) => row.tier === "pro").map(
    (row) => access.states[row.id],
  );
  return (
    states.includes("locked") &&
    !states.some((state) =>
      ["checking", "verification_required", "purchased", "protected"].includes(
        state,
      ),
    )
  );
}

/**
 * True while Still is still finding out whether this person has Still Pro: some Still Pro row is
 * `checking` and none is purchased or protected. The popup then shows "Checking your Still Pro
 * access…" in the Still Pro card's place, with no button (owner-approved design, state S1).
 */
export function proAccessChecking(
  access: Pick<BenefitAccessSnapshot, "states">,
): boolean {
  const states = FEATURE_REGISTRY.filter((row) => row.tier === "pro").map(
    (row) => access.states[row.id],
  );
  return (
    states.includes("checking") &&
    !states.some((state) => state === "purchased" || state === "protected")
  );
}

/**
 * The popup's Still Pro card line (ISS-0032, owner-approved design, 12 Oct 2026). The same words on
 * every popup. Owner rules: no number of extras and no price in the popup.
 */
export const POPUP_PRO_VALUE =
  "Hide more on Instagram, Facebook and YouTube. One-time purchase.";

/** Written as what each extra hides, for the settings Still Pro card's by-site list. */
const PRO_VALUE_PHRASES: Record<string, string> = {
  "instagram.stories": "Stories and Highlights",
  "instagram.explore": "Explore recommendations",
  "instagram.suggested": "suggested accounts",
  "instagram.threads": "Threads links",
  "facebook.stories": "Stories",
  "facebook.videos": "Videos and Watch",
  "facebook.sponsored": "desktop sidebar ads",
  "youtube.related": "Related videos",
  "youtube.endscreen": "end-of-video suggestions",
  "youtube.autoplay": "autoplay",
  "youtube.comments": "comments",
  "youtube.livechat": "live chat",
};

/**
 * Joins the phrases for one site. Three or more: "a, b and c", with a serial comma only where the
 * item before the final "and" itself contains "and" ("Stories, Videos and Watch, and desktop
 * sidebar ads"). Two: "a and b", or "a, plus b" where either already contains "and" (on a phone,
 * "Stories, plus Videos and Watch").
 */
function joinPhrases(items: readonly string[]): string {
  if (items.length < 2) return items.join("");
  const head = items.slice(0, -1);
  const last = items[items.length - 1]!;
  if (items.length === 2)
    return / and /.test(head[0]!) || / and /.test(last)
      ? `${head[0]}, plus ${last}`
      : `${head[0]} and ${last}`;
  const serial = / and /.test(head[head.length - 1]!);
  return `${head.join(", ")}${serial ? ", and " : " and "}${last}`;
}

/**
 * The settings Still Pro card's value list: per site (Instagram, Facebook, YouTube), what the extras
 * hide, limited to the rows this surface draws (a phone omits the desktop-layout extras). No counts.
 */
export function proValueBySite(
  features?: readonly FeatureId[],
): { service: ServiceId; site: string; what: string }[] {
  const sites = [
    ["instagram", "Instagram"],
    ["facebook", "Facebook"],
    ["youtube", "YouTube"],
  ] as const;
  return sites.flatMap(([service, site]) => {
    const phrases = rowsFor(service)
      .filter(
        (row) => row.tier === "pro" && (!features || features.includes(row.id)),
      )
      .map((row) => PRO_VALUE_PHRASES[row.id] ?? row.name);
    if (phrases.length === 0) return [];
    const what = joinPhrases(phrases);
    return [{ service, site, what: what[0]!.toUpperCase() + what.slice(1) }];
  });
}

/** Presentation labels/order only. Feature identity, defaults and tier remain registry-owned. */
export function rowsFor(service: ServiceId) {
  const rows = FEATURE_REGISTRY.filter((row) => row.service === service);
  if (service === "instagram") {
    const position = (row: (typeof rows)[number]) => {
      if (row.tier === "free") return 0;
      if (row.id === "instagram.stories") return 1;
      if (row.id === "instagram.explore") return 2;
      return FEATURE_REGISTRY.indexOf(row);
    };
    rows.sort((a, b) => position(a) - position(b));
  }
  return rows.map((row) => ({
    ...row,
    label:
      row.tier === "free"
        ? service === "youtube"
          ? "Shorts"
          : "Reels"
        : row.name,
  }));
}

export interface DesktopPopupProps {
  settings: SettingsV2;
  access: BenefitAccessSnapshot;
  browser: "Chrome" | "Firefox";
  onGlobalChange: (next: boolean) => void;
  onServiceChange: (service: ServiceId, next: boolean) => void;
  onFeatureChange: (feature: FeatureId, next: boolean) => void;
  onSignIn?: () => void;
  onSettings: () => void;
  /** Screen-reader name for the Settings button; unset keeps "Settings. Find Still in <browser>." */
  settingsLabel?: string;
  privacyUrl: string;
  /** Current committed authority can hold commands without changing saved choices. */
  commandsDisabled?: boolean;
  /** Existing host-owned account operations, rendered once in this sync card. */
  accountActions?: Snippet;
  /**
   * Navigation to the actual Still Pro destination (the browser Settings page's Still Pro card, or
   * the Still app on Safari). The popup's Get Still Pro and its feature locks both use it, only
   * while access is conclusively locked; the popup never starts a payment itself (ISS-0032).
   * The popup's Still Pro card also waits for a clear setup and account state (as the sync
   * invitation does) and for `proOfferReady`.
   */
  onSeePro?: () => void;
  /**
   * The host's Get Still Pro, lock and Sign in actions hand off to the Still app (Safari on Mac,
   * iPhone and iPad: Apple purchases and the account live in the app). The popup then says
   * "Opens the Still app" under Get Still Pro and under Sign in, and the locks say so to screen
   * readers. Presentation only: it adds no action the host did not supply.
   */
  appHandoff?: boolean;
  /**
   * False while the host knows its Still Pro destination would not offer Get Still Pro right now
   * (for example, a browser route where sales are not open). The popup's Still Pro card then stays
   * hidden, so it never leads to "can't be bought here"; the lock chips still open the destination.
   * Omitted: the destination decides (the Still app on Safari).
   */
  proOfferReady?: boolean;
  account?: {
    address?: string;
    status?: {
      tone: "pending" | "success" | "failed" | "caution" | "info";
      text: string;
      retry?: () => void;
    };
  };
  sectionMemory?: {
    read: () => ServiceId | null;
    write: (service: ServiceId | null) => void;
  };
  services?: readonly ServiceId[];
  features?: readonly FeatureId[];
  labels?: Partial<Record<FeatureId, string>>;
  heroTitle?: string;
  /** Caller-selected current invitation. Absent by default; never schedules itself. */
  invitation?: PopupInvitationPresentation;
  /** Approved D28 typography only; ordinary D01 presentation is unchanged. */
  invitationVariant?: "d28";
  /**
   * ISS-0037: the browser says Still cannot run on its four sites. Drawn at the top, above the
   * site list, with the host's request for the declared sites. Absent while access is granted or
   * unknown, and on hosts with no such check (Safari).
   */
  siteAccess?: SiteAccessCardProps;
  /** Caller owns setup wording and the current verified permission action. */
  desktopSetup?: {
    title: string;
    detail: string;
    actionLabel: string;
    action?: InvitationIntentPort;
  };
}
