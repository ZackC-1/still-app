import seed from "../../rules/seed.json";
import {
  SERVICE_IDS,
  type BenefitAccessSnapshot,
  type BenefitId,
  type ServiceId,
  type SignedRuleSet,
  type SignedRuleSetV2,
} from "@still/shared-types";
import { initialAccessSnapshot, packagedAccessContext } from "../entitlement/access-policy.js";
import { createEnginePageSession } from "../rules/engine.js";
import type { ReadableArea } from "../rules/index.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../rules/packaged.js";
import {
  ChromeStorageAdapter,
  SettingsCache,
  migrateSettingsV2,
  parseStoredSettingsRecord,
} from "../storage/index.js";
import {
  createExtensionContentEntry,
  FORMAT2_SHIPPING_SERVICES,
  type ExtensionContentContext,
  type ShippingContentEntryDeps,
  type ShippingContentLane,
} from "./extension-entry.js";
import {
  EARLY_REDIRECT_HOLD_MS,
  earlyShortsRedirect,
  locationRedirectPort,
  type RedirectDedupe,
  type StillWindow,
} from "./index.js";
import { createPendingCover, type PendingCover } from "./pending-cover.js";

// The shipping content entry for V3 builds (unconfigured or modern-sync builds: the same
// `atomicLocal` release rule as the V3 popup, settings and TikTok page). It is
// createShippingContentEntry plus two things ruled for U7-W3:
//
// 1. The early document_start redirect covers every core short-form route the format-2 engine
//    sends elsewhere (YouTube Shorts, the Instagram and Facebook Reels feeds, Facebook's /reel/
//    feed entry, the Instagram Reels viewer and an Instagram profile's Reels tab), not only Shorts.
//    Firefox and Safari use it; Chromium keeps DNR and the old entry.
// 2. On Safari only, the pending cover (pending-cover.ts): blank for at most 1.5 seconds while a
//    core route waits for settings (V3-D-052), and while a redirect Still issued is in flight.
//
// Why a separate entry rather than an option on createShippingContentEntry: store-style builds that
// keep the legacy settings (configured 2.x builds) must stay byte-identical (U7-W3 ruling Q7). The
// extension entrypoints pick this function with an inline build-time condition, so those builds
// never contain it. Lane selection below deliberately mirrors createShippingContentEntry; the shared
// shipping-entry tests run against both factories so the two cannot drift. Fold the two together
// when configured builds move to the format-2 lane.

/** The settings key the content script's ChromeStorageAdapter reads (its local projection). */
const SETTINGS_KEY = "still:settings";
/** The loader's rule-set cache keys (format 1, format 2), prefetched with the lane read. */
const LEGACY_RULES_KEY = "still:ruleset";
const FORMAT2_RULES_KEY = "still:ruleset:format2";

export interface ModernShippingContentEntryDeps extends ShippingContentEntryDeps {
  /**
   * Safari only, and only for a top-level document: show the pending cover. Chromium and Firefox
   * never pass it (owner decision V3-D-052 is a Safari policy).
   */
  readonly pendingCover?: boolean;
  /** Test seam for the cover's clock and timers; production uses the platform ones. */
  readonly coverTiming?: Pick<Parameters<typeof createPendingCover>[0], "now" | "setTimer" | "clearTimer" | "onRelease">;
}

/** The WXT lifecycle hooks this entry uses: invalidation stops the cover with the script. */
export interface ModernContentContext extends ExtensionContentContext {
  onInvalidated?(listener: () => void): unknown;
}

/** The service whose manifest host pattern (`*://*.<service>.com/*`) admitted this page. */
function pageService(href: string): ServiceId | null {
  let host: string;
  try {
    host = new URL(href).hostname;
  } catch {
    return null;
  }
  return SERVICE_IDS.find((id) => host === `${id}.com` || host.endsWith(`.${id}.com`)) ?? null;
}

/** The legacy early redirect's own trigger (unchanged): any direct YouTube /shorts/ load. */
function isShortsHref(href: string): boolean {
  try {
    const url = new URL(href);
    return pageService(href) === "youtube" && url.pathname.startsWith("/shorts/");
  } catch {
    return false;
  }
}

