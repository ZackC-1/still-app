// Who an install is, for analytics, without fingerprinting anyone.
//
// Two ids come out of here:
//
//   * `installId` names this one copy of Still. It lives only in this install's own storage.
//   * `anchorId` names the person as far as we can tell without an account. It is the anonymous
//     analytics identity, and it is shared through the platform's own per-person sync when one
//     exists: iCloud key-value storage for the Apple apps (so an iPhone and a Mac on the same
//     Apple ID share it), and `storage.sync` for the browser extensions (so two computers on the
//     same Google or Firefox account share it). Where there is no such store, the anchor is simply
//     the install id.
//
// A new install that finds an anchor already in that shared store is `returning`: the same person
// has had Still somewhere before. Across ecosystems (an iPhone and Chrome) nothing is shared, and
// only signing in links the two. That is deliberate; matching installs by IP address or device
// traits is fingerprinting, which Apple forbids and Still does not do.

/** A minimal async key-value slot, so the same code runs over chrome.storage, the App Group and
 * iCloud key-value storage. `get` returns undefined/null for a missing key. */
export interface AnalyticsKeyValue {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface AnalyticsIdentity {
  readonly installId: string;
  readonly anchorId: string;
  /** True only on the first start after this install's ids were created. */
  readonly created: boolean;
  /** A freshly created install that found this person's anchor already in the shared store. */
  readonly returning: boolean;
}

export const INSTALL_KEY = "still:analytics:install";
export const ANCHOR_KEY = "still:analytics:anchor";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAnalyticsId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

interface StoredInstall {
  readonly installId: string;
  readonly anchorId: string;
}

function parseStoredInstall(value: unknown): StoredInstall | null {
  if (typeof value !== "object" || value === null) return null;
  const { installId, anchorId } = value as Record<string, unknown>;
  if (!isAnalyticsId(installId) || !isAnalyticsId(anchorId)) return null;
  return { installId, anchorId };
}

export interface ResolveIdentityDeps {
  /** This install's own storage. */
  readonly local: AnalyticsKeyValue;
  /** The per-person synced store, when the platform has one. */
  readonly shared?: AnalyticsKeyValue | null;
  readonly uuid: () => string;
}

/**
 * Read this install's ids, creating them on the first start. Never throws: a shared store that is
 * unavailable (iCloud signed out, sync disabled) only means the anchor cannot be shared, and a
 * local write that fails means the next start tries again.
 */
export async function resolveAnalyticsIdentity(deps: ResolveIdentityDeps): Promise<AnalyticsIdentity> {
  const stored = parseStoredInstall(await deps.local.get(INSTALL_KEY).catch(() => null));
  if (stored) return { ...stored, created: false, returning: false };

  const installId = deps.uuid();
  let anchorId: string | null = null;
  let returning = false;
  if (deps.shared) {
    const existing = await deps.shared.get(ANCHOR_KEY).catch(() => null);
    if (isAnalyticsId(existing)) {
      anchorId = existing;
      returning = true;
    } else {
      anchorId = deps.uuid();
      await deps.shared.set(ANCHOR_KEY, anchorId).catch(() => undefined);
    }
  }
  const record: StoredInstall = { installId, anchorId: anchorId ?? installId };
  await deps.local.set(INSTALL_KEY, record).catch(() => undefined);
  return { ...record, created: true, returning };
}
