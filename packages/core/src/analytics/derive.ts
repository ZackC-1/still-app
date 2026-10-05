// Provider ids derived from a consent permission's private origin handle (U5-W2, owner decision 50:
// one PostHog identity per account per device). The handle is a random UUID created at Share and
// kept only on the device. From it alone the device can always name every anonymous id it sent,
// so turning sharing off can delete all of them and nothing from any other device:
//
//   anonymous id (epoch e, index k) = UUID(HMAC-SHA256(key = O, "still:analytics:anon:" + e + ":" + k))
//   device id                       = UUID(HMAC-SHA256(key = O, "still:analytics:device"))
//   origin proof                    = hex(SHA-256(O))
//
// O is the lowercase UUID text, as UTF-8 bytes. UUID(h) is the first 16 bytes of h with the RFC 9562
// version-4 and variant bits set, so every derived id is an ordinary random-format UUID. Index 0 is
// the id at Share; each sign-out moves to the next index (never a reused id), up to ANON_INDEX_LIMIT.
// The epoch stays 0 until the retention unit (U5-W3) decides otherwise.
//
// The handle never leaves the device. Still's server sees only the origin proof (a one-way hash,
// sent to issue this device's signed-in identity and to request its erasure) and the anonymous ids
// themselves, which PostHog already holds. Reference vectors: __tests__/derive.test.ts.

export const ANON_INDEX_LIMIT = 255;
export const ANALYTICS_EPOCH = 0;

const encoder = new TextEncoder();
const ORIGIN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function originBytes(origin: string): Uint8Array {
  if (!ORIGIN.test(origin)) throw new Error("A derived id needs a lowercase UUID origin");
  return encoder.encode(origin);
}

async function hmac(origin: string, label: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    originBytes(origin) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(label) as BufferSource));
}

/** The first 16 bytes as a version-4, RFC 9562 variant UUID string. */
export function uuidFromDigest(digest: Uint8Array): string {
  if (digest.length < 16) throw new Error("A derived id needs 16 bytes");
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function deriveAnonymousId(origin: string, index: number, epoch = ANALYTICS_EPOCH): Promise<string> {
  if (!Number.isSafeInteger(index) || index < 0 || index > ANON_INDEX_LIMIT) {
    throw new Error("Anonymous id index out of range");
  }
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Analytics epoch out of range");
  return uuidFromDigest(await hmac(origin, `still:analytics:anon:${epoch}:${index}`));
}

export async function deriveDeviceId(origin: string): Promise<string> {
  return uuidFromDigest(await hmac(origin, "still:analytics:device"));
}

/** Every anonymous id this origin has used, index 0 through `lastIndex`. */
export async function deriveAnonymousIds(origin: string, lastIndex: number): Promise<string[]> {
  if (!Number.isSafeInteger(lastIndex) || lastIndex < 0 || lastIndex > ANON_INDEX_LIMIT) {
    throw new Error("Anonymous id index out of range");
  }
  return await Promise.all(Array.from({ length: lastIndex + 1 }, (_, k) => deriveAnonymousId(origin, k)));
}

/** The one-way proof the server knows this device by. Never the origin itself. */
export async function originProof(origin: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", originBytes(origin) as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