/**
 * A necessary condition for a core route, cheap enough for document_start on every page: the
 * service host plus the path shapes its core routes can take. It only rules pages OUT;
 * the packaged engine (below) still decides every page it lets through, so it never widens
 * anything. Building that engine session costs milliseconds cold, so ordinary pages never pay it.
 * A test checks that every route the engine sends elsewhere passes this filter.
 */
export function mayBeCoreRoute(url: URL): boolean {
  const host = url.hostname;
  const on = (service: string) => host === `${service}.com` || host.endsWith(`.${service}.com`);
  const path = url.pathname;
  if (on("youtube")) return path.startsWith("/shorts/");
  // Instagram also sends a profile's Reels tab, /<user>/reels/, to that profile.
  if (on("instagram")) return path.startsWith("/reels") || /^\/[^/]+\/reels\/?$/.test(path);
  // The /reel/ feed entry passes; a shared /reel/<digits> never builds a session here.
  if (on("facebook")) return path.startsWith("/reels") || path.startsWith("/watch/reels") || /^\/reel(?:\/(?!\d)|$)/.test(path);
  return false;
}

/**
 * The compiled core destination for `url` under fresh-install settings, or null. This asks the
 * same packaged engine the page runs, with the settings a fresh install starts with, so only the
 * routes of the default-on core controls qualify (V3-D-052): optional extras are off by default
 * and never classify, and there is no second copy of any route pattern.
 */
export function createCoreRouteClassifier(ruleSet: SignedRuleSetV2): (url: URL) => string | null {
  const fresh = migrateSettingsV2(null, { kind: "proven-fresh" });
  if (fresh.status !== "ready") throw new Error("Fresh settings are unavailable");
  const access = initialAccessSnapshot();
  // One classification-only session: it is only ever asked to evaluate, never to touch the page.
  const session = createEnginePageSession(ruleSet);
  return (url) => {
    const decision = session.evaluate(fresh.settings, url, { access });
    return decision.kind === "redirect" && decision.url !== url.href ? decision.url : null;
  };
}

/**
 * The home a Reel viewer item would be sent to when its viewer advances on its own (the core Reels
 * continuation stop), or null when `url` is not a Reel viewer item. It asks the same packaged
 * engine, under fresh-install settings, whether moving from a different viewer item to `url` is
 * a continuation, so the Reel viewer patterns are never copied here.
 */
export function createReelContinuationProbe(ruleSet: SignedRuleSetV2): (url: URL) => string | null {
  const fresh = migrateSettingsV2(null, { kind: "proven-fresh" });
  if (fresh.status !== "ready") throw new Error("Fresh settings are unavailable");
  const access = initialAccessSnapshot();
  const session = createEnginePageSession(ruleSet);
  return (url) => {
    // A different global viewer item on the same site: Instagram's viewer, Facebook's numeric Reel.
    const from = new URL(url.hostname.endsWith("facebook.com") ? "/reel/0" : "/reels/still-probe/", url.origin);
    if (from.pathname === url.pathname) return null;
    session.evaluate(fresh.settings, url, { access });
    return session.reelContinuation?.(from, url) ?? null;
  };
}

/** The two core short-form checks the redirect cover is limited to (V3-D-052: never extras). */
export interface CoreRedirectRoutes {
  /** The core destination of a core short-form route, or null. */
  readonly destination: (url: URL) => string | null;
  /** The home a Reel viewer item is sent to when its viewer advances on its own, or null. */
  readonly continuationHome: (url: URL) => string | null;
}

/** Whether the early decision sent the page away, declined, or its navigation call threw. */
export type EarlyCoreOutcome = "redirected" | "declined" | "failed";

