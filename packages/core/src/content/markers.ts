import type { BenefitId, SignedRuleSetV2 } from "@still/shared-types";
import type { MarkerAdapter } from "../rules/extras.js";
import { YOUTUBE_EXTRAS } from "../rules/youtube-extras.js";
import { INSTAGRAM_EXTRAS } from "../rules/instagram-extras.js";
import { FACEBOOK_EXTRAS } from "../rules/facebook-extras.js";

// The marker hook: JavaScript sets a `data-still-*` attribute only where CSS cannot express a
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

/** One hook per content script. It adds no listeners or observers; callers decide when to reconcile. */
export function createMarkerHook(doc: Document, adapters: readonly MarkerAdapter[]): MarkerHook {
  const marked = new Set<MarkerAdapter>();
  let stopped = false;
  return {
    reconcile(effective) {
      if (stopped) return;
      for (const adapter of adapters) {
        if (effective.includes(adapter.feature)) {
          applyMarker(doc, adapter);
          marked.add(adapter);
        } else if (marked.delete(adapter)) clearMarker(doc, adapter);
      }
    },
    addressScopedMarked() {
      if (stopped) return false;
      for (const adapter of marked) if (adapter.addressScoped && doc.querySelector(`[${adapter.attribute}]`)) return true;
      return false;
    },
    stop() {
      stopped = true;
      marked.clear();
      for (const adapter of adapters) clearMarker(doc, adapter);
    },
  };
}
