import type { ServiceId, SignedRuleSetV2, StillSettings } from "@still/shared-types";
import { isServiceEnabledGlobally } from "@still/core/rules";
// Imported by path, never through the rules index: content scripts import that index, and this
// background-only compiler must not reach their bundles.
import {
  planNavigationDnr,
  navigationDnrRuleIdsFor,
  NAVIGATION_DNR_RULE_IDS,
  type NavigationDnrRule,
} from "@still/core/rules/navigation-dnr";

/**
 * The declarativeNetRequest calls the navigation sync uses. Session rules, never dynamic ones: they
 * live only as long as this browser session and this installed version, so a browser restart, an
 * update or a rollback to a build without this code can never inherit a stale redirect.
 */
export interface NavigationDnrApi {
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
 *   (one atomic updateSessionRules call that first removes this sync's own rule ids, and only
 *   those: any other session rule is left exactly as it is);
 * - YouTube pages still on the legacy lane keep today's static Shorts ruleset and its gate.
 * Turning something off removes before it adds (the static ruleset is disabled first), so a pass
 * never leaves an Off service redirected; a failed rule update clears the session rules and the
 * content script, the authority, carries on alone.
 *
 * `sync()` is serialized and coalesced: calls made before a pass starts share it, calls made while
 * one runs get the next one, and every pass reads storage when it starts. So the promise a caller
 * receives settles only after a pass that saw everything committed before the call.
 *
 * `retire(path)` is for a choice about to be saved Off: it withholds the rules that choice can
 * switch off from every pass until released, and resolves once a pass has run. It never rejects:
 * a failed pass is reported as `failure` but the hold stays until the caller releases it (after
 * the Off is committed), so no later pass can bring the redirect back in between. A failed pass
 * has already cleared this sync's rules, so the Off is safe to commit either way.
 */
export interface NavigationDnrRetirement {
  readonly release: () => void;
  readonly failure: unknown;
}

export interface NavigationDnrSync {
  sync(): Promise<void>;
  retire(path: string): Promise<NavigationDnrRetirement>;
}

export function createNavigationDnrSync(deps: NavigationDnrDeps): NavigationDnrSync {
  let queued: Promise<void> | null = null;
  let tail: Promise<void> = Promise.resolve();
  const withheld = new Map<number, number>();

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
    // Only this sync's own ids. Removing an id that is not installed is a no-op in Chrome.
    const removeRuleIds = [...NAVIGATION_DNR_RULE_IDS];
    try {
      await api.updateSessionRules({ removeRuleIds, addRules: plan.rules.filter((rule) => !withheld.has(rule.id)) });
    } catch (error) {
      // Never leave a half-known rule set behind: fall back to the content script alone.
      await api.updateSessionRules({ removeRuleIds, addRules: [] }).catch(() => undefined);
      throw error;
    }
    if (staticOn) await api.updateEnabledRulesets({ enableRulesetIds: [deps.staticRulesetId] });
  };

  const sync = (): Promise<void> => {
    if (queued) return queued;
    const next = tail.then(() => {
      queued = null;
      return pass();
    });
    queued = next;
    tail = next.catch(() => undefined);
    return next;
  };

  const retire = async (path: string): Promise<NavigationDnrRetirement> => {
    const ids = navigationDnrRuleIdsFor(path);
    for (const id of ids) withheld.set(id, (withheld.get(id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const id of ids) {
        const count = (withheld.get(id) ?? 1) - 1;
        if (count > 0) withheld.set(id, count);
        else withheld.delete(id);
      }
      void sync().catch(() => undefined);
    };
    if (ids.length === 0) return { release, failure: null };
    try {
      await sync();
      return { release, failure: null };
    } catch (failure) {
      return { release, failure: failure ?? new Error("Navigation rule update failed") };
    }
  };

  return { sync, retire };
}
