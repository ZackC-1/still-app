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
