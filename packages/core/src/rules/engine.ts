import { FEATURE_REGISTRY, PAID_TIER_ENABLED, type ServiceId, type SignedRuleSet, type SignedRuleSetV2, type SettingsV2, type BenefitId, type BenefitAccessSnapshot, type StillSettings } from "@still/shared-types";
import { resolveService, etldPlusOne, applyRedirectTemplate, urlMatchesPattern } from "./match.js";

import { validateRuleSetV2 } from "./schema.js";
import { accessCapabilities, initialAccessSnapshot, isBenefitEffective } from "../entitlement/access-policy.js";
import { extrasRouteMatches, resolveExtrasRoute, type ExtrasRouteTable } from "./extras.js";
import { YOUTUBE_EXTRAS } from "./youtube-extras.js";
import { INSTAGRAM_EXTRAS } from "./instagram-extras.js";
import { FACEBOOK_EXTRAS } from "./facebook-extras.js";

// The framework-agnostic rule engine. Pure functions over a rule set + settings + a DOM, so the
// whole thing is unit-testable in jsdom without a browser. The content script (U7) owns side
// effects that the engine cannot (navigation); the engine owns the DOM mutations and decisions.

/** Root class the content script toggles on <html>; manifest CSS scopes hide rules under it (KTD2). */
export const ROOT_ACTIVE_CLASS = "still-active";
export const ROOT_PRO_ACTIVE_CLASS = "still-pro-active";

/**
 * Prefix of the root class naming the service whose rules are in force, e.g. `still-service-youtube`.
 *
 * The packaged stylesheets are declared once in the manifest and are therefore injected on all four
 * services, so without this class every service's hide selectors are live on every service's pages.
 * That is not hypothetical: Instagram's `a[aria-label*="reels" i]` matched seven ordinary long-form
 * results on a YouTube search for "fishing reels". The JavaScript sweep has always been scoped to
 * the page's own service; this class gives the CSS the same scope.
 *
 * `gen-content-css.mjs` writes the same prefix into every generated rule, and a contract test pins
 * the two together, because the generator is plain Node and cannot import this constant.
 */
export const ROOT_SERVICE_CLASS_PREFIX = "still-service-";

/** The root class that scopes packaged CSS to one service's pages. */
export function rootServiceClass(serviceId: ServiceId): string {
  return `${ROOT_SERVICE_CLASS_PREFIX}${serviceId}`;
}

/** Default on-page placeholder copy. U9 passes the canonical string; this is the fallback. */
export const STILL_PLACEHOLDER_LINE = "Still cleared this away.";

/** Placeholder copy for a whole-site block (e.g. TikTok): tells the user the page is blocked, under
 * the "Still" brand mark so it's clear Still did it. */
export const STILL_BLOCKED_LINE = "This site is blocked.";

/** What the content script should do for the current URL. Mutually exclusive per navigation.
 *  `blocked` marks a whole-site block (vs. content that was merely cleared away), so the placeholder
 *  can tell the user the page is blocked rather than show the generic cleared-content copy. */
export type Decision =
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "placeholder"; readonly blocked?: boolean }
  | { readonly kind: "apply" }
  | { readonly kind: "noop" };

export interface ApplyResult {
  readonly hidden: number;
  readonly removed: number;
}

/**
 * The URL-free half of `isServiceActive`: "this service is on globally" — the master switch AND the
 * service toggle, plus the registry's free-core choice for admitted schema2 projections. The ONE
 * predicate the engine and the ext-chromium background's DNR gate share
 * (R2), so the two can't drift. Pauses are deliberately NOT consulted here: they are host-scoped
 * (URL-dependent), and dropping them from the background gate — which used to check
 * `pauses.includes("youtube.com")` inline — is behavior-preserving in production, because
 * parseSettings normalizes stored `pauses` to [] on every reparse (the pause UI was removed
 * 2026-07-06; per-URL pauses remain isServiceActive's concern below).
 */
export function isServiceEnabledGlobally(
  settings: StillSettings,
  serviceId: ServiceId,
): boolean {
  if (!settings.globalOn || settings.services[serviceId] !== true) return false;
  if (!("schemaVersion" in settings) || settings.schemaVersion !== 2)
    return true;
  const core = FEATURE_REGISTRY.find(
    (feature) => feature.service === serviceId && feature.tier === "free",
  );
  // TikTok is a service alias, not a sites choice; its existing service gate remains sufficient.
  if (!core) return true;
  const sites = (settings as StillSettings & Partial<SettingsV2>).sites;
  return (
    !!sites &&
    typeof sites === "object" &&
    !Array.isArray(sites) &&
    sites[core.id] === true
  );
}

