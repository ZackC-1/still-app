import type { StoredSettingsRecord } from "@still/core/storage";
import type { BenefitAccessSnapshot } from "@still/shared-types";

// Pure rules for the Safari extension's V3 popup and settings page. The entrypoints and their host
// components only plumb these values; every decision that could present a saved choice, an account
// action or a surface lives here and is unit-tested in a node environment.
//
// Keep this module free of top-level side effects and of Svelte imports: the entrypoints reach it
// only through a dynamic import that default builds fold away, so default bundles stay
// byte-identical to the legacy build.

export interface SafariV3BuildInput {
  /** VITE_APPLE_ATOMIC_SETTINGS: the same explicit developer opt-in the Apple app uses. */
  readonly atomicSettingsFlag: string | undefined;
  /** VITE_MODERN_SETTINGS_SYNC_ENABLED: the modern sync flag the Apple app and Chromium share. */
  readonly modernSyncFlag: string | undefined;
  readonly supabaseUrl: string | undefined;
  readonly supabaseAnonKey: string | undefined;
}

/**
 * The V3 screens are compiled in only when a build opts in exactly as the Apple app's D04 screen
 * does (selectAppleSettingsMode; both values non-empty means configured):
 *  - configured with the modern sync flag exactly "true" (the app's atomic-cloud mode), or
 *  - not configured with VITE_APPLE_ATOMIC_SETTINGS exactly "true" (the app's atomic-local mode).
 * Anything else keeps the legacy screens. The app's native-port condition has no equivalent here;
 * the runtime record check below is the extension's equivalent of "the Apple app is in atomic mode
 * on this device". The Apple app owns the account in both modes (see appManagedPopupAccount).
 */
export function selectSafariV3Build(input: SafariV3BuildInput): boolean {
  const configured = Boolean(input.supabaseUrl && input.supabaseAnonKey);
  return configured ? input.modernSyncFlag === "true" : input.atomicSettingsFlag === "true";
}

/**
 * V3 only when the saved record is the atomic (modern, committed) record the Apple app writes in
 * its atomic mode. A legacy record, nothing saved, or a failed read with no atomic copy in browser
 * storage keeps today's legacy screens, which work against either record shape. The extension
 * never converts the record itself: that one-way change belongs to the app.
 */
export function savedRecordIsAtomic(record: StoredSettingsRecord | null | undefined): boolean {
  return Boolean(record?.atomic);
}

export type SafariPopupSurface = "desktop" | "mobile";

/** macOS gets the desktop popup; iOS, iPadOS and anything unknown get the mobile popup, which fits
 * every width. */
export function safariPopupSurface(os: string | undefined): SafariPopupSurface {
  return os === "mac" ? "desktop" : "mobile";
}

/** Screens at or under this width (portrait points) are phones; the smallest iPad is 744 wide. */
export const SAFARI_PHONE_MAX_SCREEN_WIDTH = 600;

/**
 * Whether the popup fills the width Safari gives it (owner D02: the iPhone sheet is edge to edge).
 * Only the iPhone extension sheet qualifies: Safari sizes that sheet to the screen, never from the
 * popup's content, so taking its width cannot feed back into it. The Mac and iPad popovers size
 * themselves FROM the content, so they keep the fixed 380px width; a width taken from their own
 * viewport would be circular and could collapse or run away (the 2026-07 "sliver" bug). The answer
 * reads the device screen, which a popover's measuring pass does not change. Unknown or missing
 * screen sizes keep the fixed width.
 */
export function safariPopupFillsSheet(surface: SafariPopupSurface, screenWidth: number | undefined): boolean {
  return (
    surface === "mobile" &&
    typeof screenWidth === "number" &&
    Number.isFinite(screenWidth) &&
    screenWidth > 0 &&
    screenWidth <= SAFARI_PHONE_MAX_SCREEN_WIDTH
  );
}

/**
 * The browser value DesktopPopup requires (it accepts only the D01 reference values). It no longer
 * reaches the Settings button's accessible name: the macOS Safari popup passes
 * SAFARI_SETTINGS_LABEL instead.
 */
export const SAFARI_DESKTOP_POPUP_BROWSER = "Chrome" as const;

/** The macOS Safari popup's Settings button screen-reader label (owner decision 27). */
export const SAFARI_SETTINGS_LABEL = "Still settings";

/** The account fields the extension shows; the Apple app is the account authority on Safari. */
export interface AppManagedAccountSource {
  readonly userId: string | null;
  readonly accountEmail: string | null;
  readonly cloudReachable: boolean;
  readonly pendingUpload: boolean;
  readonly lastSyncedAt: number | null;
  readonly accountRevision: number;
}

export interface AccountStatusText {
  readonly unreachable: string;
  readonly syncing: string;
  readonly synced: string;
  readonly checking: string;
}

