import {
  createTiktokTabAuthority,
  type TiktokTabAuthorityDeps,
  type TiktokTabContext,
} from "../../core/src/content/tiktok-tab-authority.js";
import { isExtensionPageSender } from "./session-messages.js";

export interface TiktokBrowserSender {
  readonly id?: string;
  readonly url?: string;
  readonly frameId?: number;
  /** Actual browser MessageSender document ID; transient only, never persisted. */
  readonly documentId?: string;
  readonly tab?: { readonly id?: number };
}

/** The actual browser API subset; missing host capabilities hold only this optional action. */
export interface TiktokTabBrowser {
  readonly runtime: {
    readonly id: string;
    getURL(path: string): string;
    /** Optional native capability. Missing proof holds allow, without broad tabs permission. */
    getContexts?(filter: {
      documentIds: string[];
      tabIds: number[];
      frameIds: number[];
      contextTypes: ["TAB"];
    }): Promise<
      ReadonlyArray<{
        readonly contextType: string;
        readonly documentId?: string;
        readonly tabId: number;
        readonly frameId: number;
        readonly documentUrl?: string;
      }>
    >;
  };
  readonly storage?: {
    readonly session?: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
  };
  readonly tabs?: {
    get(id: number): Promise<{
      readonly id?: number;
      readonly url?: string;
      readonly pendingUrl?: string;
    }>;
    readonly onRemoved: {
      addListener(listener: (id: number) => void): void;
      removeListener(listener: (id: number) => void): void;
    };
    readonly onReplaced: {
      addListener(listener: (addedId: number, removedId: number) => void): void;
      removeListener(
        listener: (addedId: number, removedId: number) => void,
      ): void;
    };
  };
}

export interface ChromeTiktokTabAuthorityDeps {
  readonly browser: TiktokTabBrowser;
  readonly ruleSet: TiktokTabAuthorityDeps["ruleSet"];
  readonly readCommitted: TiktokTabAuthorityDeps["readCommitted"];
  /** Exact future extension-owned route, never a caller-supplied message field. Absent now. */
  readonly blockedPagePath?: string;
  /** Trusted host's bound original destination. No query/payload convention is invented here. */
  readonly resolveOriginalTarget?: (
    sender: Readonly<TiktokBrowserSender>,
  ) => Promise<string | null>;
  /** Genuine confirmation producer remains held until real blocked UI integration is verified. */
  readonly confirm?: (context: Readonly<TiktokTabContext>) => Promise<boolean>;
}

/**
 * Dormant browser adapter: no runtime message registration, navigation, settings or analytics.
 * A future internal background handler supplies actual browser MessageSender, never body fields.
 * Session API default TRUSTED_CONTEXTS is retained; no access-level widening or durable fallback.
 */