/** True when the current host's service is on: global on, service toggle on, and host not paused. */
export function isServiceActive(settings: StillSettings, serviceId: ServiceId, url: URL): boolean {
  return isServiceEnabledGlobally(settings, serviceId) && !isPaused(settings, url);
}

/** True when the URL's eTLD+1 is in the user's pause list. */
export function isPaused(settings: StillSettings, url: URL): boolean {
  return settings.pauses.includes(etldPlusOne(url.hostname));
}

type ServiceRules = NonNullable<SignedRuleSet["services"][ServiceId]>;

export interface EngineOptions {
  /**
   * Whether Pro-gated surfaces should apply — the ONE monetization gate (tier-based). Omitted
   * preserves the pre-monetization all-on behavior; production callers always pass it explicitly.
   * (The seed's per-surface `requiredCapability` tags are reserved authored data for a future
   * capability-based gate; the engine deliberately does not read them yet — one axis, no drift.)
   */
  readonly pro?: boolean;
  /** Committed projection and actual packaged host capabilities, never downloaded rule fields. */
  readonly access?: BenefitAccessSnapshot;
  readonly capabilities?: ReadonlySet<BenefitId>;
}

export interface EnginePageSession {
  evaluate(settings: StillSettings | SettingsV2, url: URL, opts?: EngineOptions): Decision;
  applyDom(settings: StillSettings | SettingsV2, url: URL, doc: Document, opts?: EngineOptions): ApplyResult;
  applyRemovals(settings: StillSettings | SettingsV2, url: URL, doc: Document, opts?: EngineOptions): ApplyResult;
  /** The service whose rules the last prepared inputs resolved to, or null when none applies. */
  activeServiceId(): ServiceId | null;
  debugStats(): { readonly serviceResolutions: number; readonly compiledSelectors?: number; readonly domQueries?: number; readonly retainedSiteNodes?: number; readonly rootWrites?: number };
  /** Releases owned reversible effects; format1 cleanup remains with its existing host path. */
  stop?(): void;
  /** Internal modern media adapter; matches only the currently owned, effectively hidden plan. */
  ownsHiddenMedia?(media: Element): boolean;
  activeMediaKey?(): string;
  /** Format-2 only: the features the last prepared inputs effectively hide (empty unless applying). */
  effectiveFeatures?(): readonly BenefitId[];
  /**
   * Format-2 only, after evaluate(settings, to): the same-origin home when moving from one Reel
   * viewer item to a DIFFERENT one while that service's Reels core is effective (the viewer
   * continuing into the next Reel), else null. Moving between Reels inside one Instagram
   * profile's own modal (/<user>/reel/X to /<user>/reel/Y) is profile browsing and allowed.
   * Callers apply it only to page-driven moves, never to a deliberate link activation or
   * Back/forward.
   */
  reelContinuation?(from: URL, to: URL): string | null;
}

/** Instagram's plural Reels feed viewer: /reels/<code>/ (the audio hub /reels/audio/<id>/ is not). */
const INSTAGRAM_REELS_VIEWER = /^\/reels\/((?!audio\/?$)[\w-]+)\/?$/;

/**
 * The item a Reel viewer shows, and the profile whose modal shows it (null for the global
 * viewer): Instagram /reel(s)/<code>/ or /<user>/reel/<code>/; Facebook /reel/<digits>.
 */
function reelViewerItem(
  serviceId: "instagram" | "facebook",
  url: URL,
): { readonly owner: string | null; readonly id: string } | null {
  if (serviceId === "facebook") {
    const id = /^\/reel\/(\d+)\/?$/.exec(url.pathname)?.[1];
    return id ? { owner: null, id } : null;
  }
  const global = /^\/reels?\/([\w-]+)\/?$/.exec(url.pathname);
  if (global?.[1] && global[1] !== "audio") return { owner: null, id: global[1] };
  const profile = /^\/([\w.-]+)\/reel\/([\w-]+)\/?$/.exec(url.pathname);
  return profile?.[1] && profile[2] && profile[1] !== "reels" ? { owner: profile[1], id: profile[2] } : null;
}

/**
 * Per-document pure engine session. Content scripts keep one for their resolved immutable rule
 * set; unchanged URL/settings/entitlement inputs reuse the prior navigation decision rather than
 * resolving match patterns again on every mutation frame.
 */
