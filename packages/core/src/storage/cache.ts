import type { ServiceId, StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { etldPlusOne } from "../rules/match.js";
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
  private readonly now: () => number;
  private readonly listeners = new Set<SettingsListener>();
  private unwatch: (() => void) | null = null;

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
    return { settings: this.snapshot, syncMetadata: this.syncMetadata };
  }

  /** Load persisted settings once at startup. LWW so a newer in-memory edit isn't clobbered. */
  async hydrate(): Promise<StillSettings> {
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

  applySyncedEnvelope(envelope: SyncedSettingsEnvelope): boolean {
    const incomingMetadata = metadataFromEnvelope(envelope);
    if (!shouldApplySyncedMetadata(incomingMetadata, this.syncMetadata)) return false;

    const settingsChanged = !sameSettings(this.snapshot, envelope.settings);
    const metadataChanged = !sameMetadata(this.syncMetadata, incomingMetadata);
    if (!settingsChanged && !metadataChanged) return false;

    this.snapshot = envelope.settings;
    this.syncMetadata = incomingMetadata;
    void this.persist();
    if (settingsChanged) this.notify("synced");
    return settingsChanged || metadataChanged;
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

  /** True when the host's eTLD+1 is paused. */
  isPausedHost(host: string): boolean {
    return this.snapshot.pauses.includes(etldPlusOne(host));
  }

  pauseHost(host: string): Promise<StillSettings> {
    const key = etldPlusOne(host);
    if (this.snapshot.pauses.includes(key)) return Promise.resolve(this.snapshot);
    return this.commit({ ...this.snapshot, pauses: [...this.snapshot.pauses, key] });
  }

  resumeHost(host: string): Promise<StillSettings> {
    const key = etldPlusOne(host);
    return this.commit({ ...this.snapshot, pauses: this.snapshot.pauses.filter((p) => p !== key) });
  }

  /** Apply a mutation: stamp a fresh updatedAt, persist locally, and notify. No network. */
  private async commit(next: StillSettings): Promise<StillSettings> {
    const stamped: StillSettings = { ...next, updatedAt: this.now() };
    this.snapshot = stamped;
    await this.persist();
    this.notify("local");
    return stamped;
  }

  private applyStoredRecord(record: StoredSettingsRecord, source: SettingsChangeSource): boolean {
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
