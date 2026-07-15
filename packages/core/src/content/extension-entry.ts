import seed from "../../rules/seed.json";
import type { SignedRuleSet } from "@still/shared-types";
import { EntitlementCache, ChromeEntitlementAdapter } from "../entitlement/index.js";
import {
  resolveRuleSetForLoad,
  ruleSetTrust,
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
  attach(script: ContentScriptHandle, context: ExtensionContentContext): { request(): void };
}

export interface ExtensionContentEntryDeps {
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
export function createExtensionContentEntry(deps: ExtensionContentEntryDeps): (
  context?: ExtensionContentContext,
) => Promise<void> {
  return async (context = {}): Promise<void> => {
    const win = deps.win ?? (window as unknown as StillWindow);
    const doc = deps.doc ?? document;
    const cache = new SettingsCache(new ChromeStorageAdapter());
    const entitlement = new EntitlementCache(new ChromeEntitlementAdapter());
    const redirectDedupe: RedirectDedupe = { lastRedirect: null };

    if (deps.earlyRedirect) {
      void earlyShortsRedirect({
        win,
        ruleSet: seed as unknown as SignedRuleSet,
        cache,
        redirectDedupe,
      }).catch(() => {});
    }

    const { ruleSet, source } = await resolveRuleSetForLoad(
      seed as unknown as SignedRuleSet,
      deps.storage,
      ruleSetTrust(deps.prod),
    );
    if (context.isInvalid || deps.isInvalid?.()) return;

    const script = createContentScript({
      win,
      doc,
      ruleSet,
      cache,
      entitlement,
      redirectDedupe,
      manifestCssOwnsHides: source === "bundled",
    });
    deps.onScriptCreated?.(script);
    const nudge = deps.nudge?.attach(script, context);
    deps.onStart?.();
    void script.start().then(() => nudge?.request());
    deps.requestReconcile?.();
  };
}