export function createEnginePageSession(ruleSet: SignedRuleSet | SignedRuleSetV2): EnginePageSession {
  if ("format" in ruleSet) return createFormat2PageSession(ruleSet, PACKAGED_EXTRAS_ROUTES);
  let lastSettings: StillSettings | null = null;
  let lastHref: string | null = null;
  let lastPro: boolean | undefined;
  let lastDecision: Decision | null = null;
  let lastServiceId: ServiceId | null = null;
  let lastService: ServiceRules | null = null;
  let lastSurfaces: ServiceRules["surfaces"] = [];
  let lastSweep: SweepPlan = EMPTY_SWEEP;
  let serviceResolutions = 0;

  const prepare = (settings: StillSettings, url: URL, opts: EngineOptions): void => {
    const pro = opts.pro;
    if (lastSettings === settings && lastHref === url.href && lastPro === pro) return;
    serviceResolutions++;
    lastSettings = settings;
    lastHref = url.href;
    lastPro = pro;
    const entry = resolveActiveServiceEntry(ruleSet, settings, url);
    lastServiceId = entry?.serviceId ?? null;
    lastService = entry?.rules ?? null;
    lastSurfaces = lastService?.surfaces.filter((surface) => surfaceEnabledForTier(surface, opts)) ?? [];
    lastSweep = planSweep(lastSurfaces);
    lastDecision = null;
  };

  return {
    evaluate(settings, url, opts = {}) {
      prepare(settings as StillSettings, url, opts);
      lastDecision ??= evaluatePrepared(lastService, lastSurfaces, url);
      return lastDecision;
    },
    applyDom(settings, url, doc, opts = {}) {
      prepare(settings as StillSettings, url, opts);
      return applyPreparedActions(lastService, lastSweep, doc, /* includeHide */ true);
    },
    applyRemovals(settings, url, doc, opts = {}) {
      prepare(settings as StillSettings, url, opts);
      return applyPreparedActions(lastService, lastSweep, doc, /* includeHide */ false);
    },
    activeServiceId: () => lastServiceId,
    debugStats: () => ({ serviceResolutions }),
  };
}

/**
 * The selectors of the active surfaces, deduplicated and grouped into one selector list per action.
 *
 * Built once per navigation, because the DOM sweep runs on every mutation frame of an infinite feed
 * and the selectors cannot change in between. One `querySelectorAll` per action walks the document
 * once instead of once per selector: YouTube's surfaces alone carry twenty-two selectors, and the
 * same shelf selector is authored under three surfaces because a shelf appears on three kinds of
 * page.
 *
 * Grouping also removes an ordering trap. Run one at a time against the live DOM, a wrapper
 * selector such as `ytm-rich-section-renderer:has(ytm-reel-shelf-renderer)` stops matching once an
 * earlier selector has removed the child it names, so the wrapper survives as an empty box. One
 * combined query matches everything against the document as it stands before anything is removed,
 * so the authored order no longer changes the outcome.
 */
interface SweepPlan {
  readonly hide: readonly string[];
  readonly remove: readonly string[];
  readonly hideList: string;
  readonly removeList: string;
}

const EMPTY_SWEEP: SweepPlan = { hide: [], remove: [], hideList: "", removeList: "" };

function planSweep(surfaces: ServiceRules["surfaces"]): SweepPlan {
  const hide = new Set<string>();
  const remove = new Set<string>();
  for (const surface of surfaces) {
    if (!surface.selectors) continue;
    const target = surface.action === "hide" ? hide : surface.action === "remove" ? remove : null;
    if (!target) continue;
    for (const selector of surface.selectors) target.add(selector);
  }
  const hideSelectors = [...hide];
  const removeSelectors = [...remove];
  return {
    hide: hideSelectors,
    remove: removeSelectors,
    hideList: hideSelectors.join(","),
    removeList: removeSelectors.join(","),
  };
}

export const ALWAYS_FREE_SURFACE_IDS = new Set([
  "yt-shorts-redirect",
  "yt-sidebar",
  "yt-home-shelf",
  "yt-search",
  "yt-subscriptions",
  "yt-channel-tab",
  "yt-chips",
]);

/**
 * Resolve the URL's service and confirm it is active and present in the rule set — the single place
 * `evaluate()` and `applyDom()` agree on "a valid active service". Returns the service's rules, or
 * null (unknown host / service off / paused / missing entry), which each caller maps to its own
 * early-return shape.
 */
