// @still/core/rules — rule-set validation, signing, and (U6) the engine.

export { canonicalize, ruleSetSigningBytes } from "./canonical.js";
export { compareVersions, VERSION_RE } from "./version.js";
export { validateRuleSet, isSafeSelector, type ValidationResult } from "./schema.js";
export {
  signRuleSet,
  verifyRuleSet,
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
  generateHideCss,
  renderPlaceholder,
  isServiceActive,
  isPaused,
  ROOT_ACTIVE_CLASS,
  STILL_PLACEHOLDER_LINE,
  type Decision,
  type ApplyResult,
} from "./engine.js";
export {
  fetchCurrentRuleSet,
  resolveRuleSet,
  type FetchConfig,
  type RuleSetEndpoint,
  type ResolvedRuleSet,
  type RuleSetSource,
} from "./fetch.js";
export {
  ruleSetTrustedKeys,
  ruleSetFetchConfig,
  readCachedRuleSet,
  writeCachedRuleSet,
  refreshRuleSetCache,
  resolveRuleSetForLoad,
  type ReadableArea,
  type WritableArea,
} from "./loader.js";
