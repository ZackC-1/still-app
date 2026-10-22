// The deep path (not the "@still/core/ui" barrel, which re-exports Svelte components) keeps this
// module loadable in this package's node-environment vitest.
import type { DataPermission, DataPermissionKind } from "@still/core/ui/data-permission";

// Firefox's optional data-collection permissions for the two things Still sends only when the
// person asks for an account feature (wxt.config.ts `data_collection_permissions.optional`):
//
//   * "personallyIdentifyingInfo": the email address that Sign in sends to get a code.
//   * "financialAndPaymentInfo":   the Still Pro purchase status that Get Still Pro and Restore
//                                  purchase read and record.
//
// Mozilla's rules this follows (Extension Workshop, "Firefox built-in consent for data collection
// and transmission"; MDN permissions.request and "User actions"):
//   * Optional data types are not shown at install and are not granted by default. The add-on asks
//     at run time with `permissions.request({ data_collection: [...] })`.
//   * That call is honoured only inside the handler of a user action (a click on an extension
//     page, the popup included), and "if a user input handler waits on a promise, then its status
//     as a user input handler is lost". So `ask` makes the call synchronously, and callers make it
//     the first thing their click handler does.
//   * Granted optional types are listed in `permissions.getAll().data_collection`. A missing key
//     means the browser has no built-in consent, which this build's 140 floor rules out; it reads
//     as not granted, so nothing is sent.
//   * The person can withdraw a grant at any time in about:addons, so `granted` is read again
//     before every send.
//
// Chrome and Safari have no such API: their builds get `undefined` (the WXT flag folds this
// module's Firefox branch away), so nothing there ever asks or checks.

/** Mozilla's name for each kind (the manifest's `data_collection_permissions` values). A plain
 * literal (no call) so the Chrome build, where nothing reads it, drops it entirely. */
export const FIREFOX_DATA_TYPES = {
  email: "personallyIdentifyingInfo",
  purchase: "financialAndPaymentInfo",
} as const satisfies Record<DataPermissionKind, string>;

/** The two Firefox calls this needs, which @types/chrome does not describe. */
export interface FirefoxDataCollectionApi {
  request(permissions: { data_collection: string[] }): Promise<boolean>;
  getAll(): Promise<{ data_collection?: string[] }>;
}

/** Whether `kind` is granted now, from Firefox's own list. Any failure reads as not granted. */
export async function firefoxDataGranted(
  api: () => FirefoxDataCollectionApi | undefined,
  kind: DataPermissionKind,
): Promise<boolean> {
  try {
    const all = await api()?.getAll();
    return Array.isArray(all?.data_collection) && all.data_collection.includes(FIREFOX_DATA_TYPES[kind]);
  } catch {
    return false;
  }
}

export function firefoxDataPermission(api: () => FirefoxDataCollectionApi | undefined): DataPermission {
  const granted = (kind: DataPermissionKind) => firefoxDataGranted(api, kind);
  return {
    ask(kind) {
      // The request goes out synchronously, before this function awaits anything. Already granted,
      // Firefox answers true without a prompt. Called outside a click it refuses (rejects); the
      // grant read beside it then decides, so a re-check made without a click still passes when the
      // permission is there.
      let requested: Promise<boolean>;
      try {
        const permissions = api();
        requested = permissions
          ? Promise.resolve(permissions.request({ data_collection: [FIREFOX_DATA_TYPES[kind]] })).then(
              (answer) => answer === true,
              () => false,
            )
          : Promise.resolve(false);
      } catch {
        requested = Promise.resolve(false);
      }
      return Promise.all([requested, granted(kind)]).then(([asked, held]) => asked || held);
    },
    granted,
  };
}

/** Pure choice so tests cover both targets without WXT's build-time flag replacement. */
export function pickDataPermission(
  isFirefox: boolean,
  api: () => FirefoxDataCollectionApi | undefined,
): DataPermission | undefined {
  return isFirefox ? firefoxDataPermission(api) : undefined;
}

const firefoxPermissions = (): FirefoxDataCollectionApi | undefined =>
  (globalThis as unknown as { chrome?: { permissions?: FirefoxDataCollectionApi } }).chrome?.permissions;

/** This build's: Firefox's permission calls, or undefined (Chrome; the flag folds the rest away). */
export const dataPermission: DataPermission | undefined = import.meta.env.FIREFOX
  ? firefoxDataPermission(firefoxPermissions)
  : undefined;

/** storage.local, written by the Firefox background (lib/firefox-data-guard.ts): the account whose
 * sign-in here sent its email address with the permission, and the flag that its permission was
 * then withdrawn and it was signed out of sync. */
export const EMAIL_GRANT_ACCOUNT_KEY = "still:firefox-email-grant-account";
export const EMAIL_PERMISSION_WITHDRAWN_KEY = "still:firefox-email-permission-withdrawn";

/** The storage.local calls the notice needs. */
export interface NoticeStorage {
  get(key: string): Promise<Record<string, unknown>>;
  readonly onChanged?: {
    addListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void;
    removeListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void;
  };
}

/**
 * Firefox pages: when the background signed the account out because its email permission was
 * withdrawn, show the sign-in line (the settings page's sync card and the sign-in sheet) until the
 * next sign-in clears the flag. Returns the stop function.
 */
export function watchEmailPermissionNotice(
  controller: { showDataPermissionNotice(kind: DataPermissionKind): void },
  storage: NoticeStorage,
): () => void {
  let stopped = false;
  void storage
    .get(EMAIL_PERMISSION_WITHDRAWN_KEY)
    .then((items) => {
      if (!stopped && items[EMAIL_PERMISSION_WITHDRAWN_KEY] === true) controller.showDataPermissionNotice("email");
    })
    .catch(() => {});
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === "local" && changes[EMAIL_PERMISSION_WITHDRAWN_KEY]?.newValue === true)
      controller.showDataPermissionNotice("email");
  };
  storage.onChanged?.addListener(listener);
  return () => {
    stopped = true;
    storage.onChanged?.removeListener(listener);
  };
}

/** This extension's storage.local and its change event, as the notice reads them. */
export function extensionNoticeStorage(): NoticeStorage {
  return {
    get: (key) => chrome.storage.local.get(key) as Promise<Record<string, unknown>>,
    onChanged: chrome.storage.onChanged as unknown as NoticeStorage["onChanged"],
  };
}
