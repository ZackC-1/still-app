import { createExtensionSession, type ExtensionSession, type ExtensionSessionDeps } from "@still/core/sync";
import {
  SESSION_MESSAGE_KIND,
  isExtensionPageSender,
  type SessionMessageListener,
} from "./session-messages.js";

// "May the settings page offer Buy?" for the Chrome and Firefox Still Pro card (owner decision,
// 10 October 2026). Background half only; the page half is lib/browser-pro.ts. Paid-tier builds
// only: background.ts picks createSessionWithCheckoutAvailability over createExtensionSession in a
// PAID_TIER_ENABLED branch and only the paid settings card asks, so builds compiled with the paid
// tier off contain neither half.
//
// It rides the existing session message kind and the same privileged sender rule as the session
// router (an extension page of this extension, never a content script). It is kept out of that
// router's registry because adding a registry entry would change the shipped 2.x bundles.
//
// The answer is display only. The background's createCheckout runs its own fresh sales check
// before any checkout opens, and free blocking, free sync and Restore never ask this.

export const CHECKOUT_AVAILABLE_ACTION = "checkoutAvailable";

export interface CheckoutAvailableRequest {
  readonly kind: typeof SESSION_MESSAGE_KIND;
  readonly action: typeof CHECKOUT_AVAILABLE_ACTION;
}

export function isCheckoutAvailableRequest(message: unknown): message is CheckoutAvailableRequest {
  if (typeof message !== "object" || message === null) return false;
  const m = message as Record<string, unknown>;
  return m.kind === SESSION_MESSAGE_KIND && m.action === CHECKOUT_AVAILABLE_ACTION;
}

/**
 * Background listener. `check` is the session's signed-in state together with the same fresh
 * sales allowance createCheckout consults. Any failure, and every non-page sender, is "no".
 */
export function createCheckoutAvailabilityRouter(
  check: () => Promise<boolean>,
  runtimeId: string,
  extensionOrigin: string,
): SessionMessageListener {
  return (message, sender, sendResponse) => {
    if (!isCheckoutAvailableRequest(message) || !isExtensionPageSender(sender, runtimeId, extensionOrigin)) return false;
    void check()
      .then((allowed) => allowed === true, () => false)
      .then(sendResponse)
      .catch(() => {});
    return true;
  };
}

export interface CheckoutAvailabilityChrome {
  readonly runtime: {
    readonly id: string;
    getURL(path: string): string;
    readonly onMessage: { addListener(listener: SessionMessageListener): void };
  };
}

/**
 * The background's session factory in paid-tier builds: the ordinary session, plus the Buy
 * question answered from the very same `canCreateCheckout` the session's createCheckout consults,
 * so the card never offers a checkout that createCheckout would refuse for policy. Without a sales
 * allowance (every non-QA route) nothing is registered and the card's question reads "no".
 *
 * It also ends the checkout-pending record when a managed checkout finished without a purchase.
 * The settings card records its checkout tab there, so sign-out or an account switch closes the tab
 * and supported-site visits reconcile until the purchase lands. A confirmed purchase already clears
 * the record (after the entitlement write). A finished checkout is seen as the session clearing its
 * stored operation (any terminal completion: unpaid, refunded or access observed). The record is
 * ended only when the reconcile that follows writes a definitive "not entitled" answer. If that
 * read fails after a payment, the record stays and visits keep reconciling until it lands.
 *
 * Call it in the worker's first synchronous pass, where createExtensionSession is called today.
 */
export function createSessionWithCheckoutAvailability(
  deps: ExtensionSessionDeps,
  host: CheckoutAvailabilityChrome = chrome as unknown as CheckoutAvailabilityChrome,
  create: (deps: ExtensionSessionDeps) => ExtensionSession = createExtensionSession,
): ExtensionSession {
  const operation = deps.stores.checkoutOperation;
  const pending = deps.stores.checkoutPending;
  const records = deps.records;
  // The session cleared its stored checkout operation and no new checkout has started since.
  let finished = false;
  const session = create(operation ? {
    ...deps,
    records: {
      getRecord: (sessionUserId?: string) => records.getRecord(sessionUserId),
      setRecord: async (record) => {
        await records.setRecord(record);
        if (finished && record.entitled === false) {
          finished = false;
          // Best effort: a failed clear only means one more reconcile on a later visit.
          await pending.set(null).catch(() => {});
        }
      },
    },
    stores: {
      ...deps.stores,
      checkoutOperation: {
        get: () => operation.get(),
        set: async (value) => {
          await operation.set(value);
          finished = value === null;
        },
      },
    },
  } : deps);
  const salesAllowed = deps.canCreateCheckout;
  if (salesAllowed) {
    host.runtime.onMessage.addListener(createCheckoutAvailabilityRouter(
      async () => (await session.getState()).userId !== null && (await salesAllowed()) === true,
      host.runtime.id,
      host.runtime.getURL(""),
    ));
  }
  return session;
}
