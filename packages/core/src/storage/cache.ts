import type { ServiceId, StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import type {
  SettingsSyncMetadata,
  StorageAdapter,
  StoredSettingsRecord,
  SyncedSettingsEnvelope,
} from "./adapter.js";

// The local settings cache: holds a synchronous in-memory snapshot the content script reads at
// document_start without ever awaiting the adapter (U7), persists local edits, and merges incoming
// writes (other contexts, or the cloud mirror in U13) by last-write-wins. It never touches the
// network — sync push/pull is layered on top in U13, so a free user's writes stay entirely local.

export interface SettingsCacheOptions {
  /** Injectable clock for the LWW timestamp (tests pass a deterministic counter). */
  readonly now?: () => number;
  /** Seed snapshot before hydration (defaults to the bundled DEFAULT_SETTINGS). */
  readonly initial?: StillSettings;
}

export type SettingsChangeSource = "local" | "external" | "synced";
export type SettingsListener = (settings: StillSettings, source: SettingsChangeSource) => void;

export class SettingsCache {
  private snapshot: StillSettings;
  private syncMetadata: SettingsSyncMetadata | null = null;
  // Which account this browser profile is pointed at, counted rather than named. See
  // StoredSettingsRecord.syncEpoch: it is what lets every context in the browser accept a reconcile
  // that resets the server version, instead of each one arbitrating a shared browser for itself.
  private syncEpoch = 0;
  private readonly now: () => number;
  private readonly listeners = new Set<SettingsListener>();
  private unwatch: (() => void) | null = null;
  private hydration: Promise<StillSettings> | null = null;

  constructor(
    private readonly adapter: StorageAdapter,
    opts: SettingsCacheOptions = {},
  ) {
    this.snapshot = opts.initial ?? DEFAULT_SETTINGS;
    this.now = opts.now ?? Date.now;
  }

  /** Synchronous read path. The content script reads this; it never awaits the adapter inline. */
  current(): StillSettings {
    return this.snapshot;
  }

  currentSyncMetadata(): SettingsSyncMetadata | null {
    return this.syncMetadata;
  }

  currentRecord(): StoredSettingsRecord {
    // Always stamped, even at zero, because that is what lets another context tell a peer that has
    // not seen the reconcile yet from a store that does not speak epochs at all.
    return { settings: this.snapshot, syncMetadata: this.syncMetadata, syncEpoch: this.syncEpoch };
  }

  /** Load persisted settings once at startup. LWW so a newer in-memory edit isn't clobbered. */
  hydrate(): Promise<StillSettings> {
    const run = this.load();
    this.hydration ??= run;
    return run;
  }

  /**
   * Resolves once the persisted settings have been loaded, or immediately when nothing ever
   * started loading them.
   *
   * Settings sync waits on this before it compares a device against its account. Until hydration
   * lands, `current()` is the bundled defaults and `currentSyncMetadata()` is null, so an
   * unhydrated cache looks exactly like a brand new device and could publish defaults over
   * settings someone has been using. A failed load resolves rather than rejecting: the caller's
   * job is to wait for the answer, not to inherit the storage error.
   */
  whenHydrated(): Promise<unknown> {
    return this.hydration === null ? Promise.resolve() : this.hydration.catch(() => undefined);
  }

  private async load(): Promise<StillSettings> {
    const stored = await this.adapter.get();
    if (stored) void this.applyStoredRecord(stored, "external");
    return this.snapshot;
  }

  /** Start reacting to external writes (other contexts / cloud mirror). Returns an unsubscribe. */
  watch(): () => void {
    this.unwatch ??= this.adapter.subscribe((record) => this.applyStoredRecord(record, "external"));
    return () => {
      this.unwatch?.();
      this.unwatch = null;
    };
  }

  /**
   * Apply an incoming settings set via last-write-wins. Returns true if the snapshot changed.
   * Echoes of our own writes (equal or older `updatedAt`) are ignored, so no notify loop forms.
   */
  applyRemote(incoming: StillSettings): boolean {
    if (this.syncMetadata !== null) return false;
    if (incoming.updatedAt <= this.snapshot.updatedAt) return false;
    this.snapshot = incoming;
    void this.persist();
    this.notify("external");
    return true;
  }

  /** Steady state: take an envelope only when it is a later version of the row this cache is on. */
  applySyncedEnvelope(envelope: SyncedSettingsEnvelope): boolean {
    const incomingMetadata = metadataFromEnvelope(envelope);
    if (!shouldApplySyncedMetadata(incomingMetadata, this.syncMetadata)) return false;
    return this.takeEnvelope(envelope, incomingMetadata, false);
  }

  /**
   * Take an envelope as this device's truth, whatever version the cache is carrying, and record
   * that this browser profile has been repointed at a different account.
   *
   * `applySyncedEnvelope` above deliberately refuses anything that is not a later version than
   * what this device already has, which is what stops a late realtime message dragging the steady
   * state backwards. That test is the wrong one at the single moment a device is being reconciled
   * with an account, because the version it is carrying may not be comparable at all: on a shared
   * browser it belongs to the previous person's profile row. So the reconcile in SyncService, and
   * only the reconcile, adopts unconditionally once it has decided the account is the newer side.
   *
   * Bumping the epoch is what carries that decision to every other context in the browser. Without
   * it the background would hold the new account's settings and the popup the person is looking at
   * would keep showing the previous person's, because the popup's own copy of this cache would
   * refuse the lower version as stale. Returns true when anything changed.
   */
  adoptSyncedEnvelope(envelope: SyncedSettingsEnvelope): boolean {
    return this.takeEnvelope(envelope, metadataFromEnvelope(envelope), true);
  }

  /** The shared body of the two envelope paths above: assign, persist, and notify once. */
  private takeEnvelope(
    envelope: SyncedSettingsEnvelope,
    incomingMetadata: SettingsSyncMetadata,
    repoint: boolean,
  ): boolean {
    const settingsChanged = !sameSettings(this.snapshot, envelope.settings);
    const metadataChanged = !sameMetadata(this.syncMetadata, incomingMetadata);
    if (!settingsChanged && !metadataChanged) return false;

    this.snapshot = envelope.settings;
    this.syncMetadata = incomingMetadata;
    // Only a reconcile that actually moved this device bumps the epoch, so a background start that
    // finds the account exactly where it left it costs no needless write to every other context.
    if (repoint) this.syncEpoch += 1;
    void this.persist();
    if (settingsChanged) this.notify("synced");
    return true;
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setGlobalOn(on: boolean): Promise<StillSettings> {
    return this.commit({ ...this.snapshot, globalOn: on });
  }

  setService(id: ServiceId, on: boolean): Promise<StillSettings> {
    return this.commit({ ...this.snapshot, services: { ...this.snapshot.services, [id]: on } });
  }

  // No pause mutators: they were removed with the pause-on-this-site UI (R1) — any write here would
  // be silently erased anyway, since parseSettings normalizes stored `pauses` to [] on every reparse.

  /** Apply a mutation: stamp a fresh updatedAt, persist locally, and notify. No network. */
  private async commit(next: StillSettings): Promise<StillSettings> {
    const stamped: StillSettings = { ...next, updatedAt: this.now() };
    this.snapshot = stamped;
    await this.persist();
    this.notify("local");
    return stamped;
  }

  /**
   * Take what the shared store now holds, which is how one context in the browser learns what
   * another wrote. The order is epoch first, then server version, then the local timestamp.
   *
   * The epoch comes first because it answers a question the version cannot: whether the record is
   * even counting the same account. A reconcile that repoints this browser at a different account
   * bumps it, and every other context accepts the reset rather than reading the lower version as a
   * stale echo of its own. Within one epoch the version test stands unchanged: it is what keeps two
   * contexts writing at the same moment converging on the later write instead of trading places.
   *
   * A record with NO epoch is judged by the version rules alone, exactly as before this existed.
   * That is the Apple App Group's records, whose Swift coder drops the field, and anything written
   * by an older build. Refusing those would break settings coming back the other way across the
   * bridge for the sake of a counter they were never able to carry.
   */
  private applyStoredRecord(record: StoredSettingsRecord, source: SettingsChangeSource): boolean {
    const incomingEpoch = record.syncEpoch;
    if (incomingEpoch !== undefined && incomingEpoch !== this.syncEpoch) {
      // A peer that has not seen the reconcile yet. Refusing it in memory is what matters, because
      // it is what stops the previous account's settings being published. The record itself stays
      // in the shared store until the next write from a context that HAS seen the reconcile, so a
      // context opening inside that window reads the older settings; the window is the gap between
      // the reconcile's write and the storage change notification reaching the peer that wrote it.
      if (incomingEpoch < this.syncEpoch) return false;
      this.syncEpoch = incomingEpoch;
      const settingsChanged = !sameSettings(this.snapshot, record.settings);
      const metadataChanged = !sameMetadata(this.syncMetadata, record.syncMetadata);
      this.snapshot = record.settings;
      this.syncMetadata = record.syncMetadata;
      if (settingsChanged) this.notify(source);
      return settingsChanged || metadataChanged;
    }
    const metadata = record.syncMetadata;
    if (metadata) {
      if (this.syncMetadata) {
        if (metadata.version < this.syncMetadata.version) return false;
        if (metadata.version === this.syncMetadata.version && record.settings.updatedAt <= this.snapshot.updatedAt) {
          if (!sameMetadata(this.syncMetadata, metadata)) {
            this.syncMetadata = metadata;
            void this.persist();
            return true;
          }
          return false;
        }
      }
      const settingsChanged = !sameSettings(this.snapshot, record.settings);
      const metadataChanged = !sameMetadata(this.syncMetadata, metadata);
      if (!settingsChanged && !metadataChanged) return false;
      this.snapshot = record.settings;
      this.syncMetadata = metadata;
      if (settingsChanged) this.notify(source);
      return true;
    }

    if (this.syncMetadata !== null) return false;
    if (record.settings.updatedAt <= this.snapshot.updatedAt) return false;
    this.snapshot = record.settings;
    this.notify(source);
    return true;
  }

  private persist(): Promise<void> {
    return this.adapter.set(this.currentRecord());
  }

  private notify(source: SettingsChangeSource): void {
    for (const l of [...this.listeners]) l(this.snapshot, source);
  }
}

function metadataFromEnvelope(envelope: SyncedSettingsEnvelope): SettingsSyncMetadata {
  return {
    version: envelope.version,
    serverUpdatedAt: envelope.serverUpdatedAt,
    lastWriteId: envelope.lastWriteId,
  };
}

function shouldApplySyncedMetadata(
  incoming: SettingsSyncMetadata,
  current: SettingsSyncMetadata | null,
): boolean {
  if (current === null) return true;
  if (incoming.version > current.version) return true;
  return false;
}

function sameMetadata(a: SettingsSyncMetadata | null, b: SettingsSyncMetadata | null): boolean {
  return a?.version === b?.version &&
    a?.serverUpdatedAt === b?.serverUpdatedAt &&
    a?.lastWriteId === b?.lastWriteId;
}

function sameSettings(a: StillSettings, b: StillSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
