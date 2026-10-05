import seed from "../../rules/seed.json";
import {
  SERVICE_IDS,
  type ServiceId,
  type SignedRuleSet,
  type SignedRuleSetV2,
} from "@still/shared-types";
import {
  EntitlementCache,
  ChromeEntitlementAdapter,
} from "../entitlement/index.js";
import { initialAccessSnapshot } from "../entitlement/access-policy.js";
import {
  resolveRuleSetForLoad,
  ruleSetTrust,
  validateRuleSetV2,
  type ReadableArea,
} from "../rules/index.js";
import { PACKAGED_RULE_SET_V2, admitPackagedRuleSetV2 } from "../rules/packaged.js";
import {
  SettingsCache,
  ChromeStorageAdapter,
  parseStoredSettingsRecord,
} from "../storage/index.js";
import {
  createContentScript,
  earlyShortsRedirect,
  earlyFormat2ShortsRedirect,
  type ContentScriptDeps,
  type ContentScriptHandle,
  type RedirectDedupe,
  type StillWindow,
} from "./index.js";

/** The WXT lifecycle bit the shared entry needs without importing WXT into core. */
export interface ExtensionContentContext {
  readonly isInvalid?: boolean;
}

/** Optional host-specific work that must be wired before a core content script starts. */
export interface ExtensionContentNudge {
  attach(
    script: ContentScriptHandle,
    context: ExtensionContentContext,
  ): { request(): void };
}

export interface ExtensionContentEntryDeps {
  /** Internal packaged opt-in only; production entrypoints keep the existing bundled seed. */
  readonly bundledRuleSetV2?: SignedRuleSetV2;
  /** Optional trusted host adapter; omitted by current production entrypoints. */
  readonly handleBlockedNavigation?: ContentScriptDeps["handleBlockedNavigation"];
  /** The target extension's local storage namespace (Safari `browser`, Chromium `chrome`). */
  readonly storage: ReadableArea;
  readonly prod: boolean;
  /** Safari and Firefox own the early hard-navigation redirect (legacy or format-2 lane);
   * Chromium owns it with DNR. */
  readonly earlyRedirect: boolean;
  /** Safari's App-Group nudge lifecycle. Omitted by Chromium/Firefox by construction. */
  readonly nudge?: ExtensionContentNudge;
  /** Chromium/Firefox's background nudge, deliberately fire-and-forget at document_start. */
  readonly requestReconcile?: () => void;
  /** Optional WXT invalidation check; Safari supplies `ctx.isInvalid` after the async rule-set read. */
  readonly isInvalid?: () => boolean;
  /** Redirect-dedupe cell shared with a caller that already owns this page's early redirect. */
  readonly redirectDedupe?: RedirectDedupe;
  /** Test seam: the production factory otherwise uses the live document. */
  readonly win?: StillWindow;
  /** Test seam: the production factory otherwise uses the live document. */
  readonly doc?: Document;
  /** Test-only observation; it does not alter script construction. */
  readonly onScriptCreated?: (script: ContentScriptHandle) => void;
  /** Test-only observation immediately before `script.start()`. */
  readonly onStart?: () => void;
}

/**
 * Build the shared document_start body while leaving WXT's static manifest declaration and each
 * platform's native/DNR nudge seam in its own entrypoint. The same RedirectDedupe reaches the
 * early redirect and the hydrated script so a single navigation never calls location.replace twice.
 */
export function createExtensionContentEntry(
  deps: ExtensionContentEntryDeps,
): (context?: ExtensionContentContext) => Promise<void> {
  // Snapshot trusted packaged input before any storage/native wait. The loader separately
  // re-verifies cached data; a caller mutation can never change this admitted bundle later.
  const admitted = deps.bundledRuleSetV2
    ? validateRuleSetV2(deps.bundledRuleSetV2)
    : null;
  if (admitted && !admitted.ok)
    throw new Error("Invalid packaged format2 rule set");
  const bundledV2 = admitted?.ok ? admitted.value : null;
  return async (context = {}): Promise<void> => {
    const win = deps.win ?? (window as unknown as StillWindow);
    const doc = deps.doc ?? document;
    const cache = new SettingsCache(new ChromeStorageAdapter());
    const entitlement = new EntitlementCache(new ChromeEntitlementAdapter());
    const redirectDedupe: RedirectDedupe = deps.redirectDedupe ?? { lastRedirect: null };

    if (deps.earlyRedirect && !bundledV2) {
      void earlyShortsRedirect({
        win,
        ruleSet: seed as unknown as SignedRuleSet,
        cache,
        redirectDedupe,
      }).catch(() => {});
    } else if (deps.earlyRedirect && bundledV2) {
      void earlyFormat2ShortsRedirect({
        win,
        ruleSet: bundledV2,
        cache: new SettingsCache(new ChromeStorageAdapter()),
        access: () => entitlement.currentAccessSnapshot(),
        redirectDedupe,
      }).catch(() => {});
    }

    const modern = bundledV2
      ? await resolveRuleSetForLoad(
          bundledV2,
          deps.storage,
          ruleSetTrust(deps.prod, 2),
        )
      : null;
    const legacy = modern
      ? null
      : await resolveRuleSetForLoad(
          seed as unknown as SignedRuleSet,
          deps.storage,
          ruleSetTrust(deps.prod),
        );
    if (context.isInvalid || deps.isInvalid?.()) return;

    const script = createContentScript({
      win,
      doc,
      ruleSet: legacy?.ruleSet ?? (seed as unknown as SignedRuleSet),
      ruleSetV2: modern?.ruleSet,
      handleBlockedNavigation: deps.handleBlockedNavigation,
      cache,
      entitlement,
      redirectDedupe,
      manifestCssOwnsHides: legacy?.source === "bundled",
    });
    // The maintained cache now also owns the committed per-benefit read/subscription seam.
    // U7 consumes that seam in its separate engine change; legacy blocking remains intact.
    const stopAccess = entitlement.watch();
    const stop = script.stop.bind(script);
    script.stop = () => {
      stopAccess();
      stop();
    };
    void entitlement.refreshAccess(); // current free mode resolves synchronously, no account wait
    deps.onScriptCreated?.(script);
    const nudge = deps.nudge?.attach(script, context);
    deps.onStart?.();
    void script
      .start()
      .then(() => nudge?.request())
      .catch(() => script.stop());
    deps.requestReconcile?.();
  };
}

