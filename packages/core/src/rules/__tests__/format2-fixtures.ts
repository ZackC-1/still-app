import { FEATURE_IDS, type BenefitId, type SettingsV2, type SignedRuleSetV2 } from "@still/shared-types";
import { initialAccessSnapshot } from "../../entitlement/access-policy.js";
import { migrateSettingsV2 } from "../../storage/settings-v2.js";

const initialized = migrateSettingsV2(null, { kind: "proven-fresh" });
if (initialized.status !== "ready") throw new Error("Synthetic fresh settings did not initialize");
const DEFAULT_SETTINGS_V2 = initialized.settings;
const capabilities = new Set<BenefitId>([...FEATURE_IDS, "tiktok.all"]);
const ruleSet: SignedRuleSetV2 = { format: 2, version: "3.0.0", signature: { kid: "synthetic-only", alg: "ed25519", value: "0".repeat(128) }, services: {
  youtube: { matches: ["*://*.youtube.com/*"], surfaces: [
    { id: "synthetic-shorts", feature: "youtube.shorts", action: "hide", selectors: [".shorts:not(:has(.preserve))", ".recycled[data-kind='short']"] },
    { id: "synthetic-comments", feature: "youtube.comments", action: "hide", selectors: [".comments, .comments-second"] },
  ] },
  instagram: { matches: ["*://*.instagram.com/*"], surfaces: [{ id: "synthetic-reels", feature: "instagram.reels", action: "hide", selectors: [".shorts"] }] },
  tiktok: { matches: ["*://*.tiktok.com/*"], surfaces: [{ id: "synthetic-tiktok", feature: "tiktok.all", action: "blockSite" }] },
} };
const on: SettingsV2 = { ...DEFAULT_SETTINGS_V2, sites: { ...DEFAULT_SETTINGS_V2.sites, "youtube.comments": true } };
const access = initialAccessSnapshot({ paidMode: false, supported: capabilities });
const url = new URL("https://www.youtube.com/");
export { ruleSet, on, access, capabilities, url, DEFAULT_SETTINGS_V2 };
