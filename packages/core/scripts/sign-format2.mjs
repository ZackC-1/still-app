// Generates and signs packages/core/rules/format2.json, the packaged format-2 rule set the shipping
// content entry admits. The authored source of truth stays in the per-service TypeScript rule
// modules (src/rules/youtube.ts, instagram.ts, facebook.ts); this script copies their surfaces,
// adds the packaged TikTok service alias, and signs the canonical format-2 payload with the DEV
// key, exactly like sign-seed.mjs does for the format-1 seed. Packaged data is admitted by shape
// validation at runtime (the existing format-2 bundled contract); the signature lets tests and
// `--check` prove the committed bytes are the generated ones. It never fetches or publishes.
//
// Run:   pnpm --filter @still/core sign-format2           (rewrite)
//        pnpm --filter @still/core sign-format2 --check   (exit 1 when the file is stale)
//
// The DEV private key below is the same fixed throwaway value sign-seed.mjs uses; its public half
// is pinned in DEV_RULE_SET_KEYS. It is not a production secret and is never trusted in a
// production build's over-the-air verification.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ed from "@noble/ed25519";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const DEV_PRIVATE_KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const KID = "still-dev-1";
const VERSION = "3.0.0";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "rules", "format2.json");
// Node strips the type-only imports in these modules; they carry no runtime dependencies.
const { YOUTUBE_SHORTS_RULES } = await import(join(here, "..", "src", "rules", "youtube.ts"));
const { INSTAGRAM_REELS_RULES } = await import(join(here, "..", "src", "rules", "instagram.ts"));
const { FACEBOOK_REELS_RULES } = await import(join(here, "..", "src", "rules", "facebook.ts"));

/** Plain JSON copy of a frozen rule module (no prototypes, getters or freezing in the artifact). */
const plain = (value) => JSON.parse(JSON.stringify(value));

const services = {
  youtube: plain(YOUTUBE_SHORTS_RULES),
  instagram: plain(INSTAGRAM_REELS_RULES),
  facebook: plain(FACEBOOK_REELS_RULES),
  // The packaged TikTok service alias. Its whole-site decision is consumed only through a trusted
  // blocked-screen host port; without one the shipping entry keeps TikTok on the legacy block.
  tiktok: {
    matches: ["*://*.tiktok.com/*"],
    surfaces: [{ id: "tiktok-site", feature: "tiktok.all", action: "blockSite" }],
  },
};

// Must byte-for-byte match canonical.ts (sortDeep + canonicalize + ruleSetSigningBytesV2).
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

const payload = { format: 2, version: VERSION, services };
const sig = await ed.signAsync(utf8ToBytes(canonicalize(payload)), hexToBytes(DEV_PRIVATE_KEY_HEX));
const signed = { ...payload, signature: { kid: KID, alg: "ed25519", value: bytesToHex(sig) } };
const text = JSON.stringify(signed, null, 2) + "\n";

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(outPath, "utf8");
  } catch {
    /* missing file is stale */
  }
  if (current !== text) {
    console.error("packages/core/rules/format2.json is stale. Run: pnpm --filter @still/core sign-format2");
    process.exit(1);
  }
  console.log(`format2.json is current  version=${VERSION}  kid=${KID}`);
} else {
  writeFileSync(outPath, text);
  console.log(`signed format2.json  version=${VERSION}  kid=${KID}`);
}
