import { assert } from "@std/assert";
import { accessSigningBytes } from "@still/shared-types";
const decode = (text: string) =>
  Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export async function verifyServedAccessProof(
  text: unknown,
  kind: string,
  holder: string,
  kid: string,
  publicKey: CryptoKey,
) {
  assert(typeof text === "string");
  const envelope: unknown = JSON.parse(text);
  assert(
    plain(envelope) &&
      envelope.kid === kid &&
      envelope.alg === "ed25519" &&
      typeof envelope.payload === "string" &&
      typeof envelope.signature === "string",
  );
  const payload = new TextDecoder().decode(decode(envelope.payload));
  assert(
    await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      decode(envelope.signature),
      new Uint8Array(accessSigningBytes(payload)),
    ),
    "served signature invalid",
  );
  const claims: unknown = JSON.parse(payload);
  assert(
    plain(claims) &&
      claims.environment === "sandbox" &&
      claims.kind === kind &&
      claims.holder === holder,
  );
  assert(
    typeof claims.verified_at === "number" &&
      typeof claims.expires_at === "number" &&
      claims.expires_at - claims.verified_at === 30 * 24 * 60 * 60 * 1000,
  );
  return claims;
}
