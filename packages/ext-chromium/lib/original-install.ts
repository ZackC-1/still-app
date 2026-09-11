import { browser } from "wxt/browser";

// When this browser first ran a Still build that keeps this record, and which version that was.
//
// It exists so that a later change to what Still includes can recognise the people who installed
// while everything was included, and treat them as promised. Their Apple counterparts are covered
// by the app's own record; a browser has no receipt and no store history to ask, so the browser has
// to write the fact down itself, once, at the moment it first runs.
//
// Two properties are load-bearing:
//
//   * It is local. Nothing here is sent anywhere, no schema changes, and it is readable only by
//     this extension. A cohort record that needed an account would miss exactly the people it
//     exists for, since signing in is optional.
//   * It is written once and never moved forward. An ordinary browser restart, a service worker
//     waking, or an extension update must all return the record already stored. If any of them
//     rewrote it, every existing install would silently re-date itself to the day that build
//     shipped, which is the one mistake this record cannot recover from.
//
// `firstRecordedAt` and `firstRecordedAppVersion` mean exactly what the Apple app's fields of the
// same names mean (`OriginalInstall` in StillKit), so the two surfaces can be compared later
// without anyone having to reconcile two definitions. The Apple record carries an optional richer
// half from Apple's app transaction; there is no browser equivalent, and the local half is the one
// both sides always have.
//
// Changing this record later is the part that can go permanently wrong, for the same reason it is
// on the Apple side. A record that fails to parse reads as no record, and the next start writes a
// fresh one dated today. So: add new fields as optional, never rename or repurpose an existing
// field, and raise `CURRENT_SCHEMA_VERSION` only when the MEANING of a field changes.

const STORAGE_KEY = "still:originalInstall";

/** The shape written today. A stored record with no `schemaVersion` is version 1. */
export const CURRENT_SCHEMA_VERSION = 1;

export interface OriginalInstallRecord {
  /** Which shape of this record was written, so a later build can tell what it is reading. */
  readonly schemaVersion: number;
  /** Milliseconds since the epoch at the first start of a Still build that keeps this record. */
  readonly firstRecordedAt: number;
  /** Still's own extension version at that first start, from the manifest. */
  readonly firstRecordedAppVersion: string;
}

/** The one slot this module reads and writes. Injectable so the tests need no browser. */
export interface OriginalInstallStore {
  get(): Promise<unknown>;
  set(record: OriginalInstallRecord): Promise<void>;
}

export interface OriginalInstallDeps {
  readonly store: OriginalInstallStore;
  /** Milliseconds since the epoch; `Date.now` in real wiring. */
  readonly now: () => number;
  /** This build's extension version. */
  readonly appVersion: string;
}

/**
 * Return the stored record, writing it first if this browser has never had one. Reading before
 * writing is the whole behaviour: it is what makes an update or a worker restart keep the original
 * date instead of replacing it.
 *
 * Never throws. A storage failure costs the record, which is a lost cohort signal for one install
 * and nothing else, and must not be allowed to take down a background start.
 */
export async function ensureOriginalInstall(
  deps: OriginalInstallDeps,
): Promise<OriginalInstallRecord | null> {
  try {
    const existing = parseOriginalInstall(await deps.store.get());
    if (existing) return existing;
    const record: OriginalInstallRecord = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      firstRecordedAt: deps.now(),
      firstRecordedAppVersion: deps.appVersion,
    };
    await deps.store.set(record);
    return record;
  } catch {
    return null;
  }
}

/**
 * Read a stored value as a record, or null when there is nothing usable there.
 *
 * Deliberately tolerant in one direction only: unknown fields written by a later build are ignored
 * so an older build never destroys a newer record, while a missing or unusable required field
 * reads as absent. A record without a readable first-recorded date says nothing, and pretending
 * otherwise would be worse than rewriting it.
 */
export function parseOriginalInstall(value: unknown): OriginalInstallRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const firstRecordedAt = record.firstRecordedAt;
  const firstRecordedAppVersion = record.firstRecordedAppVersion;
  if (typeof firstRecordedAt !== "number" || !Number.isFinite(firstRecordedAt)) return null;
  if (typeof firstRecordedAppVersion !== "string" || firstRecordedAppVersion.length === 0) {
    return null;
  }
  const schemaVersion = record.schemaVersion;
  return {
    // A record written before the field existed is version 1, which is what it was.
    schemaVersion:
      typeof schemaVersion === "number" && Number.isFinite(schemaVersion)
        ? schemaVersion
        : 1,
    firstRecordedAt,
    firstRecordedAppVersion,
  };
}

/** The production slot, over the same `chrome.storage.local` the rest of the extension uses. */
export function createOriginalInstallStore(): OriginalInstallStore {
  return {
    async get(): Promise<unknown> {
      return (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY] ?? null;
    },
    async set(record: OriginalInstallRecord): Promise<void> {
      await browser.storage.local.set({ [STORAGE_KEY]: record });
    },
  };
}
