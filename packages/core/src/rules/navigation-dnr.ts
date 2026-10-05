import {
  FEATURE_REGISTRY,
  PAID_TIER_ENABLED,
  type BenefitId,
  type ServiceId,
  type SettingsV2,
  type SignedRuleSetV2,
  type StillSettings,
} from "@still/shared-types";
import { accessCapabilities, initialAccessSnapshot, isBenefitEffective } from "../entitlement/access-policy.js";
import { etldPlusOne } from "./match.js";

// Network-layer copies of the format-2 engine's FREE navigation redirects, for browsers whose
// extension API can redirect a top-level request before the page loads (Chromium's
// declarativeNetRequest session rules). The content script stays the authority and the fallback:
// these rules only ever take a request somewhere the engine's own classifier would send it, and
// every case a rule cannot express exactly is left to the content script.
//
// What is compiled, and why it is exact:
// - YouTube Shorts (`youtube.shorts`): /shorts/<id> goes to the same host's /watch?v=<id>. The
//   classifier rewrites the query with URLSearchParams.set, so only queries that serialization
//   leaves byte-for-byte unchanged are copied (plain name=value pairs of unreserved characters,
//   with no existing `v`); any other query stays with the content script.
// - Instagram Reels (`instagram.reels`): the bare /reels feed goes home; the plural viewer
//   /reels/<code>/ opens that one Reel at /reel/<code>/ (query kept), except the audio hub
//   /reels/audio/, which a higher-priority allow rule keeps reachable.
// - Facebook Reels (`facebook.reels`): the bare /reels feed and Watch's /watch/reels feed go home.
//   Profile and Page Reels tabs, shared /reel/<id> links and everything else stay reachable.
// No rule matches a URL with a fragment, a port, user info or an unusual host character, so those
// stay with the content script too. Reel-viewer continuation (the viewer advancing on its own) is
// a page-driven move, never a top-level request, so it remains the content script's alone.
//
// Never compiled: the Still Pro extras routes (engine code behind accessCapabilities, dormant while
// paid is off), and TikTok, whose blocked page is a per-tab decision with a one-tab allowance, not a
// redirect. Only free registry features have templates; a static test pins that.

/** The subset of chrome.declarativeNetRequest.Rule these rules use (string literals, not enums). */
export interface NavigationDnrRule {
  readonly id: number;
  readonly priority: number;
  readonly action:
    | { readonly type: "redirect"; readonly redirect: { readonly regexSubstitution: string } }
    | { readonly type: "allow" };
  readonly condition: {
    readonly regexFilter: string;
    /** Chrome matches regexFilter case-insensitively unless told otherwise; paths are not. */
    readonly isUrlFilterCaseSensitive: true;
    readonly requestDomains: readonly string[];
    readonly resourceTypes: readonly ["main_frame"];
  };
}

interface Template {
  readonly id: number;
  readonly feature: BenefitId;
  /** Path (and query) pattern after the captured origin `\1`; anchored at the URL's end. */
  readonly path: string;
  /** Redirect target; `\1` is the request's own origin. Absent for an allow rule. */
  readonly to?: string;
}

const ID = "([A-Za-z0-9_-]+)";
/** Any query, as long as no fragment follows (the classifier drops it for home redirects). */
const ANY_QUERY = "(?:\\?[^#]*)?";
/** One name=value pair URLSearchParams serializes unchanged, whose name is not `v`. */
const UNRESERVED = "[A-Za-z0-9*._-]";
const PAIR = `(?:${UNRESERVED}{2,}|[A-Za-uw-z0-9*._-])=${UNRESERVED}*`;

const TEMPLATES: readonly Template[] = Object.freeze([
  { id: 1, feature: "youtube.shorts", path: `/shorts/${ID}/?`, to: "\\1/watch?v=\\2" },
  { id: 2, feature: "youtube.shorts", path: `/shorts/${ID}/?\\?(${PAIR}(?:&${PAIR})*)`, to: "\\1/watch?\\3&v=\\2" },
  { id: 11, feature: "instagram.reels", path: `/reels/?${ANY_QUERY}`, to: "\\1/" },
  { id: 12, feature: "instagram.reels", path: `/reels/${ID}/?(\\?[^#]*)?`, to: "\\1/reel/\\2/\\3" },
  { id: 13, feature: "instagram.reels", path: `/reels/audio/?${ANY_QUERY}` },
  { id: 21, feature: "facebook.reels", path: `/(?:watch/)?reels/?${ANY_QUERY}`, to: "\\1/" },
] as const satisfies readonly Template[]);

