import type { DataPermissionKind } from "@still/core/ui/data-permission";
import type { ExtensionSession } from "@still/core/sync";
import { backendRoutes } from "@still/core/sync/backend-route-profile";
import {
  EMAIL_GRANT_ACCOUNT_KEY,
  EMAIL_PERMISSION_WITHDRAWN_KEY,
  FIREFOX_DATA_TYPES,
  firefoxDataGranted,
  type FirefoxDataCollectionApi,
} from "./data-permission.js";
export { EMAIL_GRANT_ACCOUNT_KEY, EMAIL_PERMISSION_WITHDRAWN_KEY } from "./data-permission.js";

// The Firefox background's half of the optional data-collection permissions (the pages' half is
// lib/data-permission.ts, which asks from the person's click). Firefox only: background.ts reaches
// this module through `import.meta.env.FIREFOX` branches, so the Chrome build carries none of it.
//
//   * guardFirefoxDataFetch: the Supabase client's fetch. A request that sends the email address
//     as personal data (the code request and code check, the store-review sign-in, and
//     analytics-identify, whose server attaches the account's email to its analytics person or
//     subject) or sends purchase data (starting a checkout, purchase analytics, an Apple receipt)
//     goes out only while Firefox lists that permission as granted, read again for every request.
//     Without it the request is refused as a network failure, which every caller already handles
//     calmly. Requests that only receive the account's Still Pro status (reconcile, the
//     entitlement read, a checkout's completion) send no purchase data and are never held back,
//     so Still Pro cannot lock for want of a grant.
//   * The sign-in session token is different: it is declared under the required
//     "authenticationInfo", it embeds the account's email address (Supabase's default claims), and
//     every signed-in request carries it, to Still's own backend only. It is the account's
//     credential, not the email sent as personal data, and it is not changed here.
//   * createAccountEmailWatch: an account signed in on this browser with the email permission
//     granted, whose permission is later withdrawn in about:addons, is signed out of sync here
//     (local settings stay) and the pages say why. An account signed in before the permission
//     existed stays signed in: its sign-in did not depend on this grant, and its email address is
//     not sent as personal data (code requests, analytics) without the grant.
//
// Neither is on the blocking path. Content scripts, the navigation rules, the TikTok block and
// local settings never wait on a permission (lib/__tests__/free-blocking-data-permission.test.ts).

// The lists are built inside functions, not at module level, so the Chrome build (where nothing
// calls them) keeps no trace of this module.

/** GoTrue endpoints whose request body carries the email address. */
const emailAuthPaths = (): readonly string[] => ["/auth/v1/otp", "/auth/v1/verify", "/auth/v1/magiclink", "/auth/v1/signup", "/auth/v1/recover", "/auth/v1/resend"];
/** Edge functions that are sent the email address, or attach it: the store-review sign-in, and
 * analytics-identify (both its account identify and its per-device subject request), whose server
 * attaches the account's email to the analytics person or subject. */
const emailFunctions = (): readonly string[] => ["review-signin", "analytics-identify"];
/** Edge functions that send purchase data, on both route profiles: starting a checkout (a
 * transaction for the account), Apple receipts, and purchase analytics. Reading the account's
 * Still Pro status (reconcile, a checkout's completion, the entitlement row) only receives it. */
function purchaseFunctions(): readonly string[] {
  return [
    ...(["production", "shared-hosted-sandbox"] as const).flatMap((profile) => {
      const routes = backendRoutes(profile);
      return [routes.verifyApple, routes.linkApple, routes.createCheckout];
    }),
    "analytics-purchase",
  ];
}