export interface EarlyFormat2CoreRedirectDeps {
  readonly win: StillWindow;
  readonly ruleSet: SignedRuleSetV2;
  /** A dedicated settings cache, never the content script's own (see earlyFormat2ShortsRedirect). */
  readonly cache: SettingsCache;
  readonly classify: (url: URL) => string | null;
  readonly redirectDedupe: RedirectDedupe;
  /** The access snapshot for this host (as earlyFormat2ShortsRedirect takes it). */
  readonly access: () => BenefitAccessSnapshot;
  /** The host's packaged capabilities; absent, the engine's host-less default. */
  readonly capabilities?: ReadonlySet<BenefitId>;
  /**
   * The address this document loaded at (read at document_start). When the page rewrites its own
   * address during the settings read, a hand-over from that loaded core route into a single Reel
   * is still the feed (ISS-0039: Facebook answers a typed /reels with /reel/, whose script then
   * replaces it with /reel/<id> before the settings arrive).
   */
  readonly loadedHref?: string;
}

/**
 * The format-2 early redirect for every core route. After ONE persisted settings read it rereads
 * the URL and decides with the page's own compiled classifier and the committed predicate: a saved
 * Off for Still, the service or the core control never redirects. Only a core route's own
 * destination is followed here, or Home when the page left its loaded core route on its own during
 * the read (a feed handing over to a Reel, a viewer moving on to another); extras and later
 * continuation stay with the content script.
 */
export async function earlyFormat2CoreRedirect(deps: EarlyFormat2CoreRedirectDeps): Promise<EarlyCoreOutcome> {
  await deps.cache.hydrate();
  const url = new URL(deps.win.location.href);
  const core = deps.classify(url);
  const loaded = deps.loadedHref !== undefined && deps.loadedHref !== url.href ? new URL(deps.loadedHref) : null;
  if (!core && !loaded) return "declined";
  const session = createEnginePageSession(deps.ruleSet);
  let decision: ReturnType<typeof session.evaluate>;
  // Set when the page left its loaded core route on its own before Still could decide.
  let handOver: string | null = null;
  try {
    const settings = deps.cache.current();
    const options = { access: deps.access(), capabilities: deps.capabilities };
    // Under the committed settings: a loaded feed that goes Home stays the feed when it hands over
    // to a Reel (Instagram's /reels/ to /reels/<code>/ or /reel/<code>/, Facebook's /reel/ entry to
    // its first Reel); otherwise a viewer moving on to a different Reel is a continuation. Leaving
    // for an ordinary page is neither.
    let loadedFeed: string | null = null;
    if (loaded) {
      const fromLoaded = session.evaluate(settings, loaded, options);
      const home = new URL("/", loaded.origin).href;
      if (fromLoaded.kind === "redirect" && fromLoaded.url === home) loadedFeed = home;
    }
    decision = session.evaluate(settings, url, options);
    if (loaded) {
      // A Reel address is a core route itself or a Reel viewer item (the probe asks the same
      // engine whether arriving from a different viewer item would be a continuation).
      const probe = new URL(url.hostname.endsWith("facebook.com") ? "/reel/0" : "/reels/still-probe/", url.origin);
      const reelAddress = core !== null || (probe.pathname !== url.pathname && session.reelContinuation?.(probe, url) != null);
      handOver = loadedFeed && reelAddress ? loadedFeed : session.reelContinuation?.(loaded, url) ?? null;
    }
    if (handOver) decision = { kind: "redirect", url: handOver };
    else if (!core) decision = { kind: "noop" };
  } finally {
    session.stop?.();
  }
  if (decision.kind !== "redirect" || (core !== null && !handOver && decision.url !== core)) return "declined";
  if (deps.redirectDedupe.lastRedirect === decision.url) return "redirected";
  deps.redirectDedupe.lastRedirect = decision.url;
  deps.redirectDedupe.earlyLeaving = { href: url.href, until: Date.now() + EARLY_REDIRECT_HOLD_MS };
  try {
    locationRedirectPort(deps.win).replace(decision.url);
  } catch {
    // As in the Shorts-only path, the dedupe keeps the hydrated script from retrying the same
    // navigation; its apply path carries on. The cover must not wait for the ceiling. Nothing is in
    // flight from this address, so the script's own later decisions are not held back.
    delete deps.redirectDedupe.earlyLeaving;
    return "failed";
  }
  return "redirected";
}

