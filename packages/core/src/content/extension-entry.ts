import seed from "../../rules/seed.json";
import type { SignedRuleSet, SignedRuleSetV2 } from "@still/shared-types";
import {
  EntitlementCache,
  ChromeEntitlementAdapter,
} from "../entitlement/index.js";
import {
  resolveRuleSetForLoad,
  ruleSetTrust,
  validateRuleSetV2,
  type ReadableArea,
} from "../rules/index.js";
import { SettingsCache, ChromeStorageAdapter } from "../storage/index.js";
import {
  createContentScript,
  earlyShortsRedirect,
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
  /** The target extension's local storage namespace (Safari `browser`, Chromium `chrome`). */
  readonly storage: ReadableArea;
  readonly prod: boolean;
  /** Safari and Firefox own the early hard-navigation redirect; Chromium owns it with DNR. */
  readonly earlyRedirect: boolean;
  /** Safari's App-Group nudge lifecycle. Omitted by Chromium/Firefox by construction. */
  readonly nudge?: ExtensionContentNudge;
  /** Chromium/Firefox's background nudge, deliberately fire-and-forget at document_start. */
  readonly requestReconcile?: () => void;
  /** Optional WXT invalidation check; Safari supplies `ctx.isInvalid` after the async rule-set read. */
  readonly isInvalid?: () => boolean;
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
    const redirectDedupe: RedirectDedupe = { lastRedirect: null };

    if (deps.earlyRedirect && !bundledV2) {
      void earlyShortsRedirect({
        win,
        ruleSet: seed as unknown as SignedRuleSet,
        cache,
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
    void script.start().then(() => nudge?.request()).catch(() => script.stop());
    deps.requestReconcile?.();
  };
}
