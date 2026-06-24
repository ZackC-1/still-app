import { SettingsCache, ChromeStorageAdapter } from "@still/core/storage";

// Gates the static Shorts-redirect ruleset (KTD1) on settings: the network-layer redirect is
// enabled only when YouTube is on globally and the user hasn't paused youtube.com. Reacts to
// settings changes from the popup / options page.
const RULESET_ID = "youtube-shorts-redirect";

export default defineBackground(() => {
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
