import { PAID_TIER_ENABLED, type SignedRuleSet } from "@still/shared-types";
import {
  evaluate,
  createEnginePageSession,
  renderPlaceholder,
  ROOT_ACTIVE_CLASS,
  ROOT_PRO_ACTIVE_CLASS,
  STILL_PLACEHOLDER_LINE,
  STILL_BLOCKED_LINE,
} from "../rules/engine.js";
import type { EntitlementCache } from "../entitlement/cache.js";
import type { SettingsCache } from "../storage/cache.js";
import {
  installNavigationHooks,
  locationRedirectPort,
  type RedirectPort,
  type StillWindow,
} from "./redirect.js";
import { createReapplyObserver, type Scheduler } from "./observer.js";

// The document_start orchestrator. It wires the engine to a live page: reads settings from the
// SettingsCache's SYNCHRONOUS snapshot (never awaiting the adapter on the apply path), hooks SPA
// navigation + a MutationObserver, performs the Shorts redirect, and toggles the root class.
//
// Flash correctness (KTD2): the root class `still-active` is added ONLY when a service is on and
// the host unpaused, and ONLY after hydration — so an off/paused user never has the class added at
// document_start, and never sees static chrome hidden-then-revealed. An on-user shares the same
// brief pre-hydration window (symmetric and honest).

export interface ContentScriptDeps {
  readonly win: StillWindow;
  readonly doc: Document;
  readonly ruleSet: SignedRuleSet;
  readonly cache: SettingsCache;
  readonly entitlement?: EntitlementCache;
  /** Override the redirect mechanism (tests inject a spy; default is location.replace). */
  readonly redirectPort?: RedirectPort;
  /** Canonical placeholder copy from U9 strings; falls back to the engine default. */
  readonly placeholderLine?: string;
  /** Copy for a whole-site block (TikTok); falls back to the engine default. */
  readonly blockedLine?: string;
  /** Override the observer's coalescing scheduler (tests pass a synchronous one). */
  readonly schedule?: Scheduler;
  /** Override URL parsing for a focused hot-path test; production uses the platform URL parser. */
  readonly urlFactory?: (href: string) => URL;
  /**
   * Shared redirect-dedup cell. Entrypoints that also fire earlyShortsRedirect pass the SAME cell
   * to both, so the early hard-nav redirect and the post-hydration reapply never issue two
   * location.replace calls for one navigation (the second cancels/restarts the identical pending
   * navigation — wasted work, and a regression from the old shared-lastRedirect invariant).
   */
  readonly redirectDedupe?: RedirectDedupe;
  /**
   * True when the packaged manifest CSS was generated from THIS rule set (source === "bundled"),
   * so every `hide` surface is already owned by the CSS engine and the per-frame reapply only
   * needs `remove` actions (the hot-path win on infinite feeds). Must be false/omitted when a
   * fetched/cached rule set is applied — its hide selectors aren't in the packaged CSS.
   */
  readonly manifestCssOwnsHides?: boolean;
}

export interface ContentScriptHandle {
  start(): Promise<void>;
  stop(): void;
  reapply(): void;
}

export function createContentScript(deps: ContentScriptDeps): ContentScriptHandle {
  const { win, doc, ruleSet, cache } = deps;
  const redirectPort = deps.redirectPort ?? locationRedirectPort(win);
  const placeholderLine = deps.placeholderLine ?? STILL_PLACEHOLDER_LINE;
  const blockedLine = deps.blockedLine ?? STILL_BLOCKED_LINE;

  let hydrated = false;
  let stopped = false;
  let lastHref: string | null = null;
  let lastUrl: URL | null = null;
  const dedupe = deps.redirectDedupe ?? { lastRedirect: null };
  const pageSession = createEnginePageSession(ruleSet);
  const teardowns: Array<() => void> = [];

  const setRootActive = (active: boolean): void => {
    doc.documentElement?.classList.toggle(ROOT_ACTIVE_CLASS, active);
  };
  const setRootProActive = (active: boolean): void => {
    doc.documentElement?.classList.toggle(ROOT_PRO_ACTIVE_CLASS, active);
  };

  const currentUrl = (): URL => {
    const href = win.location.href;
    if (href !== lastHref) {
      lastHref = href;
      lastUrl = deps.urlFactory?.(href) ?? new URL(href);
    }
    return lastUrl!;
  };

  const reapply = (): void => {
    // Never act on optimistic defaults: until hydration we don't know the user's real toggles, so
    // we add nothing (off/paused users must not see content hidden-then-revealed).
    if (stopped || !hydrated) return;
    const url = currentUrl();
    // The paid tier is dormant behind PAID_TIER_ENABLED, so every surface applies for everyone.
    // The switch is read synchronously, before the cached entitlement, so blocking never waits on
    // an account, a receipt, or a network answer. Turn the switch on and the original behavior
    // returns: a missing entitlement source fails CLOSED to free rather than granting Pro, because
    // the app-webview path gates Pro through UiController.entitled instead of here.
    const pro = !PAID_TIER_ENABLED || (deps.entitlement?.current() ?? false);
    const opts = { pro };
    const settings = cache.current();
    const decision = pageSession.evaluate(settings, url, opts);
    switch (decision.kind) {
      case "redirect":
        setRootProActive(pro);
        if (dedupe.lastRedirect !== decision.url) {
          dedupe.lastRedirect = decision.url;
          redirectPort.replace(decision.url);
        }
        return;
      case "placeholder":
        setRootActive(false);
        setRootProActive(false);
        renderPlaceholder(doc, decision.blocked ? blockedLine : placeholderLine);
        return;
      case "apply":
        setRootActive(true);
        setRootProActive(pro);
        (deps.manifestCssOwnsHides ? pageSession.applyRemovals : pageSession.applyDom)(settings, url, doc, opts);
        return;
      case "noop":
        setRootActive(false);
        setRootProActive(false);
        return;
    }
  };

  return {
    async start(): Promise<void> {
      if (stopped) return;
      // Install hooks synchronously at document_start; their reapply calls are no-ops until hydrated.
      teardowns.push(installNavigationHooks(win, reapply));
      const observer = createReapplyObserver(win, doc, reapply, deps.schedule);
      observer.start();
      teardowns.push(() => observer.stop());
      teardowns.push(cache.subscribe(() => reapply()));
      if (deps.entitlement) teardowns.push(deps.entitlement.subscribe(() => reapply()));

      // The one and only async step: hydrate the snapshot, then apply with real settings and keep
      // reacting to external (cross-context / cloud) writes.
      await Promise.all([cache.hydrate(), deps.entitlement?.hydrate()]);
      if (stopped) return;
      teardowns.push(cache.watch());
      if (deps.entitlement) teardowns.push(deps.entitlement.watch());
      hydrated = true;
      reapply();
    },
    stop(): void {
      stopped = true;
      while (teardowns.length) teardowns.pop()!();
    },
    reapply,
  };
}

