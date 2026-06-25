import type { TrustedKey } from "./signature.js";

// Rollback floor: clients reject any validly-signed set below this version (KTD8).
export const RULE_SET_MIN_VERSION = "1.0.0";

/**
 * Production rule-set signing public keys (current + next rotation). The matching PRIVATE keys are
 * human deploy-only secrets that never enter the loop environment / git (KTD8) — generated via
 * `pnpm --filter @still/core gen-rule-set-key` and held in a secret manager. To rotate, ADD the new
 * key here alongside the current one, ship that build, then sign with the new key (drop the old key
 * only after the prior build is out of the field).
 */
export const PRODUCTION_RULE_SET_KEYS: readonly TrustedKey[] = [
  { kid: "still-prod-1", publicKeyHex: "0e516d9fbf6f21bbde76b1fa03d3284264305fd9b687e528dac926eb2b8a1a36" },
];

/**
 * Dev/local signing key. Signs the bundled seed and the local Supabase seed migration so the fetch
 * + verify path (U12) can be exercised end-to-end with zero production secrets. The private half
 * lives only in `scripts/sign-seed.mjs` (a fixed throwaway value, never a real secret). NOT trusted
 * in production builds — production uses PRODUCTION_RULE_SET_KEYS.
 */
export const DEV_RULE_SET_KEYS: readonly TrustedKey[] = [
  { kid: "still-dev-1", publicKeyHex: "3ccd241cffc9b3618044b97d036d8614593d8b017c340f1dee8773385517654b" },
];
