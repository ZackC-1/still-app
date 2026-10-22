import type { RestoreStatusCardProps } from "./extension-settings-presentation.js";
import type { DataPermission } from "../data-permission.js";

/**
 * The background session's answer to its existing reconcile-only `restore` action (the same
 * vocabulary as SessionReconcileOutcome in core/sync): a fresh authenticated entitlement read for
 * the signed-in account, recorded locally. It never creates a checkout or a purchase intent.
 */
export type BrowserRestoreAnswer =
  | "entitled"
  | "not-entitled"
  | "unknown"
  | "auth-required"
  | "signed-out";

/** The account facts the flow needs from the host's controller. */
export interface BrowserRestoreAccount {
  readonly userId: string | null;
  readonly signInOpen: boolean;
}

export interface BrowserSettingsRestoreDeps {
  /** The existing session `restore` message. It may reject on a torn transport. */
  readonly check: () => Promise<BrowserRestoreAnswer>;
  /** Opens the normal email-code sign-in sheet (the sync sign-in flow). */
  readonly openSignIn: () => void;
  /** Receives the RestoreStatusCard state to show; undefined clears the card. */
  readonly publish: (restore: RestoreStatusCardProps | undefined) => void;
  /** Firefox only: the optional permission to check the purchase status. The tap asks for it
   * first; every check reads it again; without it nothing is sent and the card says so. */
  readonly permission?: DataPermission;
}

/**
 * The plain "Restore purchase" link on the Chrome and Firefox settings page while the paid tier is
 * off (owner decisions 62 and 73, option A; modelled on the Apple app's free-period Restore).
 *
 * Signed in, a tap runs one check. Signed out, a tap opens the normal sign-in first, and the check
 * runs once that sign-in completes; dismissing the sheet drops the request. The check is only the
 * existing reconcile, which records the account's entitlement locally, where it stays dormant while
 * the paid flags are off. Nothing here can start a purchase, open checkout or show a price.
 *
 * Outcomes use only the existing RestoreStatusCard states and their existing browser wording:
 * entitled is "restored", a conclusive not-entitled is "nothing", and anything else (offline, a
 * torn transport, an unavailable server or an ended session) is "failed" with its own Try again.
 * One check at a time. A result that arrives after the account changed, or after `stop`, is
 * dropped, and an account change clears a shown result so it never describes another account.
 */
export function createBrowserSettingsRestore(deps: BrowserSettingsRestoreDeps) {
  let account: BrowserRestoreAccount = { userId: null, signInOpen: false };
  let flight = false;
  let awaitingSignIn = false;
  /** The account the shown card (or the running check) belongs to. */
  let checkedFor: string | null = null;
  let generation = 0;
  let stopped = false;
  /** Firefox is showing (or settling) its permission prompt for this tap. */
  let asking = false;

  async function run(userId: string, ticket: number): Promise<void> {
    deps.publish({ state: "checking" });
    if (deps.permission && !(await deps.permission.granted("purchase").catch(() => false))) {
      // Withdrawn since the tap (or never given): nothing is sent.
      if (!stopped && ticket === generation && account.userId === userId) deps.publish({ state: "permission" });
      return;
    }
    if (stopped || ticket !== generation || account.userId !== userId) return;
    let answer: BrowserRestoreAnswer | null;
    try {
      answer = await deps.check();
    } catch {
      answer = null;
    }
    if (stopped || ticket !== generation || account.userId !== userId) return;
    if (answer === "entitled") deps.publish({ state: "restored" });
    else if (answer === "not-entitled") deps.publish({ state: "nothing" });
    else deps.publish({ state: "failed", onAction: retry });
  }

  function start(): void {
    const userId = account.userId;
    if (stopped || flight || userId === null) return;
    flight = true;
    checkedFor = userId;
    const ticket = generation;
    void run(userId, ticket).finally(() => {
      if (ticket === generation) flight = false;
    });
  }

  function retry(): void {
    if (account.userId !== null) request();
  }

  function proceed(): void {
    if (account.userId !== null) {
      start();
      return;
    }
    awaitingSignIn = true;
    deps.openSignIn();
  }

  /** The link's tap. Ignored while a check or a sign-in for it is already under way. */
  function request(): void {
    if (stopped || flight || awaitingSignIn || asking) return;
    // Firefox: asked inside the tap, before anything is awaited (Firefox prompts only then).
    const asked = deps.permission?.ask("purchase");
    if (asked === undefined) {
      proceed();
      return;
    }
    asking = true;
    const ticket = generation;
    void asked
      .catch(() => false)
      .then((granted) => {
        asking = false;
        if (stopped || ticket !== generation) return;
        if (granted !== true) {
          deps.publish({ state: "permission" });
          return;
        }
        proceed();
      });
  }

  return {
    request,
    /** Feed every account change; the host calls this from its reactive effect. */
    observe(next: BrowserRestoreAccount): void {
      const previous = account;
      account = next;
      if (stopped) return;
      if (next.userId !== previous.userId && checkedFor !== null && next.userId !== checkedFor) {
        // A different (or no) account: forget a running or shown result for the old one.
        generation += 1;
        flight = false;
        checkedFor = null;
        deps.publish(undefined);
      }
      if (!awaitingSignIn) return;
      if (next.userId !== null) {
        awaitingSignIn = false;
        start();
      } else if (!next.signInOpen && previous.signInOpen) {
        // The sheet closed without a sign-in: the request ends quietly.
        awaitingSignIn = false;
      }
    },
    /** Whether a tap would currently be ignored (a check or its sign-in is under way). */
    get busy(): boolean {
      return flight || awaitingSignIn || asking;
    },
    stop(): void {
      stopped = true;
    },
  };
}
