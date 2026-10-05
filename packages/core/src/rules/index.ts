// @still/core/rules — rule-set validation, signing, and (U6) the engine.

export {
  canonicalize,
  ruleSetSigningBytes,
  ruleSetSigningBytesV2,
} from "./canonical.js";
export { compareVersions, VERSION_RE } from "./version.js";
export {
  validateRuleSet,
  validateRuleSetV2,
  isSafeSelector,
  type ValidationResult,
  type ValidationResultV2,
} from "./schema.js";
export {
  signRuleSet,
  verifyRuleSet,
  signRuleSetV2,
  verifyRuleSetV2,
  publicKeyHexFor,
  type TrustedKey,
  type VerifyOptions,
  type VerifyResult,
} from "./signature.js";
export {
  RULE_SET_MIN_VERSION,
  PRODUCTION_RULE_SET_KEYS,
  DEV_RULE_SET_KEYS,
} from "./trusted-keys.js";
export {
  urlMatchesPattern,
  resolveService,
  etldPlusOne,
  applyRedirectTemplate,
} from "./match.js";
export {
  evaluate,
  applyDom,
  applyRemovals,
  createEnginePageSession,
  renderPlaceholder,
  isServiceActive,
  isServiceEnabledGlobally,
  isPaused,
  ROOT_ACTIVE_CLASS,
  STILL_PLACEHOLDER_LINE,
  type Decision,
  type ApplyResult,
  type EnginePageSession,
} from "./engine.js";
export {
  fetchCurrentRuleSet,
  resolveRuleSet,
  type FetchConfig,
  type RuleSetEndpoint,
  type ResolvedRuleSet,
  type RuleSetSource,
  type RuleFormat,
  type RuleSetFor,
  type AnySignedRuleSet,
} from "./fetch.js";
export {
  serviceHasFreeSurface,
  proServiceIds,
  PRO_SERVICE_IDS,
} from "./tiers.js";
export {
  ruleSetTrustedKeys,
  ruleSetTrust,
  ruleSetFetchConfig,
  createRuleSetRefresher,
  readCachedRuleSet,
  writeCachedRuleSet,
  refreshRuleSetCache,
  resolveRuleSetForLoad,
  type ReadableArea,
  type RuleSetTrust,
  type WritableArea,
} from "./loader.js";
export {
  planNavigationDnr,
  NAVIGATION_DNR_RULE_IDS,
  type NavigationDnrInput,
  type NavigationDnrPlan,
  type NavigationDnrRule,
} from "./navigation-dnr.js";
export { admitPackagedRuleSetV2, PACKAGED_RULE_SET_V2 } from "./packaged.js";
