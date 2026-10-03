import { PAID_TIER_ENABLED, type ServiceId, type SignedRuleSet, type SignedRuleSetV2, type BenefitId } from "@still/shared-types";
import { initialAccessSnapshot } from "../entitlement/access-policy.js";
import { createFeatureMediaQuieting } from "./feature-media.js";
import {
  evaluate,
  createEnginePageSession,
  renderPlaceholder,
  rootServiceClass,
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
  /** Internal opt-in for an already admitted packaged/signed format2 rule set. */
  readonly ruleSetV2?: SignedRuleSetV2;
  readonly capabilities?: ReadonlySet<BenefitId>;
  /** Trusted host adapter for the approved TikTok screen; absent means that action stays held. */
  readonly handleBlockedNavigation?: (target: URL) => boolean;
  readonly cache: SettingsCache;
  readonly entitlement?: EntitlementCache;
  /** Override destination navigation; default preserves native push/replacement history intent. */
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
  let started = false;
  let stopped = false;
  let lastHref: string | null = null;
  let lastUrl: URL | null = null;
  const dedupe = deps.redirectDedupe ?? { lastRedirect: null };
  const modern = deps.ruleSetV2 !== undefined;
  const pageSession = createEnginePageSession(deps.ruleSetV2 ?? ruleSet);
  const fallbackAccess = initialAccessSnapshot();
  const teardowns: Array<() => void> = [];
  const shortsChipRule = ruleSet.services.youtube?.surfaces.find((s) => s.id === "yt-chips");
  let resetShortsFilterRequested = false;
  let shortsFilterSearch: string | null = null;

  const prepareYouTubeChips = (url: URL): void => {
    if (!shortsChipRule?.enabledByDefault || shortsChipRule.action !== "hide"
      || !shortsChipRule.selectors?.includes("yt-chip-cloud-chip-renderer[data-still-shorts-chip]")) return;
    const search = `${url.pathname}\n${url.searchParams.get("search_query") ?? ""}`;
    if (shortsFilterSearch !== search) resetShortsFilterRequested = false;
    shortsFilterSearch = search;
    let selectedShorts: Element | null = null;
    let selectedOtherChip = false;
    for (const chip of doc.querySelectorAll("yt-chip-cloud-chip-renderer")) {
      const tab = chip.querySelector<HTMLElement>('[role="tab"]');
      const isShorts = tab?.textContent?.trim() === "Shorts";
      // Current YouTube chips expose a tab label, not the title attribute the older rule used.
      // Keep hiding in the rule set so root-class changes restore the chip when blocking is off.
      chip.toggleAttribute("data-still-shorts-chip", isShorts);
      if (chip.hasAttribute("selected") || tab?.getAttribute("aria-selected") === "true") {
        if (isShorts) selectedShorts = chip;
        else selectedOtherChip = true;
      }
    }
    if (!selectedShorts) {
      // A missing bar is not confirmation: YouTube can replace it while All is still loading.
      if (selectedOtherChip) resetShortsFilterRequested = false;
      return;
    }
    if (resetShortsFilterRequested || url.pathname !== "/results") return;
    const bar = selectedShorts.closest("yt-chip-cloud-renderer");
    const all = Array.from(bar?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
      .find((tab) => tab.textContent?.trim() === "All");
    if (all) {
      // Removing every result leaves YouTube's continuation trigger in view. Leave Shorts-only
      // search through its own All control once, even if the response is slow or fails.
      resetShortsFilterRequested = true;
      all.click();
    }
  };

  const setRootActive = (active: boolean): void => {
    doc.documentElement?.classList.toggle(ROOT_ACTIVE_CLASS, active);
  };
  const setRootProActive = (active: boolean): void => {
    doc.documentElement?.classList.toggle(ROOT_PRO_ACTIVE_CLASS, active);
  };
  // Names the service whose packaged CSS may apply here. The stylesheets are declared once in the
  // manifest, so all four services' selectors reach every page; without this class Instagram's
  // Reels rules hide YouTube results whose title happens to contain "reels".
  let rootServiceApplied: string | null = null;
  const setRootService = (serviceId: ServiceId | null): void => {
    const next = serviceId === null ? null : rootServiceClass(serviceId);
    if (next === rootServiceApplied) return;
    const classes = doc.documentElement?.classList;
    if (!classes) return;
    if (rootServiceApplied !== null) classes.remove(rootServiceApplied);
    if (next !== null) classes.add(next);
    rootServiceApplied = next;
  };

  const currentUrl = (): URL => {
    const href = win.location.href;
    if (href !== lastHref) {
      lastHref = href;
      lastUrl = deps.urlFactory?.(href) ?? new URL(href);
    }
    return lastUrl!;
  };

  const modernOptions = () => ({
    access: deps.entitlement?.currentAccessSnapshot() ?? fallbackAccess,
    capabilities: deps.capabilities,
  });
  const mediaQuieting = modern ? createFeatureMediaQuieting({
    doc,
    activeKey: () => stopped || !hydrated ? "" : pageSession.activeMediaKey?.() ?? "",
    isHidden: media => {
      if (stopped || !hydrated) return false;
      pageSession.evaluate(cache.current(), currentUrl(), modernOptions());
      return pageSession.ownsHiddenMedia?.(media) === true;
    },
  }) : null;
  if (mediaQuieting) teardowns.push(() => mediaQuieting.stop());
  const consumeModernNavigation = (
    target: URL,
    mode: "push" | "replace" = "replace",
  ): boolean => {
    // Synchronous committed state only. A pre-hydration or stopped host never guesses On.
    if (!modern || stopped || !hydrated) return false;
    const settings = cache.current();
    const options = modernOptions();
    const decision = pageSession.evaluate(settings, target, options);
    // Destination classification must not replace the plan backing the current DOM/media.
    // A consumed, canceled or failed navigation may never commit its prospective URL.
    pageSession.evaluate(settings, currentUrl(), options);
    if (decision.kind === "redirect" && decision.url !== target.href) {
      if (
        decision.url !== win.location.href &&
        dedupe.lastRedirect !== decision.url
      ) {
        dedupe.lastRedirect = decision.url;
        if (mode === "push") redirectPort.replace(decision.url, "push");
        else redirectPort.replace(decision.url);
      }
      return true;
    }
    dedupe.lastRedirect = null;
    // This is an internal decision only, never the old body-replacing placeholder UI.
    return (
      decision.kind === "placeholder" &&
      decision.blocked === true &&
      deps.handleBlockedNavigation?.(target) === true
    );
  };

  const reapply = (): void => {
    // Never act on optimistic defaults: until hydration we don't know the user's real toggles, so
    // we add nothing (off/paused users must not see content hidden-then-revealed).
    if (stopped || !hydrated) return;
    const url = currentUrl();
    if (modern) {
      // The existing cache is the committed authority. No account/storage read or legacy
      // service-wide CSS grant occurs on this path; CSS handles recycled nodes itself.
      pageSession.applyDom(cache.current(), url, doc, modernOptions());
      mediaQuieting?.reconcile();
      consumeModernNavigation(url);
      return;
    }
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
        setRootService(pageSession.activeServiceId());
        setRootProActive(pro);
        if (dedupe.lastRedirect !== decision.url) {
          dedupe.lastRedirect = decision.url;
          redirectPort.replace(decision.url);
        }
        return;
      case "placeholder":
        setRootActive(false);
        setRootProActive(false);
        setRootService(null);
        renderPlaceholder(doc, decision.blocked ? blockedLine : placeholderLine);
        return;
      case "apply":
        setRootService(pageSession.activeServiceId());
        setRootActive(true);
        setRootProActive(pro);
        if (pageSession.activeServiceId() === "youtube") prepareYouTubeChips(url);
        (deps.manifestCssOwnsHides ? pageSession.applyRemovals : pageSession.applyDom)(settings, url, doc, opts);
        return;
      case "noop":
        resetShortsFilterRequested = false;
        setRootActive(false);
        setRootProActive(false);
        setRootService(null);
        return;
    }
  };

  return {
    async start(): Promise<void> {
      if (stopped || started) return;
      started = true;
      // Install hooks synchronously at document_start; their reapply calls are no-ops until hydrated.
      teardowns.push(installNavigationHooks(
        win, reapply, modern ? consumeModernNavigation : undefined, modern ? doc : undefined,
      ));
      if (!modern) {
        const observer = createReapplyObserver(win, doc, reapply, deps.schedule);
        observer.start();
        teardowns.push(() => observer.stop());
      } else {
        doc.addEventListener("DOMContentLoaded", reapply, { once: true });
        teardowns.push(() => doc.removeEventListener("DOMContentLoaded", reapply));
      }
      teardowns.push(cache.subscribe(() => reapply()));
      if (deps.entitlement) teardowns.push(modern
        ? deps.entitlement.subscribeAccess(() => reapply())
        : deps.entitlement.subscribe(() => reapply()));

      // Modern snapshots retain atomic ordering across hydration and external writes.
      // Listen first so a newer committed Off cannot be lost during a held older read.
      if (modern) teardowns.push(cache.watch());
      await Promise.all([cache.hydrate(), modern ? undefined : deps.entitlement?.hydrate()]);
      if (stopped) return;
      if (!modern) teardowns.push(cache.watch());
      if (deps.entitlement) teardowns.push(deps.entitlement.watch());
      hydrated = true;
      reapply();
      if (modern && deps.entitlement) void deps.entitlement.refreshAccess();
    },
    stop(): void {
      stopped = true;
      while (teardowns.length) teardowns.pop()!();
      pageSession.stop?.();
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
