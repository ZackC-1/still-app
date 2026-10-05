import type { BenefitId, FeatureId, ServiceId, SurfaceV2 } from "@still/shared-types";

// The compiled framework for the Still Pro extras (dormant while the paid tier is off). Everything
// here is engine code, never rule data: rule data may only add `hide` selectors for a feature, while
// page routing and marker attributes are compiled into the packaged content script. Each service
// keeps its own module (youtube-extras.ts, instagram-extras.ts, facebook-extras.ts) so the site
// packets never edit the same file.
//
// This module and the per-service modules carry only type imports: sign-format2.mjs imports the
// per-service modules directly in Node to copy their hide surfaces into the packaged rule set.

/**
 * One compiled extras route: a predicate and a destination for one feature. The engine consults
 * an entry only while its feature is effective, only after the free core routing has declined
 * the URL, and only when the destination is same-origin, a different address, and not itself
 * routed again (loop-safe). Predicates see the whole URL (path, query and fragment) and should
 * match exact paths; see exactPath.
 */
export interface ExtrasRoute {
  readonly feature: FeatureId;
  readonly matches: (url: URL) => boolean;
  readonly destination: (url: URL) => URL;
}

/**
 * A JavaScript marker for a structural boundary CSS cannot express. While the feature is
 * effective the content script sets `attribute` on every `candidates` element that `owns` accepts
 * (and clears it from the rest); the rule set hides `ruleSelector` under the same feature gate.
 * Off, another service, or teardown removes every attribute the hook owns. Never text or
 * "Sponsored"-letter detection.
 */
export interface MarkerAdapter {
  readonly feature: FeatureId;
  readonly attribute: `data-still-${string}`;
  readonly candidates: string;
  /** The exact hide selector, in the same feature's surface, that consumes the marker. */
  readonly ruleSelector: string;
  readonly owns: (element: Element) => boolean;
}

/** Everything a service's Still Pro extras contribute, split per service module. */
export interface ServiceExtras {
  /** Pro `hide` surfaces, appended to the service's packaged surfaces by sign-format2.mjs. */
  readonly surfaces: readonly Extract<SurfaceV2, { readonly action: "hide" }>[];
  readonly routes: readonly ExtrasRoute[];
  readonly markers: readonly MarkerAdapter[];
}

export type ExtrasRouteTable = Readonly<Partial<Record<ServiceId, readonly ExtrasRoute[]>>>;

/**
 * True when `pathname` is exactly one of `paths`, with or without one trailing slash. A nested
 * path (`/explore/tags/x` for `/explore`) never matches.
 */
export function exactPath(pathname: string, ...paths: readonly string[]): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return paths.some((path) => normalized === (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path));
}

/**
 * The first effective entry's destination for `url`, or null. `routedElsewhere` reports whether a
 * candidate destination would itself be routed again (by the core or any effective entry); such a
 * destination is refused rather than followed, so two entries can never bounce between each other.
 * A throwing predicate or destination counts as no route.
 */
export function resolveExtrasRoute(
  routes: readonly ExtrasRoute[],
  url: URL,
  effective: readonly BenefitId[],
  routedElsewhere: (destination: URL) => boolean,
): URL | null {
  for (const route of routes) {
    if (!effective.includes(route.feature)) continue;
    let destination: URL;
    try {
      if (!route.matches(url)) continue;
      destination = route.destination(url);
    } catch {
      continue;
    }
    if (destination.origin !== url.origin || destination.href === url.href) return null;
    return routedElsewhere(destination) ? null : destination;
  }
  return null;
}

/** True when an effective entry would route `url`. Used for the loop check above. */
export function extrasRouteMatches(routes: readonly ExtrasRoute[], url: URL, effective: readonly BenefitId[]): boolean {
  return routes.some((route) => {
    if (!effective.includes(route.feature)) return false;
    try {
      return route.matches(url);
    } catch {
      return false;
    }
  });
}
