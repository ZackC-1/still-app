import seed from "@still/core/seed";
import { createTiktokBlockedRoute, type TiktokCommittedSnapshot, type TiktokRouteReply, type TiktokRouteSender } from "@still/core/content/tiktok-blocked-route";
import { createBrowserTiktokTabAuthority, type TiktokTabBrowser } from "@still/core/content/browser-tiktok-tab-authority";
import { createTiktokDocumentRegistry, type TiktokDocumentPort } from "@still/core/content/tiktok-document-port";
import type { SignedRuleSet, SignedRuleSetV2 } from "@still/shared-types";

type Listener = (message: unknown, sender: TiktokRouteSender, reply: (answer: TiktokRouteReply) => void) => boolean;
export interface SafariTiktokBrowser extends TiktokTabBrowser {
  readonly runtime: TiktokTabBrowser["runtime"] & {
    readonly onConnect: { addListener(listener: (port: TiktokDocumentPort) => void): void; removeListener(listener: (port: TiktokDocumentPort) => void): void };
    readonly onMessage: { addListener(listener: Listener): void; removeListener(listener: Listener): void };
  };
  readonly tabs?: NonNullable<TiktokTabBrowser["tabs"]> & {
    update(id: number, properties: { url: string }): Promise<unknown>;
  };
}
export const SAFARI_TIKTOK_PAGE = "tiktok-blocked.html";

/** V3-only composition. Native settings are only read; grants stay in browser session storage. */
export function wireSafariTiktokHost(deps: {
  readonly browser: SafariTiktokBrowser;
  readonly readCommitted: () => Promise<TiktokCommittedSnapshot | null>;
  readonly randomId: () => string;
}) {
  const { browser } = deps;
  const tabs = browser.tabs;
  const pageUrl = browser.runtime.getURL(SAFARI_TIKTOK_PAGE);
  const documents = tabs && browser.storage?.session &&
    typeof tabs.get === "function" && typeof tabs.update === "function" &&
    typeof tabs.onRemoved?.addListener === "function" && typeof tabs.onRemoved?.removeListener === "function" &&
    typeof tabs.onReplaced?.addListener === "function" && typeof tabs.onReplaced?.removeListener === "function" &&
    typeof browser.runtime.onConnect?.addListener === "function" && typeof browser.runtime.onConnect?.removeListener === "function"
    ? createTiktokDocumentRegistry({ runtimeId: browser.runtime.id, pageUrl, tabs, randomId: deps.randomId }) : null;
  const ruleSet = seed as unknown as SignedRuleSet;
  const route = createTiktokBlockedRoute({
    runtimeId: browser.runtime.id,
    extensionOrigin: browser.runtime.getURL(""),
    pageUrl,
    session: browser.storage?.session,
    tabs,
    ruleSet,
    readCommitted: deps.readCommitted,
    canVerifyDocuments: documents !== null,
    // Safari tabs.update has no Firefox loadReplace option. The existing traversal hold prevents
    // Back trapping without inventing a history permission or a second navigation policy.
    replaceHistory: false,
    randomId: deps.randomId,
    createAuthority: (hooks) => createBrowserTiktokTabAuthority({
      browser: { runtime: browser.runtime, storage: { session: hooks.session }, tabs },
      ruleSet: ruleSet as unknown as SignedRuleSetV2,
      readCommitted: hooks.readCommitted,
      blockedPagePath: SAFARI_TIKTOK_PAGE,
      resolveOriginalTarget: hooks.resolveOriginalTarget,
      confirm: hooks.confirm,
      // Capture connection generation once, not separately after each await of one operation.
      currentDocument: (sender) => documents?.capture(sender) ?? (async () => false),
    }),
  });
  if (documents) browser.runtime.onConnect.addListener(documents.connect);
  browser.runtime.onMessage.addListener(route.listener);
  return {
    async stop() {
      documents?.stop();
      if (documents) browser.runtime.onConnect.removeListener(documents.connect);
      browser.runtime.onMessage.removeListener(route.listener);
      await route.stop();
    },
  };
}
