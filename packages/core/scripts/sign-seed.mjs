// Signs packages/core/rules/seed.json with the DEV rule-set key and writes the signature back.
//
// The DEV private key below is a FIXED THROWAWAY value — it is NOT a production secret and its
// public half is pinned in DEV_RULE_SET_KEYS (trusted-keys.ts) for local/test use only. The
// production rule set is signed by a human with the real key (never in the loop env; U2/U3).
//
// Run: pnpm --filter @still/core sign-seed   (re-runnable; idempotent for unchanged content)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ed from "@noble/ed25519";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const DEV_PRIVATE_KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const KID = "still-dev-1";

// Must byte-for-byte match canonical.ts (sortDeep + canonicalize), or signatures won't verify.
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}
const canonicalize = (value) => JSON.stringify(sortDeep(value));

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = join(here, "..", "rules", "seed.json");

const seed = JSON.parse(readFileSync(seedPath, "utf8"));
const payload = { version: seed.version, services: seed.services };
const bytes = utf8ToBytes(canonicalize(payload));

const sig = await ed.signAsync(bytes, hexToBytes(DEV_PRIVATE_KEY_HEX));
const pub = await ed.getPublicKeyAsync(hexToBytes(DEV_PRIVATE_KEY_HEX));

seed.signature = { kid: KID, alg: "ed25519", value: bytesToHex(sig) };
writeFileSync(seedPath, JSON.stringify(seed, null, 2) + "\n");

console.log(`signed seed.json  version=${seed.version}  kid=${KID}`);
console.log(`dev publicKeyHex=${bytesToHex(pub)}`);
