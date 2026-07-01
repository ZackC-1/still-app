// The Safari entitlement pull, extracted from the background entrypoint so it is unit-testable with
// injected deps. The app mirrors its server-reconciled entitlement into the App Group (StillKit
// EntitlementBridge); the background pulls it via a {kind:"getEntitlement"} native message and
// writes it into browser.storage (`still:entitlement`), where the content scripts' EntitlementCache
// reads it. The app's `updatedAt` (last server-confirmed time) is preserved so the extension's
// 30-day offline TTL measures from real server contact, not from the pull.

/** The App-Group record shape the native EntitlementBridge replies with. */
export interface NativeEntitlementRecord {
  readonly entitled: boolean;
  readonly updatedAt: number;
}

/** Coerce a native `{ entitlement: "<json>" }` reply into a record, or null (no value stored,
 * native host unavailable, or a malformed reply — the caller then leaves storage untouched). */
export function parseNativeEntitlement(reply: unknown): NativeEntitlementRecord | null {
  if (!reply || typeof reply !== "object") return null;
  const raw = (reply as { entitlement?: unknown }).entitlement;
  if (typeof raw !== "string" || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { entitled, updatedAt } = parsed as { entitled?: unknown; updatedAt?: unknown };
  if (typeof entitled !== "boolean") return null;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  return { entitled, updatedAt };
}

/** Where the pulled record lands (ChromeEntitlementAdapter in production, a fake in tests). */
export interface EntitlementSink {
  set(entitled: boolean, updatedAt?: number): Promise<void>;
}

/** Apply a pulled record to local entitlement storage. A null record is a no-op — never downgrade
 * on "couldn't read" (the storage TTL already bounds staleness); a real revocation arrives as an
 * explicit `entitled:false` record. Returns whether a write happened. */
export async function applyNativeEntitlement(
  record: NativeEntitlementRecord | null,
  sink: EntitlementSink,
): Promise<boolean> {
  if (!record) return false;
  await sink.set(record.entitled, record.updatedAt);
  return true;
}