/** Which permission a request to Still's backend needs, or null when it carries neither. */
export function dataKindForRequest(url: string, supabaseUrl: string): DataPermissionKind | null {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(supabaseUrl);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  const prefix = base.pathname.replace(/\/+$/, "");
  if (!target.pathname.startsWith(prefix)) return null;
  const path = target.pathname.slice(prefix.length).replace(/\/+$/, "");
  if (emailAuthPaths().includes(path)) return "email";
  const fn = /^\/functions\/v1\/([^/]+)$/.exec(path)?.[1];
  if (fn !== undefined) return emailFunctions().includes(fn) ? "email" : purchaseFunctions().includes(fn) ? "purchase" : null;
  return null;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export interface FirefoxDataGuardOptions {
  readonly supabaseUrl: string;
  /** Read for every guarded request (never cached): the person can withdraw at any time. */
  readonly granted: (kind: DataPermissionKind) => Promise<boolean>;
}

export function guardFirefoxDataFetch(base: typeof fetch, options: FirefoxDataGuardOptions): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const kind = dataKindForRequest(urlOf(input), options.supabaseUrl);
    if (kind !== null) {
      const granted = await options.granted(kind).then(
        (answer) => answer === true,
        () => false,
      );
      // A TypeError is what fetch itself rejects with offline: every caller already maps it to
      // its calm "couldn't send" or "unknown" answer, and none retries in a loop.
      if (!granted) throw new TypeError("Not sent: Firefox's data permission for this request is not granted");
    }
    return base(input, init);
  };
}

/** A small stored value (chrome.storage.local in the background). */
export interface StoredValue<T> {
  get(): Promise<T | null>;
  set(value: T | null): Promise<void>;
}

export interface AccountEmailWatchDeps {
  /** Firefox's email permission, read now. */
  readonly granted: () => Promise<boolean>;
  readonly currentUserId: () => Promise<string | null>;
  /** The account whose sign-in on this browser sent its email address with the permission. */
  readonly signedInWithGrant: StoredValue<string>;
  /** Set when that permission was withdrawn and the account was signed out; the pages show the
   * line until the next sign-in. */
  readonly withdrawn: StoredValue<true>;
  /** The session's voluntary sign-out: local settings stay; the account's session is dropped. */
  readonly signOut: () => Promise<unknown>;
  /** Run the check again later, after a sign-out that failed. Defaults to 30 seconds. */
  readonly retryLater?: (run: () => void) => void;
}

/** How long a failed withdrawal sign-out waits before the check runs again. */
export const WITHDRAWAL_RETRY_MS = 30_000;

export type AccountEmailCheck = "kept" | "signed-out" | "retrying";

export function createAccountEmailWatch(deps: AccountEmailWatchDeps) {
  let flight: Promise<AccountEmailCheck> | null = null;
  let retryArmed = false;
  const retryLater = deps.retryLater ?? ((run: () => void) => void setTimeout(run, WITHDRAWAL_RETRY_MS));
  async function run(): Promise<AccountEmailCheck> {
    const userId = await deps.currentUserId();
    if (userId === null) return "kept";
    if ((await deps.signedInWithGrant.get()) !== userId) return "kept";
    if (await deps.granted()) return "kept";
    try {
      await deps.signOut();
    } catch {
      // Never taken as "kept": the account stays withdrawn-from, so the check runs again (and
      // the fetch guard keeps refusing every email send meanwhile).
      if (!retryArmed) {
        retryArmed = true;
        retryLater(() => {
          retryArmed = false;
          void check();
        });
      }
      return "retrying";
    }
    await deps.signedInWithGrant.set(null);
    await deps.withdrawn.set(true);
    return "signed-out";
  }
  /** The permission is granted again: the pages' withdrawn line has nothing left to say. */
  async function clearIfGranted(): Promise<void> {
    if ((await deps.withdrawn.get()) !== true) return;
    if (await deps.granted()) await deps.withdrawn.set(null);
  }
  function check(): Promise<AccountEmailCheck> {
    return (flight ??= clearIfGranted()
      .catch(() => {})
      .then(run)
      .catch((): AccountEmailCheck => "kept")
      .finally(() => {
        flight = null;
      }));
  }
  return {
    /** A sign-in just completed; the code check went out, so the permission was granted. */
    async signedIn(userId: string): Promise<void> {
      await deps.signedInWithGrant.set(userId);
      await deps.withdrawn.set(null);
    },
    /** Signed in with the permission and it is gone now: sign out of sync. One check at a time.
     * A failed sign-out is retried; a failed read leaves things as they are (the fetch guard
     * still refuses every email send). */
    check,
    /** Firefox reported the email permission added: clear the withdrawn line. */
    granted: () => clearIfGranted().catch(() => {}),
  };
}

