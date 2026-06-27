import type { SignedRuleSet } from "@still/shared-types";
import {
  evaluate,
  applyDom,
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
  /**
   * Safari has no network-layer DNR redirect. Let Safari opt into a synchronous, best-effort
   * YouTube Shorts redirect using the cache's current snapshot before async storage hydration.
   */
  readonly redirectBeforeHydration?: boolean;
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
  let lastRedirect: string | null = null;
  const teardowns: Array<() => void> = [];

  const setRootActive = (active: boolean): void => {
    doc.documentElement?.classList.toggle(ROOT_ACTIVE_CLASS, active);
  };
  const setRootProActive = (active: boolean): void => {
    doc.documentElement?.classList.toggle(ROOT_PRO_ACTIVE_CLASS, active);
  };

  const reapply = (): void => {
    // Never act on optimistic defaults: until hydration we don't know the user's real toggles, so
    // we add nothing (off/paused users must not see content hidden-then-revealed).
    if (!hydrated) return;
    const url = new URL(win.location.href);
    // Fail CLOSED on the monetization gate: with no entitlement source wired we treat the user as
    // free (Pro surfaces stay visible) rather than granting Pro by default. Both extensions pass an
    // EntitlementCache; the app-webview path gates Pro via UiController.entitled, not here. A caller
    // that genuinely wants all surfaces must pass InMemoryEntitlementAdapter(true) explicitly.
    const pro = deps.entitlement?.current() ?? false;
    const opts = { pro };
    const decision = evaluate(ruleSet, cache.current(), url, opts);
    switch (decision.kind) {
      case "redirect":
        setRootProActive(pro);
        if (lastRedirect !== decision.url) {
          lastRedirect = decision.url;
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
        applyDom(ruleSet, cache.current(), url, doc, opts);
        return;
      case "noop":
        setRootActive(false);
        setRootProActive(false);
        return;
    }
  };

  const redirectCurrentShortsUrl = (): void => {
    const url = new URL(win.location.href);
    if (!isYouTubeShortsUrl(url)) return;
    const decision = evaluate(ruleSet, cache.current(), url, { pro: false });
    if (decision.kind !== "redirect") return;
    if (lastRedirect === decision.url) return;
    lastRedirect = decision.url;
    redirectPort.replace(decision.url);
  };

  return {
    async start(): Promise<void> {
      if (deps.redirectBeforeHydration) redirectCurrentShortsUrl();

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
      cache.watch();
      deps.entitlement?.watch();
      hydrated = true;
      reapply();
    },
    stop(): void {
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

export {
  installNavigationHooks,
  locationRedirectPort,
  type RedirectPort,
  type StillWindow,
} from "./redirect.js";
export { createReapplyObserver, type ObserverHandle, type Scheduler } from "./observer.js";
