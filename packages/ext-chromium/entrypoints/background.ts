import { SettingsCache, ChromeStorageAdapter } from "@still/core/storage";
import { refreshRuleSetCache, ruleSetFetchConfig, type RuleSetEndpoint } from "@still/core/rules";

// Chromium/Firefox background. Two independent jobs:
//   • Signed rule-set refresh (parity with the Safari background): fetch → verify against this
//     build's trusted keys → cache for the NEXT page load, so a selector hotfix reaches
//     Chrome/Firefox over the air instead of waiting on a store re-review (KTD13). Skipped (no-op)
//     when no endpoint is configured, or on a production build before production keys are
//     published — in both cases the bundled seed keeps applying.
//   • DNR gating (Chromium only): the static Shorts-redirect ruleset (KTD1) is enabled only when
//     YouTube is on globally and youtube.com isn't paused. The Firefox build ships no DNR ruleset
//     (it redirects via the content script), so that wiring bails cleanly when the API is absent.
const RULESET_ID = "youtube-shorts-redirect";

/** The signed rule-set RPC endpoint, from the gitignored build-time .env. Absent in CI/dev → null,
 * so the fetch is skipped and the content script applies the bundled seed. */
function ruleSetEndpointFromEnv(): RuleSetEndpoint | null {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  return url && anonKey ? { url, anonKey } : null;
}

export default defineBackground(() => {
  const ruleSetCfg = ruleSetFetchConfig({
    prod: import.meta.env.PROD,
    endpoint: ruleSetEndpointFromEnv(),
  });

  // Refresh on cold start / service-worker wake, and on a content-script nudge (fired at
  // document_start, which also wakes the worker — so the cache stays fresh while the user browses).
  void refreshRuleSetCache(ruleSetCfg, chrome.storage.local);
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (message && typeof message === "object" && (message as { kind?: string }).kind === "reconcile") {
      void refreshRuleSetCache(ruleSetCfg, chrome.storage.local);
    }
    return false;
  });

  // DNR gating — Chromium only from here down.
  if (!chrome.declarativeNetRequest?.updateEnabledRulesets) return;

  const cache = new SettingsCache(new ChromeStorageAdapter());

  const syncRuleset = async (): Promise<void> => {
    const s = cache.current();
    const enabled = s.globalOn && s.services.youtube && !s.pauses.includes("youtube.com");
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      enabled ? { enableRulesetIds: [RULESET_ID] } : { disableRulesetIds: [RULESET_ID] },
    );
  };

  cache.subscribe(() => void syncRuleset());
  cache.watch();
  void cache.hydrate().then(syncRuleset);
});
