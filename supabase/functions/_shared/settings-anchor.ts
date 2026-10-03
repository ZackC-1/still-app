/**
 * Server-only settings revision receipts. This module is deliberately unconsumed.
 * A receipt authenticates an anchor, not account access or an entire write request.
 * The adapter must independently verify JWTs, retrieve the subject's private key,
 * and lock/recheck the live row lineage and operation bases during mutation.
 * Never send this key to browser/Apple clients or reuse auth/rule/proof keys.
 */
export interface SettingsAnchorReceipt {
  readonly version: 1;
  readonly lineage: string;
  readonly revision: number;
  readonly mac: string;
}

/** Trusted server state; never construct this context from request body claims. */
export interface SettingsAnchorState {
  readonly subject: string;
  readonly key: Uint8Array;
  readonly lineage: string;
  /** Actual current canonical row revision, also the verification ceiling. */
  readonly revision: number;
}

const PURPOSE = "still-settings-anchor-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;
const RECEIPT_KEYS = ["version", "lineage", "revision", "mac"];

function validUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && UUID.test(value);
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && !Object.is(value, -0);
}

function validState(state: SettingsAnchorState): boolean {
  return validUuid(state.subject) && validUuid(state.lineage) &&
    validRevision(state.revision) &&
    state.key instanceof Uint8Array && state.key.byteLength === 32;
}

function encodeMac(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");
}

function decodeMac(value: string): Uint8Array<ArrayBuffer> | null {
  if (value.length !== 43 || !MAC.test(value)) return null;
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // Reject alternate unused pad bits that permissive decoders map to the same MAC.
  return bytes.byteLength === 32 && encodeMac(bytes) === value ? bytes : null;
}

function parseReceipt(value: unknown): SettingsAnchorReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== RECEIPT_KEYS.length ||
    keys.some((key) => !RECEIPT_KEYS.includes(key as string))
  ) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  // The wire grammar contains data values, never inherited properties or accessors.
  if (RECEIPT_KEYS.some((key) => !("value" in fields[key]!))) return null;
  const version: unknown = fields.version!.value;
  const lineage: unknown = fields.lineage!.value;
  const revision: unknown = fields.revision!.value;
  const mac: unknown = fields.mac!.value;
  if (
    version !== 1 || !validUuid(lineage) || !validRevision(revision) ||
    typeof mac !== "string"
  ) return null;
  return { version, lineage, revision, mac };
}

function anchorBytes(
  subject: string,
  lineage: string,
  revision: number,
): Uint8Array<ArrayBuffer> {
  // Validated UUIDs and safe unsigned integers ensure ASCII, canonical decimal,
  // exactly four lines and no trailing newline. No clock or receiving-time clamp.
  return new TextEncoder().encode(
    `${PURPOSE}\n${subject}\n${lineage}\n${revision}`,
  );
}

function importKey(key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** Persist privately with account ownership and FK cascade in the future adapter. */
export function createSettingsAnchorIdentity(): {
  key: Uint8Array<ArrayBuffer>;
  lineage: string;
} {
  return {
    key: crypto.getRandomValues(new Uint8Array(32)),
    lineage: crypto.randomUUID(),
  };
}

/**
 * Version 1 wire choice: {version:1,lineage,revision,mac}; mac is canonical
 * unpadded base64url of 32 bytes (43 characters). No alternate encodings/fields.
 */
export async function issueSettingsAnchorReceipt(
  state: SettingsAnchorState,
): Promise<SettingsAnchorReceipt> {
  if (!validState(state)) {
    throw new TypeError("Invalid settings anchor server state");
  }
  const { subject, lineage, revision, key } = state;
  const signingKey = await importKey(key, "sign");
  const mac = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    anchorBytes(subject, lineage, revision),
  );
  return { version: 1, lineage, revision, mac: encodeMac(new Uint8Array(mac)) };
}

/**
 * Return a validated receipt snapshot or null. Old receipts remain usable in the
 * same live lineage up to the current row revision; there is no clock expiry or
 * retry rebasing. SQL must recheck lineage/bounds while locked to cover deletion
 * racing this check. Ordinary operation bases must separately equal its revision.
 */
export async function verifySettingsAnchorReceipt(
  value: unknown,
  state: SettingsAnchorState,
): Promise<SettingsAnchorReceipt | null> {
  const receipt = parseReceipt(value);
  if (!receipt || !validState(state)) return null;
  const { subject, lineage, revision, key } = state;
  if (receipt.lineage !== lineage || receipt.revision > revision) return null;
  const mac = decodeMac(receipt.mac);
  if (!mac) return null;
  const verificationKey = await importKey(key, "verify");
  const valid = await crypto.subtle.verify(
    "HMAC",
    verificationKey,
    mac,
    anchorBytes(subject, receipt.lineage, receipt.revision),
  );
  return valid ? receipt : null;
}