/**
 * Services whose pages run the packaged format-2 lane in shipping builds. Held empty: every
 * shipping page keeps the legacy seed engine until each service's built-extension contract
 * (hide-not-remove, no route placeholders, root classes, YouTube's Shorts-filter recovery) is
 * accepted. Adding a service here is the whole activation; the lane rules below stay the same.
 */
export const FORMAT2_SHIPPING_SERVICES: ReadonlySet<ServiceId> = new Set<ServiceId>();

/** The settings key the content script's ChromeStorageAdapter reads (its local projection). */
const SETTINGS_KEY = "still:settings";
/** The loader's rule-set cache keys (format 1, format 2), prefetched with the lane read. */
const LEGACY_RULES_KEY = "still:ruleset";
const FORMAT2_RULES_KEY = "still:ruleset:format2";

/** A direct YouTube Shorts load: the only case the content script's early redirect acts on. */
function isShortsHref(href: string): boolean {
  try {
    const url = new URL(href);
    return pageService(href) === "youtube" && url.pathname.startsWith("/shorts/");
  } catch {
    return false;
  }
}

/** Which engine a shipping page runs, and why the legacy seed engine was kept. */
export type ShippingContentLane =
  | { readonly kind: "format2" }
  | {
      readonly kind: "legacy";
      readonly reason:
        | "no-service"
        | "service-held"
        | "tiktok-port-absent"
        | "packaged-invalid"
        | "settings-absent"
        | "settings-not-schema2"
        | "settings-unreadable";
    };

export interface ShippingContentEntryDeps
  extends Omit<ExtensionContentEntryDeps, "bundledRuleSetV2"> {
  /** Test seam; production admits the generated packaged format2.json. */
  readonly packagedRuleSetV2?: unknown;
  /** Test seam; production uses FORMAT2_SHIPPING_SERVICES. */
  readonly format2Services?: ReadonlySet<ServiceId>;
  /** Test-only observation of the lane chosen for this page. */
  readonly onLane?: (lane: ShippingContentLane) => void;
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

/**
 * The shipping content entry. One page runs exactly one engine, chosen once per document:
 *
 * - format-2 only when the page's service is activated, the packaged set is admitted, and the
 *   committed local settings are already schema 2 (the format-2 engine deliberately does
 *   nothing for a legacy projection, so a legacy-settings user must keep the legacy engine);
 * - TikTok additionally needs the trusted blocked-screen port, otherwise its existing
 *   account-free legacy site block stays in force;
 * - everything else, including invalid packaged data and absent or unreadable settings, falls
 *   back to the legacy seed engine exactly as before.
 *
 * Timing: pages that cannot use format-2 decide synchronously and run the legacy entry as is.
 * On an activated page, the lane's settings read, both rule-set cache reads and (for a direct
 * Shorts URL on Firefox/Safari) the early redirect's settings hydrate all start together, so
 * neither lane waits for more sequential storage round trips than the legacy entry did.
 */
export function createShippingContentEntry(
  deps: ShippingContentEntryDeps,
): (context?: ExtensionContentContext) => Promise<void> {
  const services = deps.format2Services ?? FORMAT2_SHIPPING_SERVICES;
  const legacy = createExtensionContentEntry(deps);
  let admitted: SignedRuleSetV2 | null | undefined;
  const packaged = () => {
    admitted ??= admitPackagedRuleSetV2(
      "packagedRuleSetV2" in deps ? deps.packagedRuleSetV2 : PACKAGED_RULE_SET_V2,
    );
    return admitted;
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
    const href = win.location.href;
    const decided = held(href);
    if (decided) {
      deps.onLane?.(decided);
      return legacy(context);
    }
    // One round of parallel reads. Each key is read once; the chosen inner entry consumes the
    // already in-flight rule-set read instead of starting another round trip after the lane.
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
    const ownsEarly = deps.earlyRedirect && isShortsHref(href);
    if (ownsEarly) {
      // The redirect's own settings hydrate runs alongside the lane read: same single round
      // trip as the legacy early redirect, decided with the engine the lane selects.
      const cache = new SettingsCache(new ChromeStorageAdapter());
      void Promise.all([lane, cache.hydrate()])
        .then(([chosen]) =>
          chosen.kind === "format2"
            ? earlyFormat2ShortsRedirect({
                win,
                ruleSet: packaged()!,
                cache,
                access: () => initialAccessSnapshot(),
                redirectDedupe,
              })
            : earlyShortsRedirect({
                win,
                ruleSet: seed as unknown as SignedRuleSet,
                cache,
                redirectDedupe,
              }),
        )
        .catch(() => {});
    }
    return lane.then((chosen) => {
      deps.onLane?.(chosen);
      const inner = createExtensionContentEntry({
        ...deps,
        storage,
        earlyRedirect: deps.earlyRedirect && !ownsEarly,
        redirectDedupe,
        ...(chosen.kind === "format2" ? { bundledRuleSetV2: packaged()! } : {}),
      });
      return inner(context);
    });
  };
}