export type AccountEmailWatch = ReturnType<typeof createAccountEmailWatch>;

/**
 * The session the pages and the background start use: the account's reads and the start-up resume
 * run the withdrawal check first, so a permission withdrawn while the background slept is noticed
 * the next time anything looks at the account.
 */
export function withAccountEmailWatch(session: ExtensionSession, watch: AccountEmailWatch): ExtensionSession {
  return {
    ...session,
    getState: async () => {
      await watch.check();
      return session.getState();
    },
    getSyncStatus: async () => {
      await watch.check();
      return session.getSyncStatus();
    },
    resume: async () => {
      await watch.check();
      return session.resume();
    },
    // A supported site was opened. The content script sent the nudge without waiting for a reply,
    // so this check never holds up blocking.
    onNudge: async () => {
      await watch.check();
      return session.onNudge();
    },
    verifyCode: async (email, token) => {
      const outcome = await session.verifyCode(email, token);
      if (outcome.kind === "verified") await watch.signedIn(outcome.userId).catch(() => {});
      return outcome;
    },
  };
}

/**
 * Firefox: an analytics call whose server attaches the account's email address
 * (analytics-identify's account identify and its per-device subject) runs only with the email
 * grant. Without it the call is refused like a failed request, which the analytics host retries
 * later, so nothing is marked as done. The fetch guard refuses the request too.
 */
export function requireEmailGrant<A extends unknown[], R>(
  call: (...args: A) => Promise<R>,
  granted: () => Promise<boolean>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    if (!(await granted().catch(() => false))) throw new Error("Not sent: Firefox's email permission is not granted");
    return call(...args);
  };
}

/** The browser calls the background wiring needs (chrome in the Firefox build; fakes in tests). */
export interface AccountEmailBrowser {
  /** Reads and events only: the background never asks for a permission. */
  readonly permissions: Pick<FirefoxDataCollectionApi, "getAll"> & {
    readonly onRemoved?: { addListener(listener: (permissions: { data_collection?: string[] }) => void): void };
    readonly onAdded?: { addListener(listener: (permissions: { data_collection?: string[] }) => void): void };
  };
  readonly storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  };
}

/**
 * Firefox only: the session the background and its pages use, with the withdrawal check before the
 * account's reads, the start-up resume and the supported-site nudge. Firefox's own permission events
 * run the same check (removed) or clear the withdrawn line (added). Nothing here asks for a
 * permission. Call it in the background's first synchronous pass, so the listeners are top-level.
 */
export function watchFirefoxAccountEmail(
  session: ExtensionSession,
  currentUserId: () => Promise<string | null>,
  browser: AccountEmailBrowser,
): ExtensionSession {
  const stored = <T>(key: string): StoredValue<T> => ({
    get: async () => ((await browser.storage.get(key))[key] as T | undefined) ?? null,
    set: async (value) => {
      if (value === null) await browser.storage.remove(key);
      else await browser.storage.set({ [key]: value });
    },
  });
  const watch = createAccountEmailWatch({
    granted: () => firefoxDataGranted(() => browser.permissions, "email"),
    currentUserId,
    signedInWithGrant: stored<string>(EMAIL_GRANT_ACCOUNT_KEY),
    withdrawn: stored<true>(EMAIL_PERMISSION_WITHDRAWN_KEY),
    signOut: () => session.signOut(),
  });
  browser.permissions.onRemoved?.addListener((permissions) => {
    if (permissions.data_collection?.includes(FIREFOX_DATA_TYPES.email)) void watch.check();
  });
  browser.permissions.onAdded?.addListener((permissions) => {
    if (permissions.data_collection?.includes(FIREFOX_DATA_TYPES.email)) void watch.granted();
  });
  return withAccountEmailWatch(session, watch);
}
