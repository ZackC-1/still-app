import type { TrustedKey } from "./signature.js";

// Rollback floor: clients reject any validly-signed set below this version (KTD8).
export const RULE_SET_MIN_VERSION = "1.0.0";

/**
 * Production rule-set signing public keys (current + next rotation). The matching PRIVATE keys are
 * human deploy-only secrets that never enter the loop environment (U2/U3). Populate when the human
 * generates the production signing key, e.g.:
 *   { kid: "still-prod-1", publicKeyHex: "<64 hex chars>" }
 */
export const PRODUCTION_RULE_SET_KEYS: readonly TrustedKey[] = [];

/**
 * Dev/local signing key. Signs the bundled seed and the local Supabase seed migration so the fetch
 * + verify path (U12) can be exercised end-to-end with zero production secrets. The private half
 * lives only in `scripts/sign-seed.mjs` (a fixed throwaway value, never a real secret). NOT trusted
 * in production builds — production uses PRODUCTION_RULE_SET_KEYS.
 */
export const DEV_RULE_SET_KEYS: readonly TrustedKey[] = [
  { kid: "still-dev-1", publicKeyHex: "3ccd241cffc9b3618044b97d036d8614593d8b017c340f1dee8773385517654b" },
];