export interface PopupAccountDisplay {
  readonly address?: string;
  /** ISS-0105: this signed-in account itself holds Still Pro (see `accountHoldsPro`). */
  readonly holdsPro: boolean;
  /**
   * The app's last successful cloud exchange (ms), read from the account status the Still app
   * writes to the shared App Group (getAccountSyncStatus). The shared popup shows it on the
   * synced line, "Synced · Today at 2:10 PM", as the app itself does (owner, 19 Oct).
   */
  readonly lastSyncedAt: number | null;
  readonly status: { readonly tone: "pending" | "success" | "failed"; readonly text: string };
}

/**
 * ISS-0105 (owner, 22 Oct): whether the signed-in account itself holds Still Pro, from native's
 * benefit snapshot only. StillKit sets `accountHoldsPro` from the same conditions as the Apple app's
 * own `readAccountHeldPro` (a verified account proof for the account the app shows, in its current
 * session), never from this device's purchase. Absent (an older app, or no answer yet) is false, so
 * a purchased Still Pro reads "Still Pro on this device". Display only: it unlocks nothing.
 */
function accountHoldsPro(access: Pick<BenefitAccessSnapshot, "accountHoldsPro"> | undefined): boolean {
  return access?.accountHoldsPro === true;
}

function statusFor(source: AppManagedAccountSource, text: AccountStatusText): PopupAccountDisplay["status"] {
  if (!source.cloudReachable) return { tone: "failed", text: text.unreachable };
  if (source.pendingUpload) return { tone: "pending", text: text.syncing };
  if (source.lastSyncedAt !== null) return { tone: "success", text: text.synced };
  return { tone: "pending", text: text.checking };
}

/**
 * Popup account display. Read-only by construction: the Apple app owns sign-in, sign-out, account
 * deletion and sync retry on Safari, so no action callback is ever produced here. Signed out is
 * `undefined`: the popup's own signed-out line, whose Sign in hands off to the Still app
 * (lib/app-handoff) rather than signing in here.
 *
 * ISS-0105 (owner, 22 Oct): `holdsPro` comes only from native's benefit snapshot
 * (`accountHoldsPro`, see below), so the tag reads "Still Pro User" exactly when the Apple app
 * would, and "Still Pro on this device" otherwise.
 */
export function appManagedPopupAccount(
  source: AppManagedAccountSource,
  text: AccountStatusText,
  access?: Pick<BenefitAccessSnapshot, "accountHoldsPro">,
): PopupAccountDisplay | undefined {
  if (!source.userId) return undefined;
  return {
    address: source.accountEmail ?? undefined,
    holdsPro: accountHoldsPro(access),
    lastSyncedAt: source.lastSyncedAt,
    status: statusFor(source, text),
  };
}

export interface SettingsSyncDisplay {
  readonly account?: {
    readonly address?: string;
    readonly identity?: string;
    readonly revision?: number;
    readonly confirmed: false;
    /** ISS-0105: as on the popup, from native's snapshot only. */
    readonly holdsPro?: boolean;
    readonly lastSyncedAt?: number | null;
    readonly status?: PopupAccountDisplay["status"];
  };
  /** Signed out only: opens the Still app's sync screen (lib/app-handoff, route "sync"). */
  readonly onSignIn?: () => void;
  /** Signed out only: the card says "Opens the Still app" under Sign in. */
  readonly appHandoff?: true;
}

/**
 * Settings-page sync card for Safari. The Apple app owns the account, so a signed-in account is
 * read-only: there is no onSignOut, onDeleteAccount or retry here, and the card hides every account
 * action whose callback is absent, so the settings page never offers an action the Apple app owns.
 *
 * Signed out, the card shows the Safari popups' signed-out pattern (copy audit, 22 Oct 2026): the
 * sync line, Sign in, and "Opens the Still app" under it. Sign in hands off to the Still app
 * (`openApp`, the page's lib/app-handoff), never signing in here. Without a hand-off the card keeps
 * an empty account, so it never shows a Sign in button that could do nothing.
 */
export function appManagedSettingsSync(
  source: AppManagedAccountSource,
  text: AccountStatusText,
  openApp?: () => void,
  access?: Pick<BenefitAccessSnapshot, "accountHoldsPro">,
): SettingsSyncDisplay {
  if (!source.userId) return openApp ? { onSignIn: openApp, appHandoff: true } : { account: { confirmed: false } };
  return {
    account: {
      address: source.accountEmail ?? undefined,
      identity: source.userId,
      revision: source.accountRevision,
      confirmed: false,
      holdsPro: accountHoldsPro(access),
      // The same synced line as the popup and the Chrome and Firefox Settings page.
      lastSyncedAt: source.lastSyncedAt,
      status: statusFor(source, text),
    },
  };
}