/** Every rule id this module can produce. A sync removes all of them before adding the plan. */
export const NAVIGATION_DNR_RULE_IDS: readonly number[] = Object.freeze(TEMPLATES.map((template) => template.id));

/** Test seam: the features that own a template (each must be a free registry feature). */
export const NAVIGATION_DNR_FEATURES: readonly BenefitId[] = Object.freeze([
  ...new Set(TEMPLATES.map((template) => template.feature)),
]);

/** The packaged host capabilities: free-only while paid is off, exactly as the content engine. */
const PACKAGED_CAPABILITIES = accessCapabilities({ paidMode: PAID_TIER_ENABLED });

/** The registrable domain of a `*://*.<domain>/*` service pattern, or null for any other shape. */
function patternDomain(pattern: string): string | null {
  const domain = /^\*:\/\/\*\.([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/\*$/.exec(pattern)?.[1];
  return domain ?? null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface NavigationDnrInput {
  /** The admitted packaged format-2 set, or null when it failed admission (legacy lane). */
  readonly packaged: SignedRuleSetV2 | null;
  /** Services whose pages run the format-2 lane once settings are schema 2. */
  readonly shippingServices: ReadonlySet<ServiceId>;
  /** The committed settings, or null when absent or unreadable (legacy lane, no rules). */
  readonly settings: StillSettings | SettingsV2 | null;
}

export interface NavigationDnrPlan {
  /** Services whose pages run the format-2 lane for these inputs (the content script's choice). */
  readonly format2Services: ReadonlySet<ServiceId>;
  readonly rules: readonly NavigationDnrRule[];
}

/**
 * The content script's lane choice and the session rules it implies. A service runs format-2 only
 * when its pages would: it is a shipping service, the packaged set was admitted and the committed
 * settings are schema 2. Rules then follow the engine's own effective-feature predicate, so an
 * Off, unknown or missing choice (or a paused site) compiles to no rule at all.
 */
export function planNavigationDnr(input: NavigationDnrInput): NavigationDnrPlan {
  const { packaged, settings } = input;
  const format2Services = new Set<ServiceId>();
  const rules: NavigationDnrRule[] = [];
  if (!packaged || !settings || !("schemaVersion" in settings) || settings.schemaVersion !== 2 || !settings.sites)
    return { format2Services, rules };
  const access = initialAccessSnapshot();
  for (const [id, service] of Object.entries(packaged.services)) {
    const serviceId = id as ServiceId;
    if (!service || !input.shippingServices.has(serviceId)) continue;
    format2Services.add(serviceId);
    const domains = service.matches.map(patternDomain);
    if (domains.length !== 1 || !domains[0]) continue; // a shape these rules cannot mirror
    const domain = domains[0];
    if (Array.isArray(settings.pauses) && settings.pauses.includes(etldPlusOne(domain))) continue;
    const covered = new Set(service.surfaces.map((surface) => surface.feature));
    const origin = `^(https?://(?:[a-z0-9-]+\\.)*${escapeRegex(domain)})`;
    for (const template of TEMPLATES) {
      const feature = FEATURE_REGISTRY.find((entry) => entry.id === template.feature);
      if (!feature || feature.service !== serviceId || feature.tier !== "free" || !covered.has(template.feature)) continue;
      if (!isBenefitEffective(settings as SettingsV2, template.feature, access.states[template.feature], PACKAGED_CAPABILITIES.has(template.feature)))
        continue;
      rules.push(Object.freeze({
        id: template.id,
        // The allow rule outranks its service's redirects; redirects never overlap each other.
        priority: template.to === undefined ? 2 : 1,
        action: template.to === undefined
          ? Object.freeze({ type: "allow" as const })
          : Object.freeze({ type: "redirect" as const, redirect: Object.freeze({ regexSubstitution: template.to }) }),
        condition: Object.freeze({
          regexFilter: `${origin}${template.path}$`,
          isUrlFilterCaseSensitive: true,
          requestDomains: Object.freeze([domain]),
          resourceTypes: Object.freeze(["main_frame"] as const),
        }),
      }));
    }
  }
  return { format2Services, rules: Object.freeze(rules) };
}
