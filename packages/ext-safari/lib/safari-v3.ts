import type { StoredSettingsRecord } from "@still/core/storage";

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
  readonly supabaseUrl: string | undefined;
  readonly supabaseAnonKey: string | undefined;
}

/**
 * The V3 screens are compiled in only when a build opts in exactly as the Apple app's D04 screen
 * does (selectAppleSettingsMode): the flag is the string "true" and there is no Supabase
 * configuration (both values non-empty means configured). Anything else keeps the legacy screens.
 * The app's native-port condition has no equivalent here; the runtime record check below is the
 * extension's equivalent of "the Apple app is in atomic mode on this device".
 */
export function selectSafariV3Build(input: SafariV3BuildInput): boolean {
  const configured = Boolean(input.supabaseUrl && input.supabaseAnonKey);
  return input.atomicSettingsFlag === "true" && !configured;
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
  readonly status: { readonly tone: "pending" | "success" | "failed"; readonly text: string };
}

function statusFor(source: AppManagedAccountSource, text: AccountStatusText): PopupAccountDisplay["status"] {
  if (!source.cloudReachable) return { tone: "failed", text: text.unreachable };
  if (source.pendingUpload) return { tone: "pending", text: text.syncing };
  if (source.lastSyncedAt !== null) return { tone: "success", text: text.synced };
  return { tone: "pending", text: text.checking };
}

/**
 * Popup account display. Read-only by construction: the Apple app owns sign-in, sign-out, account
 * deletion and sync retry on Safari, so no action callback is ever produced here and the popup
 * never offers one. Signed out is `undefined` (the popup's own signed-out line, with no sign-in).
 */
export function appManagedPopupAccount(
  source: AppManagedAccountSource,
  text: AccountStatusText,
): PopupAccountDisplay | undefined {
  if (!source.userId) return undefined;
  return { address: source.accountEmail ?? undefined, status: statusFor(source, text) };
}

export interface SettingsSyncDisplay {
  readonly account: {
    readonly address?: string;
    readonly identity?: string;
    readonly revision?: number;
    readonly confirmed: false;
    readonly status?: PopupAccountDisplay["status"];
  };
}

/**
 * Settings-page sync card for Safari. As with the popup, there is no onSignIn, onSignOut,
 * onDeleteAccount or retry: the card hides every account action whose callback is absent, so the
 * extension never offers an action the Apple app owns.
 *
 * Signed out is an empty account, not "no account". With no account at all, SyncCard renders its
 * signed-out invitation with a Sign in button, which this build can never enable, so it would be a
 * permanently dead control. An empty account leaves only the card's "Settings sync" heading (plus
 * any host action slot). Omitting the card itself would need a change to ExtensionSettings, which
 * ships in the default Chrome and Firefox bundles and would break their byte identity.
 */
export function appManagedSettingsSync(
  source: AppManagedAccountSource,
  text: AccountStatusText,
): SettingsSyncDisplay {
  if (!source.userId) return { account: { confirmed: false } };
  return {
    account: {
      address: source.accountEmail ?? undefined,
      identity: source.userId,
      revision: source.accountRevision,
      confirmed: false,
      status: statusFor(source, text),
    },
  };
}
