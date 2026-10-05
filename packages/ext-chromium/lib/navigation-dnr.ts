import type { ServiceId, SignedRuleSetV2, StillSettings } from "@still/shared-types";
import {
  isServiceEnabledGlobally,
  planNavigationDnr,
  NAVIGATION_DNR_RULE_IDS,
  type NavigationDnrRule,
} from "@still/core/rules";

/**
 * The declarativeNetRequest calls the navigation sync uses. Session rules, never dynamic ones: they
 * live only as long as this browser session and this installed version, so a browser restart, an
 * update or a rollback to a build without this code can never inherit a stale redirect.
 */
export interface NavigationDnrApi {
  getSessionRules(): Promise<readonly { readonly id: number }[]>;
  updateSessionRules(options: {
    removeRuleIds: number[];
    addRules: NavigationDnrRule[];
  }): Promise<void>;
  updateEnabledRulesets(options: {
    enableRulesetIds?: string[];
    disableRulesetIds?: string[];
  }): Promise<void>;
}

export interface NavigationDnrDeps {
  readonly api: NavigationDnrApi;
  /** The static Shorts ruleset the legacy lane keeps using. */
  readonly staticRulesetId: string;
  /** The committed settings record, read fresh; a rejection means unreadable. */
  readonly readSettings: () => Promise<StillSettings | null>;
  /** The background cache's settings, for the legacy gate when the record is unreadable. */
  readonly cachedSettings: () => StillSettings;
  readonly packaged: SignedRuleSetV2 | null;
  readonly shippingServices: ReadonlySet<ServiceId>;
}

/**
 * Keeps the browser's network-layer redirects equal to what the content script would decide.
 *
 * Each pass reads the committed settings, picks the same lane the content script picks, and then:
 * - pages on the format-2 lane get the compiled session rules for their effective FREE features
 *   (one atomic updateSessionRules call that removes every rule id this sync owns first);
 * - YouTube pages still on the legacy lane keep today's static Shorts ruleset and its gate.
 * Turning something off removes before it adds (the static ruleset is disabled first), so a pass
 * never leaves an Off service redirected; a failed rule update clears the session rules and the
 * content script, the authority, carries on alone.
 *
 * `sync()` is serialized and coalesced: calls made before a pass starts share it, calls made while
 * one runs get the next one, and every pass reads storage when it starts. So the promise a caller
 * receives settles only after a pass that saw everything committed before the call.
 */
export function createNavigationDnrSync(deps: NavigationDnrDeps): () => Promise<void> {
  let queued: Promise<void> | null = null;
  let tail: Promise<void> = Promise.resolve();

  const pass = async (): Promise<void> => {
    let settings: StillSettings | null;
    let readable = true;
    try {
      settings = await deps.readSettings();
    } catch {
      settings = null;
      readable = false;
    }
    const plan = planNavigationDnr({
      packaged: deps.packaged,
      shippingServices: deps.shippingServices,
      settings,
    });
    // The legacy lane's gate exactly as before: the engine's URL-free predicate (R2).
    const legacyGate = readable && settings ? settings : deps.cachedSettings();
    const staticOn = !plan.format2Services.has("youtube") && isServiceEnabledGlobally(legacyGate, "youtube");
    const { api } = deps;
    if (!staticOn) await api.updateEnabledRulesets({ disableRulesetIds: [deps.staticRulesetId] });
    const existing = await api.getSessionRules();
    const removeRuleIds = [...new Set([...existing.map((rule) => rule.id), ...NAVIGATION_DNR_RULE_IDS])];
    try {
      await api.updateSessionRules({ removeRuleIds, addRules: [...plan.rules] });
    } catch (error) {
      // Never leave a half-known rule set behind: fall back to the content script alone.
      await api.updateSessionRules({ removeRuleIds, addRules: [] }).catch(() => undefined);
      throw error;
    }
    if (staticOn) await api.updateEnabledRulesets({ enableRulesetIds: [deps.staticRulesetId] });
  };

  return () => {
    if (queued) return queued;
    const next = tail.then(() => {
      queued = null;
      return pass();
    });
    queued = next;
    tail = next.catch(() => undefined);
    return next;
  };
}