export function resolveActiveService(
  ruleSet: SignedRuleSet,
  settings: StillSettings,
  url: URL,
): ServiceRules | null {
  return resolveActiveServiceEntry(ruleSet, settings, url)?.rules ?? null;
}

/** `resolveActiveService` plus the id, which the root service class needs. One resolution, not two. */
function resolveActiveServiceEntry(
  ruleSet: SignedRuleSet,
  settings: StillSettings,
  url: URL,
): { readonly serviceId: ServiceId; readonly rules: ServiceRules } | null {
  const serviceId = resolveService(ruleSet, url);
  if (!serviceId) return null;
  if (!isServiceActive(settings, serviceId, url)) return null;
  const rules = ruleSet.services[serviceId];
  return rules ? { serviceId, rules } : null;
}

/**
 * Decide what to do for a URL: redirect (Shorts→watch), placeholder (whole-site block, direct
 * Reels/Shorts-no-id), apply (hide/remove in-page surfaces), or noop (service off / unmatched).
 */
export function evaluate(
  ruleSet: SignedRuleSet,
  settings: StillSettings,
  url: URL,
  opts: EngineOptions = {},
): Decision {
  const service = resolveActiveService(ruleSet, settings, url);
  const surfaces = service?.surfaces.filter((s) => surfaceEnabledForTier(s, opts)) ?? [];
  return evaluatePrepared(service, surfaces, url);
}

function evaluatePrepared(
  service: ServiceRules | null,
  surfaces: ServiceRules["surfaces"],
  url: URL,
): Decision {
  if (!service || surfaces.length === 0) return { kind: "noop" };
  const path = url.pathname;

  // 1. Whole-site block (TikTok) — the page is blocked outright, not just cleared.
  if (surfaces.some((s) => s.action === "blockSite")) return { kind: "placeholder", blocked: true };

  // 2. Direct URL → placeholder (Instagram /reel(s), Facebook /reel).
  for (const s of surfaces) {
    if (s.action === "placeholder" && s.urlMatch && safeTest(s.urlMatch, path)) {
      return { kind: "placeholder" };
    }
  }

  // 3. Redirect (Shorts → watch). A matched-but-no-id path falls back to placeholder when asked.
  for (const s of surfaces) {
    if (s.action === "redirect" && s.redirect) {
      const m = safeExec(s.redirect.urlMatch, path);
      if (m) {
        if (m[1]) {
          const target = new URL(applyRedirectTemplate(s.redirect.to, m), url.origin).toString();
          return { kind: "redirect", url: target };
        }
        if (s.redirect.fallbackToPlaceholder) return { kind: "placeholder" };
      }
    }
  }

  // 4. Otherwise hide/remove the in-page short-form surfaces.
  return { kind: "apply" };
}

/** Apply `hide` (display:none) and `remove` (node deletion) surfaces for the active service. */
export function applyDom(
  ruleSet: SignedRuleSet,
  settings: StillSettings,
  url: URL,
  doc: Document,
  opts: EngineOptions = {},
): ApplyResult {
  return createEnginePageSession(ruleSet).applyDom(settings, url, doc, opts);
}

/**
 * Remove-action-only apply — the content script's per-mutation-frame fast path when the packaged
 * manifest CSS already owns every `hide` surface (i.e. the applied rule set IS the bundled one the
 * CSS was generated from). The CSS engine then hides new nodes natively, so re-running the
 * hide-selector querySelectorAll sweep over a growing feed DOM every animation frame is pure waste;
 * only `remove` genuinely needs JS. When a fetched/cached rule set is applied (selectors the
 * packaged CSS has never seen), callers must use the full applyDom instead.
 */
export function applyRemovals(
  ruleSet: SignedRuleSet,
  settings: StillSettings,
  url: URL,
  doc: Document,
  opts: EngineOptions = {},
): ApplyResult {
  return createEnginePageSession(ruleSet).applyRemovals(settings, url, doc, opts);
}

function applyPreparedActions(
  service: ServiceRules | null,
  sweep: SweepPlan,
  doc: Document,
  includeHide: boolean,
): ApplyResult {
  let hidden = 0;
  let removed = 0;
  if (!service) return { hidden, removed };

  if (includeHide && sweep.hideList) {
    for (const el of queryGroup(doc, sweep.hideList, sweep.hide)) {
      (el as HTMLElement).style?.setProperty("display", "none", "important");
      hidden++;
    }
  }
  if (sweep.removeList) {
    for (const el of queryGroup(doc, sweep.removeList, sweep.remove)) {
      el.remove();
      removed++;
    }
  }
  return { hidden, removed };
}