function isYouTubeShortsUrl(url: URL): boolean {
  return url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com")
    ? url.pathname.startsWith("/shorts/")
    : false;
}

/** Mutable dedup cell shared between earlyShortsRedirect and createContentScript (one per page). */
export interface RedirectDedupe {
  lastRedirect: string | null;
}

export interface EarlyShortsRedirectDeps {
  readonly win: StillWindow;
  /** The BUNDLED seed — synchronously available at document_start. The Shorts redirect surface is
   * always-free and always in the seed, so this path never needs the cached/fetched rule set. */
  readonly ruleSet: SignedRuleSet;
  /** The SAME cache instance the content script uses — its hydrate here warms the snapshot too. */
  readonly cache: SettingsCache;
  readonly redirectPort?: RedirectPort;
  /** Pass the SAME cell to createContentScript so early + reapply never double-replace. */
  readonly redirectDedupe?: RedirectDedupe;
}

/**
 * The hard-navigation Shorts redirect for extensions with no network-layer DNR (Safari always;
 * Firefox, which lacks the regexSubstitution DNR redirect). The entrypoint fires this BEFORE (and
 * concurrently with) the cached-ruleset storage read, so a direct/cold navigation to
 * m.youtube.com/shorts/<id> redirects after ONE settings read — well before the page can hydrate
 * and start playing, and strictly earlier than the ruleset-gated apply path.
 *
 * Unlike the pre-hydration variant this replaces, it awaits the persisted settings first: a user
 * who disabled Still or turned YouTube off must NOT be redirected — that navigation can't be
 * undone after the fact (Codex findings on PRs #29/#36). (Legacy per-site pauses are neutralized
 * at the parse choke point since the pause UI was removed, so they never reach this evaluate.)
 */
export async function earlyShortsRedirect(deps: EarlyShortsRedirectDeps): Promise<void> {
  if (!isYouTubeShortsUrl(new URL(deps.win.location.href))) return;
  await deps.cache.hydrate();
  // Re-read the URL: an SPA/script navigation during the await means the captured URL is stale,
  // and firing location.replace from it would be exactly the irreversible-navigation class this
  // path exists to avoid. The post-hydration reapply owns whatever URL is current now.
  const url = new URL(deps.win.location.href);
  if (!isYouTubeShortsUrl(url)) return;
  const decision = evaluate(deps.ruleSet, deps.cache.current(), url, { pro: false });
  if (decision.kind !== "redirect") return;
  const dedupe = deps.redirectDedupe;
  if (dedupe) {
    if (dedupe.lastRedirect === decision.url) return;
    dedupe.lastRedirect = decision.url;
  }
  const redirectPort = deps.redirectPort ?? locationRedirectPort(deps.win);
  redirectPort.replace(decision.url);
}

export {
  installNavigationHooks,
  locationRedirectPort,
  type RedirectPort,
  type StillWindow,
} from "./redirect.js";
export { createReapplyObserver, type ObserverHandle, type Scheduler } from "./observer.js";
export {
  createExtensionContentEntry,
  type ExtensionContentContext,
  type ExtensionContentEntryDeps,
  type ExtensionContentNudge,
} from "./extension-entry.js";
