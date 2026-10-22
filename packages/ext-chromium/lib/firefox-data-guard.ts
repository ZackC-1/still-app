import type { DataPermissionKind } from "@still/core/ui/data-permission";
import type { ExtensionSession } from "@still/core/sync";
import { backendRoutes } from "@still/core/sync/backend-route-profile";
export { EMAIL_GRANT_ACCOUNT_KEY, EMAIL_PERMISSION_WITHDRAWN_KEY } from "./data-permission.js";

// The Firefox background's half of the optional data-collection permissions (the pages' half is
// lib/data-permission.ts, which asks from the person's click). Firefox only: background.ts reaches
// this module through `import.meta.env.FIREFOX` branches, so the Chrome build carries none of it.
//
//   * guardFirefoxDataFetch: the Supabase client's fetch. A request that would carry the email
//     address (the code send and the code check) or the Still Pro purchase status (reconcile,
//     checkout, the entitlement read, purchase analytics) goes out only while Firefox lists that
//     permission as granted, read again for every request. Without it the request is refused as
//     a network failure, which every caller already handles calmly. Whatever path asks, nothing
//     leaves without a grant.
//   * createAccountEmailWatch: an account signed in on this browser with the email permission
//     granted, whose permission is later withdrawn in about:addons, is signed out of sync here
//     (local settings stay) and the pages say why. An account signed in before the permission
//     existed is left as it was: its sign-in did not depend on this grant, and nothing sent while
//     it is signed in carries its email address.
//
// Neither is on the blocking path. Content scripts, the navigation rules, the TikTok block and
// local settings never wait on a permission (lib/__tests__/free-blocking-data-permission.test.ts).

// The lists are built inside functions, not at module level, so the Chrome build (where nothing
// calls them) keeps no trace of this module.

/** GoTrue endpoints whose request body carries the email address. */
const emailAuthPaths = (): readonly string[] => ["/auth/v1/otp", "/auth/v1/verify", "/auth/v1/magiclink", "/auth/v1/signup", "/auth/v1/recover", "/auth/v1/resend"];
/** Edge functions sent the email address: the store-review sign-in. */
const emailFunctions = (): readonly string[] => ["review-signin"];
/** Edge functions that read, record or report the Still Pro purchase status, on both route profiles. */
function purchaseFunctions(): readonly string[] {
  return [
    ...(["production", "shared-hosted-sandbox"] as const).flatMap((profile) => {
      const routes = backendRoutes(profile);
      return [routes.reconcile, routes.verifyApple, routes.linkApple, routes.createCheckout, routes.completeCheckout];
    }).filter((name): name is string => typeof name === "string"),
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
  if (path === "/rest/v1/entitlements") return "purchase";
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
}

export function createAccountEmailWatch(deps: AccountEmailWatchDeps) {
  let flight: Promise<"kept" | "signed-out"> | null = null;
  async function run(): Promise<"kept" | "signed-out"> {
    const userId = await deps.currentUserId();
    if (userId === null) return "kept";
    if ((await deps.signedInWithGrant.get()) !== userId) return "kept";
    if (await deps.granted()) return "kept";
    await deps.signOut();
    await deps.signedInWithGrant.set(null);
    await deps.withdrawn.set(true);
    return "signed-out";
  }
  return {
    /** A sign-in just completed; the code check went out, so the permission was granted. */
    async signedIn(userId: string): Promise<void> {
      await deps.signedInWithGrant.set(userId);
      await deps.withdrawn.set(null);
    },
    /** Signed in with the permission and it is gone now: sign out of sync. One check at a time;
     * any failure leaves things as they are (the fetch guard still refuses every email send). */
    check(): Promise<"kept" | "signed-out"> {
      return (flight ??= run()
        .catch((): "kept" => "kept")
        .finally(() => {
          flight = null;
        }));
    },
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
    verifyCode: async (email, token) => {
      const outcome = await session.verifyCode(email, token);
      if (outcome.kind === "verified") await watch.signedIn(outcome.userId).catch(() => {});
      return outcome;
    },
  };
}