/**
 * One query for the whole selector list, falling back to one query per selector if the browser
 * rejects the list. A selector list is invalid as a whole if any single selector in it is, so a
 * rule set carrying a selector this browser does not understand must not cost us the rest.
 */
function queryGroup(doc: Document, list: string, selectors: readonly string[]): Element[] {
  try {
    return Array.from(doc.querySelectorAll(list));
  } catch {
    // Deduplicated so an element matched by two selectors is still counted once, as the combined
    // query would have counted it.
    const found = new Set<Element>();
    for (const selector of selectors) {
      for (const el of safeQueryAll(doc, selector)) found.add(el);
    }
    return [...found];
  }
}

function surfaceEnabledForTier(s: ServiceRules["surfaces"][number], opts: EngineOptions): boolean {
  if (!s.enabledByDefault) return false;
  // The paid tier is dormant behind PAID_TIER_ENABLED, so every enabled surface applies for
  // everyone. The tier data below stays authoritative and is what comes back when the switch does.
  if (!PAID_TIER_ENABLED) return true;
  // Free surfaces always apply: the rule data's `tier: "free"` is authoritative, and the
  // ALWAYS_FREE_SURFACE_IDS safety-net keeps the free YouTube promise even against a fetched rule
  // set with missing/stale tags (monetization principle 13). Everything else is Pro-gated.
  if (ALWAYS_FREE_SURFACE_IDS.has(s.id) || s.tier === "free") return true;
  return opts.pro !== false;
}

/** Replace the page body with the calm Still placeholder (used for placeholder/blockSite pages). */
export function renderPlaceholder(doc: Document, line: string = STILL_PLACEHOLDER_LINE): void {
  const body = doc.body;
  if (!body) return;
  // No-op when the placeholder is already up: replaceChildren is itself a childList mutation, so an
  // unconditional re-render would feed the reapply MutationObserver and spin once per frame.
  const existing = doc.getElementById("still-placeholder");
  if (existing) {
    const msg = existing.querySelector("p");
    if (msg && msg.textContent !== line) msg.textContent = line;
    return;
  }
  const root = doc.createElement("div");
  root.id = "still-placeholder";
  root.setAttribute("role", "status");
  root.style.cssText =
    "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;" +
    "justify-content:center;gap:12px;background:#ffffff;color:#0b1020;font-family:system-ui,sans-serif;z-index:2147483647;";
  // Use the app's balance mark as inline SVG so host image policies cannot block the logo.
  const svgNS = "http://www.w3.org/2000/svg";
  const mark = doc.createElementNS(svgNS, "svg");
  mark.setAttribute("viewBox", "0 0 48 48");
  mark.setAttribute("width", "64");
  mark.setAttribute("height", "64");
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", "Still");
  mark.style.cssText = "display:block;flex-shrink:0;";
  const title = doc.createElementNS(svgNS, "title");
  title.textContent = "Still";
  const tile = doc.createElementNS(svgNS, "rect");
  tile.setAttribute("width", "48");
  tile.setAttribute("height", "48");
  tile.setAttribute("rx", "13");
  tile.setAttribute("fill", "#2A47E8");
  const balance = doc.createElementNS(svgNS, "line");
  balance.setAttribute("x1", "9");
  balance.setAttribute("y1", "30");
  balance.setAttribute("x2", "39");
  balance.setAttribute("y2", "30");
  balance.setAttribute("stroke", "#fff");
  balance.setAttribute("stroke-width", "2.4");
  balance.setAttribute("stroke-linecap", "round");
  const dot = doc.createElementNS(svgNS, "circle");
  dot.setAttribute("cx", "24");
  dot.setAttribute("cy", "26.4");
  dot.setAttribute("r", "3.6");
  dot.setAttribute("fill", "#fff");
  mark.append(title, tile, balance, dot);
  const msg = doc.createElement("p");
  msg.textContent = line;
  msg.style.cssText = "margin:0;font-size:15px;opacity:0.7;";
  root.append(mark, msg);
  body.replaceChildren(root);
}

function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function safeExec(pattern: string, value: string): RegExpExecArray | null {
  try {
    return new RegExp(pattern).exec(value);
  } catch {
    return null;
  }
}