/**
 * The page window as the format-2 content script sees it, with one difference: when Still replaces
 * the current document because it is a core short-form page (a hard load decided after
 * hydration, the URL watch on Safari without the Navigation API, a correction after an App Group
 * reconcile, a Reel viewer advancing on its own), the cover goes up first and stays through that
 * navigation. Everything else is never covered (V3-D-052): optional-feature redirects such as
 * Explore to search or Stories to Home, and pre-commit navigations, which leave an ordinary page on
 * screen and use `assign`, or happen while the current URL is not a core route.
 */
export function createCoveredWindow(
  win: StillWindow,
  cover: PendingCover,
  routes: CoreRedirectRoutes,
): StillWindow {
  const covering = (target: string): boolean => {
    try {
      const current = new URL(win.location.href);
      const core = routes.destination(current);
      if (core !== null) return core === target;
      // Only without the Navigation API does a page-driven Reel advance reach this as a
      // replacement of the committed page; with it, the move is stopped before it commits.
      return !win.navigation && routes.continuationHome(current) === target;
    } catch {
      return false;
    }
  };
  const location: StillWindow["location"] = {
    get href() {
      return win.location.href;
    },
    replace(url: string) {
      const token = covering(url) ? cover.show("redirecting") : 0;
      cover.commit(token);
      try {
        win.location.replace(url);
      } catch (error) {
        cover.release(token, "redirect-failed");
        throw error;
      }
    },
    ...(win.location.assign ? { assign: (url: string) => win.location.assign!(url) } : {}),
  };
  return {
    location,
    get history() {
      return win.history;
    },
    addEventListener: (type, listener) => win.addEventListener(type, listener),
    removeEventListener: (type, listener) => win.removeEventListener(type, listener),
    get MutationObserver() {
      return win.MutationObserver;
    },
    ...(win.requestAnimationFrame
      ? { requestAnimationFrame: (callback: FrameRequestCallback) => win.requestAnimationFrame!(callback) }
      : {}),
    get navigation() {
      return win.navigation;
    },
  };
}

