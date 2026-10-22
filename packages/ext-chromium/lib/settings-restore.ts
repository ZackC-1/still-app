import type { UiController } from "@still/core/ui";
import type { BrowserRestoreAnswer } from "@still/core/ui/v3/browser-settings-restore";

// The Chrome/Firefox settings page's free-period "Restore purchase" (owner decisions 62 and 73,
// option A). Imported only by the lazily loaded options wrapper (RestoreSettings.svelte), which
// only the options page's V3 new-sync branch loads.
//
// This module deliberately takes no value from the modules every build shares (wxt's `browser`,
// session-messages, purchase-wiring): importing one would make the shared chunk export it, which
// would change configured 2.x bundles. The message kind is therefore spelled here, and a test pins
// it to SESSION_MESSAGE_KIND.

/** The session protocol's message kind; equal to SESSION_MESSAGE_KIND in session-messages.ts. */
export const RESTORE_SESSION_KIND = "still:session";

const ANSWERS: ReadonlySet<unknown> = new Set<BrowserRestoreAnswer>([
  "entitled",
  "not-entitled",
  "unknown",
  "auth-required",
  "signed-out",
]);

/** The one runtime call this needs (browser.runtime or chrome.runtime). */
export interface RestoreRuntime {
  sendMessage(message: unknown): Promise<unknown>;
}

/** What the settings wrapper needs: the account facts and sign-in opener, plus the check. */
export interface SettingsRestoreHost {
  readonly controller: Pick<UiController, "userId" | "signInOpen" | "canSignIn" | "openSignIn">;
  readonly check: () => Promise<BrowserRestoreAnswer>;
}

/** The same choice wxt's `browser` makes: Firefox's `browser`, else Chrome's `chrome`. */
function extensionRuntime(): RestoreRuntime {
  const scope = globalThis as unknown as {
    browser?: { runtime?: RestoreRuntime & { id?: string } };
    chrome: { runtime: RestoreRuntime };
  };
  return scope.browser?.runtime?.id ? scope.browser.runtime : scope.chrome.runtime;
}

/**
 * The check is the background session's existing `restore` action: a reconcile-only entitlement
 * read for the signed-in account, which the background records locally. It is the only message
 * this sends; it never sends createCheckout or setPurchaseIntent. A torn transport, a rejection or
 * any reply outside the session vocabulary settles to "unknown", which the flow shows as its
 * existing "couldn't finish checking" state.
 */
export function settingsRestoreHost(
  controller: SettingsRestoreHost["controller"],
  runtime: RestoreRuntime = extensionRuntime(),
): SettingsRestoreHost {
  return {
    controller,
    async check(): Promise<BrowserRestoreAnswer> {
      try {
        const answer = await runtime.sendMessage({ kind: RESTORE_SESSION_KIND, action: "restore" });
        return ANSWERS.has(answer) ? (answer as BrowserRestoreAnswer) : "unknown";
      } catch {
        return "unknown";
      }
    },
  };
}
