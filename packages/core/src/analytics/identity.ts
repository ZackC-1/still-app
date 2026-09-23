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
  /** An earlier anonymous id of this install that must be merged into `anchorId`: the shared
   * store delivered a different person anchor after this install had started with its own (sync
   * arrived late, or two devices raced). The client sends one `$create_alias` for it. */
  readonly aliasOf?: string;
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
  /**
   * Where the anchor came from: made by this install ("local"), or received from the shared store
   * ("shared"). Only a local anchor may ever be merged into another one. An anchor received from the
   * shared store may already be another install's merge destination, and aliasing it again would
   * build a chain PostHog refuses; so a "shared" anchor is kept for good.
   */
  readonly origin?: "local" | "shared";
  /** An earlier anchor merged into this one, kept so the merge can be sent whenever sharing allows
   * (the client sends it once, and again if a discarded queue lost it). */
  readonly aliasOf?: string;
}

function parseStoredInstall(value: unknown): StoredInstall | null {
  if (typeof value !== "object" || value === null) return null;
  const { installId, anchorId, aliasOf, origin } = value as Record<string, unknown>;
  if (!isAnalyticsId(installId) || !isAnalyticsId(anchorId)) return null;
  const from = origin === "shared" ? "shared" : "local";
  return isAnalyticsId(aliasOf) && aliasOf !== anchorId
    ? { installId, anchorId, aliasOf, origin: from }
    : { installId, anchorId, origin: from };
}

export interface ResolveIdentityDeps {
  /** This install's own storage. */
  readonly local: AnalyticsKeyValue;
  /** The per-person synced store, when the platform has one. */
  readonly shared?: AnalyticsKeyValue | null;
  readonly uuid: () => string;
  /** On a fresh install, how long to wait for the shared store to deliver this person's anchor
   * before deciding they are new. Browser sync fills storage.sync some moments after install; a
   * decision made before then calls a second computer a first install. */
  readonly sharedGraceMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Read this install's ids, creating them on the first start. Never throws: a shared store that is
 * unavailable (iCloud signed out, sync disabled) only means the anchor cannot be shared, and a
 * local write that fails means the next start tries again.
 */
export async function resolveAnalyticsIdentity(deps: ResolveIdentityDeps): Promise<AnalyticsIdentity> {
  const stored = parseStoredInstall(await deps.local.get(INSTALL_KEY).catch(() => null));
  if (stored) {
    // Sync can deliver the person's anchor after this install made its own; adopt it and ask for
    // the earlier id to be merged, so one person does not stay split in two.
    // At most once per install: a second adoption would alias into an id that was itself an alias
    // destination, which PostHog refuses. The first adopted anchor stays canonical.
    const adoptable = deps.shared && !stored.aliasOf && stored.origin !== "shared";
    const shared = adoptable ? await deps.shared!.get(ANCHOR_KEY).catch(() => null) : null;
    if (isAnalyticsId(shared) && shared !== stored.anchorId) {
      const record: StoredInstall = { installId: stored.installId, anchorId: shared, aliasOf: stored.anchorId, origin: "shared" };
      await deps.local.set(INSTALL_KEY, record).catch(() => undefined);
      return { installId: record.installId, anchorId: record.anchorId, aliasOf: record.aliasOf, created: false, returning: false };
    }
    return stored.aliasOf
      ? { installId: stored.installId, anchorId: stored.anchorId, aliasOf: stored.aliasOf, created: false, returning: false }
      : { installId: stored.installId, anchorId: stored.anchorId, created: false, returning: false };
  }

  const installId = deps.uuid();
  let anchorId: string | null = null;
  let returning = false;
  if (deps.shared) {
    let existing = await deps.shared.get(ANCHOR_KEY).catch(() => null);
    if (!isAnalyticsId(existing) && deps.sharedGraceMs) {
      await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(deps.sharedGraceMs);
      existing = await deps.shared.get(ANCHOR_KEY).catch(() => null);
    }
    if (isAnalyticsId(existing)) {
      anchorId = existing;
      returning = true;
    } else {
      anchorId = deps.uuid();
      await deps.shared.set(ANCHOR_KEY, anchorId).catch(() => undefined);
    }
  }
  const record: StoredInstall = { installId, anchorId: anchorId ?? installId, origin: returning ? "shared" : "local" };
  await deps.local.set(INSTALL_KEY, record).catch(() => undefined);
  return { installId: record.installId, anchorId: record.anchorId, created: true, returning };
}
