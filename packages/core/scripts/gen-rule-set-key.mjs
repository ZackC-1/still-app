// Generate a PRODUCTION Ed25519 rule-set signing keypair.
//
// Security model (KTD8): the PRIVATE key is a deploy-only secret that must NEVER enter git, CI, or the
// shipped app/extension bundle. Only the PUBLIC key is pinned in PRODUCTION_RULE_SET_KEYS so clients
// can verify fetched rule sets. This script writes the private key to a gitignored local file and
// prints ONLY the public key — so the secret never lands in a terminal transcript.
//
// Run once:  pnpm --filter @still/core gen-rule-set-key   [kid]      (default kid: still-prod-1)
// Then:      paste the printed publicKeyHex line into packages/core/src/rules/trusted-keys.ts,
//            move the private-key file into your secret manager, and delete it.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ed from "@noble/ed25519";
import { bytesToHex } from "@noble/hashes/utils.js";

const KID = process.argv[2] || "still-prod-1";
const here = dirname(fileURLToPath(import.meta.url));
const secretsDir = join(here, "..", ".secrets");
const keyPath = join(secretsDir, "rule-set-prod-key.local");

if (existsSync(keyPath)) {
  console.error(`Refusing to overwrite an existing key file:\n  ${keyPath}`);
  console.error("Delete it first only if you intend to ROTATE the production key.");
  process.exit(1);
}

// An Ed25519 private key is 32 random bytes.
const priv = crypto.getRandomValues(new Uint8Array(32));
const pub = await ed.getPublicKeyAsync(priv);

mkdirSync(secretsDir, { recursive: true });
writeFileSync(keyPath, `${bytesToHex(priv)}\n`, { mode: 0o600 });

console.log("Production rule-set keypair generated.\n");
console.log("1) Paste this into PRODUCTION_RULE_SET_KEYS (packages/core/src/rules/trusted-keys.ts):");
console.log(`     { kid: "${KID}", publicKeyHex: "${bytesToHex(pub)}" },\n`);
console.log("2) The PRIVATE key was written to a gitignored file:");
console.log(`     ${keyPath}`);
console.log("   Move it into your secret manager (1Password, etc.), then delete the file.");
console.log("   sign-prod-set.mjs reads it from this file or from STILL_PROD_PRIVATE_KEY_HEX.\n");
console.log(`kid=${KID}`);
