// Reference vectors for derive.ts. The KEY vectors are shared with the SQL derivation in migration
// 0017 (supabase/tests/analytics_erasure_migration_test.ts asserts the same values): the server
// derives a device's anonymous ids from its erasure key, so both sides must agree byte for byte.
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ANON_INDEX_LIMIT,
  anonymousIdFromKey,
  deriveAnonymousId,
  deriveAnonymousIds,
  deriveDeviceId,
  erasureKey,
  fromHex,
  originProof,
  proofFromKey,
  toHex,
} from "../derive.js";
import { isAnalyticsId } from "../identity.js";

const ORIGIN = "5f1c2a3e-8b7d-4c6a-9e0f-1a2b3c4d5e6f";
/** Bytes 0x00..0x1f: the erasure key the SQL test also uses. */
const KEY = toHex(new Uint8Array(32).map((_, i) => i));
const SHARED_KEY_VECTORS = {
  key: KEY,
  proof: "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd",
  anon: {
    0: "0dabc01d-ecd0-4609-ba4e-3e6042fc943d",
    1: "4014f145-283a-46f9-a903-62884494004e",
    7: "b183e157-7bab-4097-ba43-d08a5a62d8bc",
  },
} as const;

const node = {
  uuid(digest: Buffer) {
    const b = Buffer.from(digest.subarray(0, 16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  },
};

describe("derived provider ids (derive.ts)", () => {
  it("matches the fixed origin vectors and an independent implementation", async () => {
    // Any change to a label, the key encoding or the UUID layout changes these.
    expect(toHex(await erasureKey(ORIGIN))).toBe("e70a35bc6a2c395443165da4e69de795a2e2b0905f92dadb1c4000dd2519219f");
    expect(await originProof(ORIGIN)).toBe("544263b84bac4c8f6311eaa8051bc9b37f97a06d645d7207dd89bcf04c44f65e");
    expect(await deriveAnonymousId(ORIGIN, 0)).toBe("389476c9-44ba-4c01-9e46-f20cc9fa5864");
    expect(await deriveAnonymousId(ORIGIN, 1)).toBe("11ed54e1-7784-417f-aa07-7581c61a2488");
    expect(await deriveAnonymousId(ORIGIN, 255)).toBe("a91074f0-37d0-4625-8d20-20f342bb95b6");
    expect(await deriveDeviceId(ORIGIN)).toBe("04051239-75c6-428e-9dda-af277e430dfe");
    const e = createHmac("sha256", Buffer.from(ORIGIN)).update("still:analytics:erasure").digest();
    for (const k of [0, 7, 42]) {
      expect(await deriveAnonymousId(ORIGIN, k)).toBe(
        node.uuid(createHmac("sha256", e).update(`still:analytics:anon:0:${k}`).digest()),
      );
    }
    expect(await originProof(ORIGIN)).toBe(createHash("sha256").update(e).digest("hex"));
  });

  it("matches the key vectors the SQL derivation (migration 0017) must also produce", async () => {
    const key = fromHex(SHARED_KEY_VECTORS.key);
    expect(await proofFromKey(key)).toBe(SHARED_KEY_VECTORS.proof);
    for (const [k, id] of Object.entries(SHARED_KEY_VECTORS.anon)) {
      expect(await anonymousIdFromKey(key, Number(k))).toBe(id);
    }
  });

  it("derives distinct valid ids, and neither the proof nor an id reveals the key or the origin", async () => {
    const ids = await deriveAnonymousIds(ORIGIN, 9);
    expect(new Set(ids).size).toBe(10);
    expect(ids.every(isAnalyticsId)).toBe(true);
    expect(ids).not.toContain(await deriveDeviceId(ORIGIN));
    const key = toHex(await erasureKey(ORIGIN));
    const proof = await originProof(ORIGIN);
    expect(proof).not.toBe(key);
    expect(proof).not.toContain(ORIGIN.replaceAll("-", ""));
    expect(key).not.toContain(ORIGIN.replaceAll("-", ""));
    await expect(deriveAnonymousId(ORIGIN, ANON_INDEX_LIMIT + 1)).rejects.toThrow();
    await expect(deriveAnonymousId(ORIGIN.toUpperCase(), 0)).rejects.toThrow();
    await expect(anonymousIdFromKey(new Uint8Array(31), 0)).rejects.toThrow();
  });
});
