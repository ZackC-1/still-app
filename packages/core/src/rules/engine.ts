import type { ServiceId, SignedRuleSet, StillSettings } from "@still/shared-types";
import { resolveService, etldPlusOne, applyRedirectTemplate } from "./match.js";

// The framework-agnostic rule engine. Pure functions over a rule set + settings + a DOM, so the
// whole thing is unit-testable in jsdom without a browser. The content script (U7) owns side
// effects that the engine cannot (navigation); the engine owns the DOM mutations and decisions.

/** Root class the content script toggles on <html>; manifest CSS scopes hide rules under it (KTD2). */
export const ROOT_ACTIVE_CLASS = "still-active";

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

/** True when the current host's service is on: global on, service toggle on, and host not paused. */
export function isServiceActive(settings: StillSettings, serviceId: ServiceId, url: URL): boolean {
  if (!settings.globalOn) return false;
  if (settings.services[serviceId] !== true) return false; // absent/brand-new service ⇒ off
  return !isPaused(settings, url);
}

/** True when the URL's eTLD+1 is in the user's pause list. */
export function isPaused(settings: StillSettings, url: URL): boolean {
  return settings.pauses.includes(etldPlusOne(url.hostname));
}

type ServiceRules = NonNullable<SignedRuleSet["services"][ServiceId]>;

export interface EngineOptions {
  /** Whether Pro-gated surfaces should apply. Omitted preserves the pre-monetization all-on behavior. */
  readonly pro?: boolean;
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
  const serviceId = resolveService(ruleSet, url);
  if (!serviceId) return null;
  if (!isServiceActive(settings, serviceId, url)) return null;
  return ruleSet.services[serviceId] ?? null;
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
  if (!service) return { kind: "noop" };

  const surfaces = service.surfaces.filter((s) => surfaceEnabledForTier(s, opts));
  if (surfaces.length === 0) return { kind: "noop" };
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
  let hidden = 0;
  let removed = 0;
  const service = resolveActiveService(ruleSet, settings, url);
  if (!service) return { hidden, removed };

  for (const s of service.surfaces) {
    if (!surfaceEnabledForTier(s, opts) || !s.selectors) continue;
    if (s.action === "hide") {
      for (const sel of s.selectors) {
        for (const el of safeQueryAll(doc, sel)) {
          (el as HTMLElement).style?.setProperty("display", "none", "important");
          hidden++;
        }
      }
    } else if (s.action === "remove") {
      for (const sel of s.selectors) {
        for (const el of safeQueryAll(doc, sel)) {
          el.remove();
          removed++;
        }
      }
    }
  }
  return { hidden, removed };
}

function surfaceEnabledForTier(s: ServiceRules["surfaces"][number], opts: EngineOptions): boolean {
  if (!s.enabledByDefault) return false;
  if (opts.pro !== false) return true;
  if (ALWAYS_FREE_SURFACE_IDS.has(s.id)) return true;
  return s.tier === "free";
}

/**
 * The CSS injected at document_start (manifest css for packaged selectors, runtime-injected for
 * fetched ones). Scoped under `html.still-active` so an off/paused user never has content hidden:
 * the content script adds the root class only when the service is on (KTD2).
 */
export function generateHideCss(ruleSet: SignedRuleSet): string {
  const rules: string[] = [];
  for (const service of Object.values(ruleSet.services)) {
    if (!service) continue;
    for (const s of service.surfaces) {
      if (s.action === "hide" && s.enabledByDefault && s.selectors) {
        for (const sel of s.selectors) {
          rules.push(`html.${ROOT_ACTIVE_CLASS} ${sel}{display:none!important}`);
        }
      }
    }
  }
  return rules.join("\n");
}

/** Replace the page body with the calm Still placeholder (used for placeholder/blockSite pages). */
export function renderPlaceholder(doc: Document, line: string = STILL_PLACEHOLDER_LINE): void {
  const body = doc.body;
  if (!body) return;
  const root = doc.createElement("div");
  root.id = "still-placeholder";
  root.setAttribute("role", "status");
  root.style.cssText =
    "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;" +
    "justify-content:center;gap:12px;background:#ffffff;color:#0b1020;font-family:system-ui,sans-serif;z-index:2147483647;";
  const mark = doc.createElement("div");
  mark.textContent = "Still";
  mark.style.cssText = "font-weight:600;font-size:20px;letter-spacing:-0.01em;";
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