export function createChromeTiktokTabAuthority(
  deps: ChromeTiktokTabAuthorityDeps,
) {
  const { browser } = deps;
  const area = browser.storage?.session;
  const tabs = browser.tabs;
  const supported =
    !!area &&
    typeof area.get === "function" &&
    typeof area.set === "function" &&
    typeof area.remove === "function" &&
    !!tabs &&
    typeof tabs.get === "function" &&
    typeof tabs.onRemoved?.addListener === "function" &&
    typeof tabs.onRemoved?.removeListener === "function" &&
    typeof tabs.onReplaced?.addListener === "function" &&
    typeof tabs.onReplaced?.removeListener === "function";
  const extensionOrigin = browser.runtime.getURL("");
  const route = deps.blockedPagePath
    ? browser.runtime.getURL(deps.blockedPagePath)
    : null;
  const key = (id: number) => `still:tiktok-tab:${id}`;
  const requireSession = () => {
    if (!supported || !area)
      throw new Error("Browser session authority unavailable");
    return area;
  };
  const authority = createTiktokTabAuthority({
    ruleSet: deps.ruleSet,
    readCommitted: deps.readCommitted,
    store: {
      get: async (id) => (await requireSession().get(key(id)))[key(id)],
      set: async (id, value) => {
        await requireSession().set({ [key(id)]: value });
      },
      remove: async (id) => {
        await requireSession().remove(key(id));
      },
    },
    isLivingTab: async (id) => supported && (await tabs!.get(id)).id === id,
  });

  const capture = (sender: TiktokBrowserSender): TiktokBrowserSender =>
    Object.freeze({
      id: sender.id,
      url: sender.url,
      frameId: sender.frameId,
      documentId: sender.documentId,
      tab: Object.freeze({ id: sender.tab?.id }),
    });
  const topLevel = (sender: TiktokBrowserSender) =>
    supported &&
    sender.id === browser.runtime.id &&
    sender.frameId === 0 &&
    typeof sender.url === "string" &&
    Number.isSafeInteger(sender.tab?.id) &&
    sender.tab!.id! >= 0;

  async function currentPage(
    sender: TiktokBrowserSender,
    extensionPage = false,
  ): Promise<boolean> {
    if (!topLevel(sender)) return false;
    const tab = await tabs!.get(sender.tab!.id!);
    if (
      tab.id !== sender.tab!.id ||
      (tab.pendingUrl && tab.pendingUrl !== sender.url)
    )
      return false;
    if (!extensionPage) return tab.url === sender.url;
    // tabs.get redacts extension-page URL under our existing host permissions. Revalidate the
    // exact active native document instead; a replaced document at the same URL is not proof.
    if (!browser.runtime.getContexts || !sender.documentId) return false;
    const contexts = await browser.runtime.getContexts({
      documentIds: [sender.documentId],
      tabIds: [sender.tab!.id!],
      frameIds: [0],
      contextTypes: ["TAB"],
    });
    return contexts.some(
      (context) =>
        context.contextType === "TAB" &&
        context.documentId === sender.documentId &&
        context.tabId === sender.tab!.id &&
        context.frameId === 0 &&
        context.documentUrl === sender.url,
    );
  }
  function trustedScreen(sender: TiktokBrowserSender): boolean {
    if (
      !route ||
      !topLevel(sender) ||
      !isExtensionPageSender(sender, browser.runtime.id, extensionOrigin)
    )
      return false;
    try {
      const actual = new URL(sender.url!);
      const expected = new URL(route);
      return (
        actual.protocol === expected.protocol &&
        actual.host === expected.host &&
        actual.pathname === expected.pathname &&
        !actual.username &&
        !actual.password
      );
    } catch {
      return false;
    }
  }

  const onRemoved = (id: number) => {
    void authority.closeTab(id);
  };
  const onReplaced = (_addedId: number, removedId: number) => {
    void authority.closeTab(removedId);
  };
  if (supported) {
    tabs!.onRemoved.addListener(onRemoved);
    tabs!.onReplaced.addListener(onReplaced);
  }

  return {
    supported,
    async allow(input: TiktokBrowserSender): Promise<boolean> {
      const sender = capture(input);
      try {
        if (
          !trustedScreen(sender) ||
          !deps.resolveOriginalTarget ||
          !deps.confirm ||
          !(await currentPage(sender, true))
        )
          return false;
        const target = await deps.resolveOriginalTarget(sender);
        if (typeof target !== "string" || !(await currentPage(sender, true)))
          return false;
        const context: TiktokTabContext = {
          tabId: sender.tab!.id!,
          frameId: 0,
          target,
        };
        return await authority.allow(context, async (captured) => {
          if (
            !(await currentPage(sender, true)) ||
            (await deps.resolveOriginalTarget!(sender)) !== captured.target
          )
            return false;
          return (
            (await deps.confirm!(captured)) === true &&
            (await currentPage(sender, true)) &&
            (await deps.resolveOriginalTarget!(sender)) === captured.target
          );
        });
      } catch {
        return false;
      }
    },
    async isAllowed(input: TiktokBrowserSender): Promise<boolean> {
      const sender = capture(input);
      try {
        if (!(await currentPage(sender))) return false;
        return (
          (await authority.isAllowed({
            tabId: sender.tab!.id!,
            frameId: sender.frameId!,
            target: sender.url!,
          })) && (await currentPage(sender))
        );
      } catch {
        return false;
      }
    },
    async stop(): Promise<void> {
      if (supported) {
        tabs!.onRemoved.removeListener(onRemoved);
        tabs!.onReplaced.removeListener(onReplaced);
      }
      await authority.stop();
    },
  };
}