function safeQueryAll(doc: Document, selector: string): Element[] {
  try {
    return Array.from(doc.querySelectorAll(selector));
  } catch {
    return []; // a selector the engine can't parse must not abort the whole pass
  }
}

/** The compiled Still Pro extras routes, one module per service. Consulted only when effective. */
const PACKAGED_EXTRAS_ROUTES: ExtrasRouteTable = Object.freeze({
  youtube: YOUTUBE_EXTRAS.routes,
  instagram: INSTAGRAM_EXTRAS.routes,
  facebook: FACEBOOK_EXTRAS.routes,
});

/**
 * Test-only seam: a format-2 session over synthetic extras routes, for the dormancy and loop
 * tests. No shipped module imports it (a static test checks), so bundlers drop it and a shipped
 * session always uses the compiled per-service tables.
 */
export function createFormat2PageSessionForTest(ruleSet: SignedRuleSetV2, extrasRoutes: ExtrasRouteTable): EnginePageSession {
  return createFormat2PageSession(ruleSet, extrasRoutes);
}

/** The packaged host capabilities when a caller supplies none: free-only while paid is off. */
const PACKAGED_CAPABILITIES = accessCapabilities({ paidMode: PAID_TIER_ENABLED });

// The format2 branch extends the same page-session interpreter. Selection is an internal host
// seam: its caller must admit packaged or signature-verified data; loaders/seeds remain format1.
// Root-scoped CSS owns hides, including inserted and recycled nodes, without touching renderer
// children/styles/listeners or scanning the document on each mutation. Navigation/media adapters
// and the approved TikTok blocked screen remain separate U7/service integration boundaries.
let format2Sequence = 0;
function createFormat2PageSession(input: unknown, extrasRoutes: ExtrasRouteTable): EnginePageSession {
  const admitted = validateRuleSetV2(input);
  if (!admitted.ok) throw new Error("Invalid format2 interpreter input");
  const ruleSet = admitted.value;
  const scope = `still-feature-${++format2Sequence}`;
  const featureClass = (benefit: BenefitId): string => `${scope}-${benefit.replace(".", "-")}`;
  const plans = new Map<ServiceId, Map<BenefitId, readonly string[]>>();
  // Owned CSS rules per service and feature. The stylesheet text is composed from the EFFECTIVE
  // features only, in plan order, so a dormant or Off feature adds no rules (no style recalculation
  // cost and no bytes) to a page; with only the free core effective the text is exactly the
  // free-only text.
  const css = new Map<ServiceId, Map<BenefitId, readonly string[]>>();
  // Every feature the service's session can make effective: hide plan features, then features
  // that only route. The predicate below decides which of them actually apply.
  const candidates = new Map<ServiceId, readonly BenefitId[]>();
  let compiledSelectors = 0;
  for (const [id, service] of Object.entries(ruleSet.services)) {
    if (!service) continue;
    const selectors = new Map<BenefitId, Set<string>>();
    for (const surface of service.surfaces) {
      const selected = selectors.get(surface.feature) ?? new Set<string>();
      if (surface.action === "hide") for (const selector of surface.selectors) selected.add(selector);
      selectors.set(surface.feature, selected);
    }
    const plan = new Map([...selectors].map(([benefit, values]) => [benefit, [...values]] as const));
    plans.set(id as ServiceId, plan);
    const rules = new Map<BenefitId, readonly string[]>();
    for (const [benefit, values] of plan) {
      compiledSelectors += values.length;
      // :is() keeps EVERY comma-list branch below the same owned feature gate. One rule per
      // selector lets a browser reject unsupported syntax without discarding its neighbours.
      rules.set(benefit, values.map(selector => `.${featureClass(benefit)} :is(${selector}){display:none!important}`));
    }
    css.set(id as ServiceId, rules);
    const routeOnly = (extrasRoutes[id as ServiceId] ?? []).map(route => route.feature).filter(feature => !plan.has(feature));
    candidates.set(id as ServiceId, [...new Set([...plan.keys(), ...routeOnly])]);
  }
  const defaultAccess = initialAccessSnapshot();
  let stopped = false, serviceResolutions = 0, rootWrites = 0;
  let previousSettings: StillSettings | SettingsV2 | null = null;
  let previousHref: string | null = null;
  let previousAccess: BenefitAccessSnapshot | null = null;
  let previousCapabilities = "";
  let serviceId: ServiceId | null = null;
  let coreEffective = false;
  let effective: readonly BenefitId[] = [];
  let styleText = "";
  let decision: Decision = { kind: "noop" };
  let ownedRoot: Element | null = null;
  let ownedStyle: HTMLStyleElement | null = null;
  const ownedClasses = new Set<string>();
  const clearEffects = (): void => {
    for (const name of ownedClasses) { ownedRoot?.classList.remove(name); rootWrites++; }
    ownedClasses.clear(); ownedStyle?.remove(); ownedStyle = null; ownedRoot = null;
  };
  const prepare = (settings: StillSettings | SettingsV2, url: URL, opts: EngineOptions): void => {
    if (stopped) return;
    const access = opts.access ?? defaultAccess;
    const capabilities = opts.capabilities ?? PACKAGED_CAPABILITIES;
    const capabilityKey = [...candidates.values()].flat().map(benefit => `${benefit}:${capabilities.has(benefit)}`).join("|");
    if (settings === previousSettings && url.href === previousHref && access === previousAccess && capabilityKey === previousCapabilities) return;
    previousSettings = settings; previousHref = url.href; previousAccess = access; previousCapabilities = capabilityKey;
    serviceResolutions++; serviceId = null; coreEffective = false; effective = []; styleText = ""; decision = { kind: "noop" };
    // No feature defaults/migration are invented by the engine. It consumes only the writer's
    // current schema2 projection; a legacy/unresolved model leaves this dormant lane held.
    if (!("schemaVersion" in settings) || settings.schemaVersion !== 2 || !settings.sites) return;
    for (const [id, service] of Object.entries(ruleSet.services)) {
      if (service?.matches.some(pattern => urlMatchesPattern(url, pattern))) { serviceId = id as ServiceId; break; }
    }
    if (!serviceId || (Array.isArray(settings.pauses) && settings.pauses.includes(etldPlusOne(url.hostname)))) return;
    const service = serviceId;
    effective = (candidates.get(service) ?? []).filter(benefit =>
      isBenefitEffective(settings as SettingsV2, benefit, access.states[benefit], capabilities.has(benefit)));
    styleText = effective.flatMap(benefit => css.get(service)?.get(benefit) ?? []).join("\n");
    decision = effective.length === 0 ? { kind: "noop" } : effective.includes("tiktok.all") ? { kind: "placeholder", blocked: true } : { kind: "apply" };
    // Routing semantics are compiled here, never accepted from downloaded selector data.
    // Use the same committed predicate and registry core ownership as reversible hides.
    const core = FEATURE_REGISTRY.find(feature => feature.service === serviceId && feature.tier === "free")?.id;
    coreEffective = !!core && isBenefitEffective(settings as SettingsV2, core, access.states[core], capabilities.has(core));
    const coreRoute = (target: URL): URL | null => {
      const destination = coreEffective ? coreDestination(service, target) : null;
      return destination && destination.href !== target.href ? destination : null;
    };
    const routed = coreRoute(url);
    if (routed) decision = { kind: "redirect", url: routed.href };
    else if (decision.kind === "apply") {
      // Extras routes run only after the free core declined this URL, so they can never shadow it,
      // and each entry is consulted only while its own feature is effective.
      const routes = extrasRoutes[service] ?? [];
      const extra = resolveExtrasRoute(routes, url, effective,
        destination => coreRoute(destination) !== null || extrasRouteMatches(routes, destination, effective));
      if (extra) decision = { kind: "redirect", url: extra.href };
    }
  };
  /** The free core's compiled destination for `url`, or null; the caller checks it is effective. */
  function coreDestination(service: ServiceId, url: URL): URL | null {
    let destination: URL | null = null;
    if (service === "youtube") {
      const id = /^\/shorts\/([\w-]+)\/?$/.exec(url.pathname)?.[1];
      if (id) {
        destination = new URL(url.href);
        destination.pathname = "/watch";
        // Preserve deliberate playlist, time and share context; normalize only the video ID.
        destination.searchParams.set("v", id);
      }
    } else if (((service === "instagram" || service === "facebook") && /^\/reels\/?$/.test(url.pathname))
      || (service === "facebook" && /^\/watch\/reels\/?$/.test(url.pathname))) {
      // Category browsing only: the bare Reels feeds and Facebook's own Reels feed under
      // Watch. Direct/shared singular /reel/<id>, a Page's or profile's own Reels tab,
      // normal/live videos, people/groups/search/messages and their query-bearing routes stay
      // usable.
      destination = new URL("/", url.origin);
    } else if (service === "instagram" && INSTAGRAM_REELS_VIEWER.test(url.pathname)) {
      // Instagram's plural /reels/<code>/ feed viewer opens that same Reel at Instagram's own
      // shared-Reel address, /reel/<code>/ (query and fragment kept); the continuation guard
      // then stops it advancing into another Reel.
      destination = new URL(url.href);
      destination.pathname = `/reel/${INSTAGRAM_REELS_VIEWER.exec(url.pathname)![1]}/`;
    }
    return destination;
  }
  const apply = (settings: StillSettings | SettingsV2, url: URL, doc: Document, opts: EngineOptions): ApplyResult => {
    prepare(settings, url, opts);
    if (stopped) return { hidden: 0, removed: 0 };
    const root = doc.documentElement;
    if (decision.kind !== "apply" || !root || !serviceId) { clearEffects(); return { hidden: 0, removed: 0 }; }
    if (ownedRoot !== root) { clearEffects(); ownedRoot = root; }
    // Route-only features own no CSS, so they never add a root class.
    const desired = new Set(effective.filter(benefit => plans.get(serviceId!)?.has(benefit)).map(featureClass));
    for (const name of ownedClasses) {
      if (!desired.has(name)) { root.classList.remove(name); ownedClasses.delete(name); rootWrites++; }
    }
    for (const name of desired) {
      if (!root.classList.contains(name)) { root.classList.add(name); ownedClasses.add(name); rootWrites++; }
    }
    ownedStyle ??= doc.createElement("style");
    if (ownedStyle.textContent !== styleText) ownedStyle.textContent = styleText;
    if (!ownedStyle.isConnected) (doc.head ?? root).append(ownedStyle);
    // Counts describe explicit JS node effects. Native CSS matching is intentionally not counted
    // or instrumented per target, and there is no retained site-node collection.
    return { hidden: 0, removed: 0 };
  };
  return {
    evaluate(settings, url, opts = {}) { prepare(settings, url, opts); return stopped ? { kind: "noop" } : decision; },
    applyDom(settings, url, doc, opts = {}) { return apply(settings, url, doc, opts); },
    applyRemovals(settings, url, doc, opts = {}) { return apply(settings, url, doc, opts); },
    activeServiceId: () => stopped ? null : serviceId,
    effectiveFeatures: () => stopped || decision.kind !== "apply" ? [] : effective,
    reelContinuation(from, to) {
      // Valid only for the inputs just prepared for `to`, while that service's Reels core is on.
      if (stopped || !coreEffective || previousHref !== to.href || from.origin !== to.origin) return null;
      if (serviceId !== "instagram" && serviceId !== "facebook") return null;
      const current = reelViewerItem(serviceId, from);
      const next = reelViewerItem(serviceId, to);
      if (!current || !next || current.id === next.id) return null;
      // One profile's own Reels modal: profile browsing, not the global viewer advancing.
      if (current.owner !== null && current.owner === next.owner) return null;
      return new URL("/", to.origin).href;
    },
    activeMediaKey: () => !stopped && decision.kind === "apply" && ownedStyle?.isConnected && ownedStyle.sheet && !ownedStyle.sheet.disabled && serviceId
      ? `${serviceId}:${effective.filter(benefit => (plans.get(serviceId!)?.get(benefit)?.length ?? 0) > 0).join("|")}` : "",
    ownsHiddenMedia(media) {
      if (stopped || decision.kind !== "apply" || !serviceId || !ownedRoot || !ownedStyle?.isConnected || !ownedStyle.sheet || ownedStyle.sheet.disabled || !media.isConnected || media.ownerDocument !== ownedRoot.ownerDocument) return false;
      const view = media.ownerDocument.defaultView;
      if (!view) return false;
      for (const benefit of effective) {
        if (!ownedRoot.classList.contains(featureClass(benefit))) continue;
        for (const selector of plans.get(serviceId)?.get(benefit) ?? []) {
          try {
            // Exactly the selector branch/scope used by our CSS, including comma lists and
            // nearest-card preservation. A failed/CSP-blocked style never grants a pause.
            const target = media.closest(`.${featureClass(benefit)} :is(${selector})`);
            if (target && view.getComputedStyle(target).display === "none") return true;
          } catch { /* unsupported selector fails open, as its CSS rule does */ }
        }
      }
      return false;
    },
    debugStats: () => ({ serviceResolutions, compiledSelectors, domQueries: 0, retainedSiteNodes: 0, rootWrites }),
    stop() { stopped = true; effective = []; serviceId = null; clearEffects(); },
  };
}