/** See the file header. Same deps as createShippingContentEntry, plus the Safari cover switch. */
export function createModernShippingContentEntry(
  deps: ModernShippingContentEntryDeps,
): (context?: ModernContentContext) => Promise<void> {
  const services = deps.format2Services ?? FORMAT2_SHIPPING_SERVICES;
  let admitted: SignedRuleSetV2 | null | undefined;
  const packaged = () => {
    admitted ??= admitPackagedRuleSetV2(
      "packagedRuleSetV2" in deps ? deps.packagedRuleSetV2 : PACKAGED_RULE_SET_V2,
    );
    return admitted;
  };
  let classifier: ((url: URL) => string | null) | undefined;
  // The engine-backed classifier is built only for a page that could be a core route.
  const classify = (url: URL): string | null =>
    mayBeCoreRoute(url) ? (classifier ??= createCoreRouteClassifier(packaged()!))(url) : null;
  let continuation: ((url: URL) => string | null) | undefined;
  const routes: CoreRedirectRoutes = {
    destination: classify,
    continuationHome: (url) => (continuation ??= createReelContinuationProbe(packaged()!))(url),
  };
  const coreDestinationOf = (href: string): string | null => {
    try {
      return classify(new URL(href));
    } catch {
      return null;
    }
  };
  // Synchronous part: pages that cannot run format-2 never wait for a storage read.
  const held = (href: string): ShippingContentLane | null => {
    const service = pageService(href);
    if (!service) return { kind: "legacy", reason: "no-service" };
    if (!services.has(service)) return { kind: "legacy", reason: "service-held" };
    if (service === "tiktok" && !deps.handleBlockedNavigation)
      return { kind: "legacy", reason: "tiktok-port-absent" };
    if (!packaged()) return { kind: "legacy", reason: "packaged-invalid" };
    return null;
  };
  const committedSchema = async (
    read: ReadableArea["get"],
  ): Promise<ShippingContentLane> => {
    try {
      const raw = await read(SETTINGS_KEY);
      if (!Object.hasOwn(raw, SETTINGS_KEY)) return { kind: "legacy", reason: "settings-absent" };
      const settings = parseStoredSettingsRecord(raw[SETTINGS_KEY])?.settings;
      return settings && "schemaVersion" in settings && settings.schemaVersion === 2
        ? { kind: "format2" }
        : { kind: "legacy", reason: "settings-not-schema2" };
    } catch {
      return { kind: "legacy", reason: "settings-unreadable" };
    }
  };
  return (context = {}): Promise<void> => {
    const win = deps.win ?? (window as unknown as StillWindow);
    const doc = deps.doc ?? document;
    const href = win.location.href;
    const decided = held(href);
    if (decided) {
      deps.onLane?.(decided);
      return createExtensionContentEntry(deps)(context);
    }
    const prefetched = new Map<string, Promise<Record<string, unknown>>>();
    const prefetch = (key: string) => {
      const pending = Promise.resolve().then(() => deps.storage.get(key));
      pending.catch(() => {}); // an unused read must not surface as an unhandled rejection
      prefetched.set(key, pending);
    };
    for (const key of [SETTINGS_KEY, LEGACY_RULES_KEY, FORMAT2_RULES_KEY]) prefetch(key);
    const storage: ReadableArea = {
      get: (key) => {
        const pending = prefetched.get(key);
        prefetched.delete(key);
        return pending ?? deps.storage.get(key);
      },
    };
    const lane = committedSchema(storage.get);
    const redirectDedupe: RedirectDedupe = { lastRedirect: null };

    const core = coreDestinationOf(href);
    // A plural Reel may advance during hydration even though its initial alias is now allowed.
    // Keep the existing candidate prefilter so ordinary pages incur no new early settings read.
    const ownsEarly = deps.earlyRedirect && (core !== null || isShortsHref(href) || mayBeCoreRoute(new URL(href)));
    // The cover exists for every format-2-capable Safari page (late redirects can happen on any of
    // them); it is shown now only on a core route this page owns the early decision for.
    const cover = deps.pendingCover
      ? createPendingCover({ doc, win: win as unknown as Parameters<typeof createPendingCover>[0]["win"], ...deps.coverTiming })
      : null;
    const pending = cover && ownsEarly && core !== null ? cover.show("pending") : 0;
    context.onInvalidated?.(() => cover?.stop());
    void lane.then((chosen) => {
      // The cover belongs to the format-2 lane only; a legacy page keeps today's behaviour.
      if (chosen.kind !== "format2") cover?.release(pending, "allowed");
    });

    if (ownsEarly) {
      const early = packagedAccessContext(deps.host, deps.platform);
      const cache = new SettingsCache(new ChromeStorageAdapter());
      void Promise.all([lane, cache.hydrate()])
        .then(([chosen]): Promise<EarlyCoreOutcome> | EarlyCoreOutcome => {
          if (chosen.kind === "format2")
            return earlyFormat2CoreRedirect({
              win,
              loadedHref: href,
              ruleSet: packaged()!,
              cache,
              classify,
              // Same shape as the shipping entry's early Shorts call: this host's packaged context.
              access: () => initialAccessSnapshot(early),
              capabilities: early.supported,
              redirectDedupe,
            });
          if (!isShortsHref(href)) return "declined";
          // Unchanged legacy behaviour: the seed engine's own early Shorts redirect.
          return earlyShortsRedirect({
            win,
            ruleSet: seed as unknown as SignedRuleSet,
            cache,
            redirectDedupe,
          }).then(() => "declined" as const);
        })
        .then(
          (outcome) => {
            if (outcome === "redirected") cover?.commit(pending);
            else cover?.release(pending, outcome === "failed" ? "redirect-failed" : "allowed");
          },
          () => cover?.release(pending, "settings-unavailable"),
        );
    }
    return lane.then(async (chosen) => {
      deps.onLane?.(chosen);
      const format2 = chosen.kind === "format2";
      const inner = createExtensionContentEntry({
        ...deps,
        win: format2 && cover ? createCoveredWindow(win, cover, routes) : deps.win,
        storage,
        earlyRedirect: deps.earlyRedirect && !ownsEarly,
        redirectDedupe,
        ...(format2 ? { bundledRuleSetV2: packaged()! } : {}),
      });
      await inner(context);
      // Invalidated before a script existed: nothing will ever release the cover but this.
      if (context.isInvalid || deps.isInvalid?.()) cover?.stop();
    });
  };
}
