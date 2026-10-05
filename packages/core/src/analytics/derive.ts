// Provider ids derived from a consent permission's private origin handle (U5-W2, owner decision 50:
// one PostHog identity per account per device). The handle O is a random UUID created at Share and
// kept only on the device; it is never sent anywhere. From it:
//
//   erasure key   E       = HMAC-SHA256(key = O, "still:analytics:erasure")          (32 bytes)
//   origin proof  P       = SHA-256(E)                                               (32 bytes)
//   anonymous id  anon(k) = UUID(HMAC-SHA256(key = E, "still:analytics:anon:" + e + ":" + k))
//   device id             = UUID(HMAC-SHA256(key = O, "still:analytics:device"))
//
// O is the lowercase UUID text as UTF-8 bytes; E is used as raw bytes. UUID(h) is the first 16 bytes
// of h with the RFC 9562 version-4 and variant bits set. Index 0 is the id at Share; each sign-out
// moves to the next index (never a reused id), up to ANON_INDEX_LIMIT. The epoch e stays 0 until the
// retention unit (U5-W3) decides otherwise.
//
// What leaves the device, and the power it gives:
//   * P, at every signed-in identify: lets Still's server issue and look up this device's subject.
//     It gives no power to erase or to read erasure status (those need E, P's preimage).
//   * E, only when this device asks to erase itself: the server derives anon(0..k) from it and
//     finds the device's subjects by SHA-256(P). The request carries no id, so nobody can point an
//     erasure at an id they merely know.
//   * the anonymous ids themselves, which PostHog already receives as distinct ids.
// The same derivation runs in SQL (migration 0017, private.analytics_anonymous_ids); the reference
// vectors in __tests__/derive.test.ts and supabase/tests/analytics_erasure_migration_test.ts must
// agree.

export const ANON_INDEX_LIMIT = 255;
export const ANALYTICS_EPOCH = 0;

const encoder = new TextEncoder();
const ORIGIN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function originBytes(origin: string): Uint8Array {
  if (!ORIGIN.test(origin)) throw new Error("A derived id needs a lowercase UUID origin");
  return encoder.encode(origin);
}

async function hmac(key: Uint8Array, label: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(label) as BufferSource));
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error("Lowercase hex expected");
  return new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
}

/** The first 16 bytes as a version-4, RFC 9562 variant UUID string. */
export function uuidFromDigest(digest: Uint8Array): string {
  if (digest.length < 16) throw new Error("A derived id needs 16 bytes");
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function checkIndex(index: number, epoch: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index > ANON_INDEX_LIMIT) {
    throw new Error("Anonymous id index out of range");
  }
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Analytics epoch out of range");
}

/** E: the bearer key for this device's own erasure. Sent only in an erasure request. */
export async function erasureKey(origin: string): Promise<Uint8Array> {
  return await hmac(originBytes(origin), "still:analytics:erasure");
}

/** anon(k) from the erasure key: the derivation the server repeats in SQL. */
export async function anonymousIdFromKey(key: Uint8Array, index: number, epoch = ANALYTICS_EPOCH): Promise<string> {
  checkIndex(index, epoch);
  if (key.length !== 32) throw new Error("An erasure key is 32 bytes");
  return uuidFromDigest(await hmac(key, `still:analytics:anon:${epoch}:${index}`));
}

export async function deriveAnonymousId(origin: string, index: number, epoch = ANALYTICS_EPOCH): Promise<string> {
  checkIndex(index, epoch);
  return await anonymousIdFromKey(await erasureKey(origin), index, epoch);
}

export async function deriveDeviceId(origin: string): Promise<string> {
  return uuidFromDigest(await hmac(originBytes(origin), "still:analytics:device"));
}

/** Every anonymous id this origin has used, index 0 through `lastIndex`. */
export async function deriveAnonymousIds(origin: string, lastIndex: number): Promise<string[]> {
  checkIndex(lastIndex, ANALYTICS_EPOCH);
  const key = await erasureKey(origin);
  return await Promise.all(Array.from({ length: lastIndex + 1 }, (_, k) => anonymousIdFromKey(key, k)));
}

/** P = SHA-256(E): what the server knows this device by. No power to erase. */
export async function proofFromKey(key: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", key as BufferSource)));
}

export async function originProof(origin: string): Promise<string> {
  return await proofFromKey(await erasureKey(origin));
}
