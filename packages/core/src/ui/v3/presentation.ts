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
 * True only while Still Pro is verified as purchased (ISS-0073): some Still Pro row is `purchased`
 * and none is still `checking` or `verification_required`. The sync card's account row then shows
 * the small "Still Pro" tag on every popup and settings surface. Frozen released-free protection
 * (`protected` alone), a check in progress, a locked offer and a paid-off build show none. Hosts
 * pass the real snapshot, never the offer latch's.
 */
export function proPurchased(
  access: Pick<BenefitAccessSnapshot, "states">,
): boolean {
  const states = FEATURE_REGISTRY.filter((row) => row.tier === "pro").map(
    (row) => access.states[row.id],
  );
  return (
    states.includes("purchased") &&
    !states.some(
      (state) => state === "checking" || state === "verification_required",
    )
  );
}

/** Which Still Pro tag the "Settings sync" heading carries (ISS-0105): "account" ("Still Pro User")
 * only when the signed-in account itself holds Still Pro, "device" ("Still Pro on this device")
 * when Still Pro is purchased but signed out or not held by the signed-in account. */
export type StillProTagKind = "account" | "device";

/** Undefined while Still Pro is not verified as purchased (no tag). `accountHoldsPro` is the host's
 * answer for the signed-in account; signed out it is never the account's. */
export function stillProTag(
  access: Pick<BenefitAccessSnapshot, "states">,
  account: { readonly holdsPro?: boolean } | undefined,
): StillProTagKind | undefined {
  if (!proPurchased(access)) return undefined;
  return account?.holdsPro === true ? "account" : "device";
}

/**
 * The access a Still Pro offer surface draws from (ISS-0032, reopened 15 Oct 2026). Once this view
 * has seen Still Pro conclusively missing (proKnownMissing), a later hold is Still re-confirming the
 * same answer, not a new one: the access cache holds Pro rows as `checking` or
 * `verification_required` whenever the account's access record changes, a freshness deadline passes
 * or one read fails, which happens during an ordinary sync or setting change. Shown raw, that hold
 * made the Still Pro card and every lock chip vanish until the popup was reopened.
 *
 * While latched, held Pro rows are drawn `locked`, so the card and the chips stay; other states
 * (free, unsupported) are drawn as they are. Any Pro row purchased or protected (verified
 * ownership) ends the latch at once and the real snapshot is drawn again; so does another account
 * (the host passes the account it shows). Display only: a locked row has no switch, so a hold can
 * never make a Pro row usable, and commands keep validating against the binding's own snapshot.
 * Purchase entries that take money must read the real snapshot instead. One latch per mounted
 * view; it never outlives the view.
 */
export function createProOfferLatch(): (
  access: BenefitAccessSnapshot,
  account?: string | null,
) => BenefitAccessSnapshot {
  let latched = false;
  let latchedFor: string | null = null;
  return (access, account = null) => {
    const pro = FEATURE_REGISTRY.filter((row) => row.tier === "pro");
    const ended = pro.some((row) =>
      ["purchased", "protected"].includes(access.states[row.id]),
    );
    // Another account (signing in or out, or a switch) is a new answer, never a re-check.
    if (ended || account !== latchedFor) latched = false;
    latchedFor = account;
    if (!ended && proKnownMissing(access)) latched = true;
    if (!latched) return access;
    const held = (state: string) =>
      state === "checking" || state === "verification_required";
    if (!pro.some((row) => held(access.states[row.id]))) return access;
    const states = { ...access.states };
    for (const row of pro) if (held(states[row.id])) states[row.id] = "locked";
    return { ...access, states };
  };
}

/**
 * The popup's Still Pro card line (ISS-0032, owner-approved design, 12 Oct 2026). The same words on
 * every popup. Owner rules: no number of extras and no price in the popup. Wording from the owner's
 * canvas review, 21 Oct 2026.
 */
export const POPUP_PRO_VALUE =
  "Even fewer distractions on Instagram, Facebook and YouTube. One-time purchase.";

/** Written as what each extra hides, for the settings Still Pro card's by-site list. */
const PRO_VALUE_PHRASES: Record<string, string> = {
  "instagram.stories": "Stories and Highlights",
  "instagram.explore": "Explore recommendations",
  "instagram.suggested": "suggested accounts",
  "instagram.threads": "Threads links",
  "facebook.stories": "Stories",
  "facebook.videos": "the Video tab",
  "facebook.sponsored": "desktop sidebar ads",
  "youtube.related": "Related videos",
  "youtube.endscreen": "end-of-video suggestions",
  "youtube.autoplay": "autoplay",
  "youtube.comments": "comments",
  "youtube.livechat": "live chat",
};

/**
 * Joins the phrases for one site. Three or more: "a, b and c" ("Stories, the Video tab and desktop
 * sidebar ads"), never with a serial comma (owner house rule, 22 Oct 2026). Two: "a and b" (on a
 * phone, "Stories and the Video tab"), or "a, plus b" where either already contains "and".
 */
function joinPhrases(items: readonly string[]): string {
  if (items.length < 2) return items.join("");
  const head = items.slice(0, -1);
  const last = items[items.length - 1]!;
  if (items.length === 2)
    return / and /.test(head[0]!) || / and /.test(last)
      ? `${head[0]}, plus ${last}`
      : `${head[0]} and ${last}`;
  return `${head.join(", ")} and ${last}`;
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
  /** Screen-reader name for the Settings button; unset keeps "Still settings". */
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
    /** ISS-0105: true only when this signed-in account itself holds Still Pro (the host knows its
     * source). Absent or false, a purchased Still Pro is this device's: "Still Pro on this device". */
    holdsPro?: boolean;
    /** Last successful cloud exchange, not proof that every device received the settings. */
    lastSyncedAt?: number | null;
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
