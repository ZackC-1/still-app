import type { BenefitId, SignedRuleSetV2 } from "@still/shared-types";
import type { MarkerAdapter } from "../rules/extras.js";
import { YOUTUBE_EXTRAS } from "../rules/youtube-extras.js";
import { INSTAGRAM_EXTRAS } from "../rules/instagram-extras.js";
import { FACEBOOK_EXTRAS } from "../rules/facebook-extras.js";

// The marker hook: JavaScript sets a `data-still-*` attribute where the browser's CSS cannot express a
// structural boundary, and only while that attribute's feature is effective. The rule set hides
// the marked element under the same feature's root class, so the marker on its own hides nothing.

/**
 * Current YouTube search chips expose their label on an inner tab, not the title attribute the
 * older rule used. This is the free Shorts core's marker (format-2 lane), first of its kind.
 */
export const SHORTS_CHIP_MARKER: MarkerAdapter = Object.freeze({
  feature: "youtube.shorts",
  attribute: "data-still-shorts-chip",
  candidates: "yt-chip-cloud-chip-renderer",
  ruleSelector: "yt-chip-cloud-chip-renderer[data-still-shorts-chip]",
  owns: (chip: Element) => chip.querySelector<HTMLElement>('[role="tab"]')?.textContent?.trim() === "Shorts",
});

/** Every packaged marker adapter: the free Shorts chip, then each service's Still Pro markers. */
export const PACKAGED_MARKERS: readonly MarkerAdapter[] = Object.freeze([
  SHORTS_CHIP_MARKER,
  ...YOUTUBE_EXTRAS.markers,
  ...INSTAGRAM_EXTRAS.markers,
  ...FACEBOOK_EXTRAS.markers,
]);

/**
 * The adapters whose marker the admitted rule set actually consumes: a `hide` surface of the same
 * feature carries the adapter's exact rule selector. A marker nothing hides is never set.
 */
export function admittedMarkers(ruleSet: SignedRuleSetV2, adapters: readonly MarkerAdapter[] = PACKAGED_MARKERS): readonly MarkerAdapter[] {
  return adapters.filter((adapter) => Object.values(ruleSet.services).some((service) =>
    service?.surfaces.some((surface) => surface.feature === adapter.feature && surface.action === "hide"
      && surface.selectors.includes(adapter.ruleSelector))));
}

/** Marks (or unmarks) every candidate from its current structure; recycled nodes lose stale marks. */
export function applyMarker(doc: Document, adapter: MarkerAdapter): void {
  for (const element of doc.querySelectorAll(adapter.candidates)) element.toggleAttribute(adapter.attribute, adapter.owns(element));
}

function clearMarker(doc: Document, adapter: MarkerAdapter): void {
  for (const element of doc.querySelectorAll(`[${adapter.attribute}]`)) element.removeAttribute(adapter.attribute);
}

export interface MarkerHook {
  /** Marks for every adapter whose feature is in `effective`; clears adapters that stopped being. */
  reconcile(effective: readonly BenefitId[]): void;
  /** True while an address-scoped adapter's mark is actually set on the page. */
  addressScopedMarked(): boolean;
  /** Teardown: removes every attribute any adapter owns. */
  stop(): void;
}

function supportsSelector(doc: Document, selector: string): boolean {
  const css = doc.defaultView?.CSS;
  if (typeof css?.supports === "function") return css.supports(`selector(${selector})`);
  try { doc.querySelector(selector); return true; } catch { return false; }
}

/** One hook per script. Only unsupported structural selectors need a narrow mutation observer. */
export function createMarkerHook(doc: Document, adapters: readonly MarkerAdapter[]): MarkerHook {
  const active = adapters.filter(adapter => !adapter.structuralFallback || !supportsSelector(doc, adapter.structuralFallback));
  const marked = new Set<MarkerAdapter>();
  // Retain marked panels so Off/stop also clears nodes the page has detached or recycled.
  const fallbackElements = new Map<MarkerAdapter, Set<Element>>();
  let observer: MutationObserver | null = null;
  let stopped = false;
  const refreshFallback = (adapter: MarkerAdapter, elements: Iterable<Element>): void => {
    const owned = fallbackElements.get(adapter)!;
    for (const element of elements) {
      const keep = element.isConnected && element.ownerDocument === doc && adapter.owns(element);
      element.toggleAttribute(adapter.attribute, keep);
      if (keep) owned.add(element); else owned.delete(element);
    }
  };
  const clear = (adapter: MarkerAdapter): void => {
    for (const element of fallbackElements.get(adapter) ?? []) element.removeAttribute(adapter.attribute);
    fallbackElements.delete(adapter);
    clearMarker(doc, adapter);
  };
  const syncObserver = (): void => {
    if (!fallbackElements.size) { observer?.disconnect(); observer = null; return; }
    if (observer || !doc.defaultView) return;
    observer = new doc.defaultView.MutationObserver(records => {
      if (stopped) return;
      for (const adapter of fallbackElements.keys()) {
        const affected = new Set<Element>();
        for (const record of records) {
          if (record.target.nodeType === 1) {
            const panel = (record.target as Element).closest(adapter.candidates);
            if (panel) affected.add(panel);
          }
          for (const node of [...record.addedNodes, ...record.removedNodes]) {
            if (node.nodeType !== 1) continue;
            const element = node as Element;
            if (element.matches(adapter.candidates)) affected.add(element);
            for (const panel of element.querySelectorAll(adapter.candidates)) affected.add(panel);
          }
        }
        refreshFallback(adapter, affected);
      }
    });
    // Marker attributes are deliberately excluded: our writes cannot trigger this observer.
    observer.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  };
  return {
    reconcile(effective) {
      if (stopped) return;
      for (const adapter of active) {
        if (effective.includes(adapter.feature)) {
          if (adapter.structuralFallback) {
            if (!fallbackElements.has(adapter)) fallbackElements.set(adapter, new Set());
            refreshFallback(adapter, new Set([...fallbackElements.get(adapter)!, ...doc.querySelectorAll(adapter.candidates)]));
          } else applyMarker(doc, adapter);
          marked.add(adapter);
        } else if (marked.delete(adapter)) clear(adapter);
      }
      syncObserver();
    },
    addressScopedMarked() {
      if (stopped) return false;
      for (const adapter of marked) if (adapter.addressScoped && doc.querySelector(`[${adapter.attribute}]`)) return true;
      return false;
    },
    stop() {
      stopped = true;
      observer?.disconnect(); observer = null;
      marked.clear();
      for (const adapter of active) clear(adapter);
    },
  };
}
