import type { StillSettings } from "@still/shared-types";

// The storage-adapter interface (KTD4): one shared UI/engine persists through an injected adapter,
// so the same code runs in the Chromium/Safari extension (chrome.storage) and the Apple WKWebView
// (App-Group bridge, U17). All operations are async; the synchronous read path is the SettingsCache
// snapshot, never the adapter directly.

export interface SettingsSyncMetadata {
  readonly version: number;
  readonly serverUpdatedAt: string;
  readonly lastWriteId: string | null;
}

export interface SyncedSettingsEnvelope extends SettingsSyncMetadata {
  readonly settings: StillSettings;
}

export interface StoredSettingsRecord {
  readonly settings: StillSettings;
  readonly syncMetadata: SettingsSyncMetadata | null;
  /**
   * Which account this browser profile's settings belong to, counted rather than named.
   *
   * `version` above orders writes within ONE account's row. It says nothing when the row itself
   * changes, which is what happens when someone signs out of a shared browser and the next person
   * signs in: their account can be on a lower version than the one left behind, and every context
   * reading this store would otherwise refuse the newcomer's settings as stale. The reconcile bumps
   * this counter whenever it repoints a browser at a different account, so the popup, the options
   * page, and the content scripts all accept the reset instead of each arbitrating for itself.
   *
   * Absent, rather than zero, on a record that came from a store which does not carry the field:
   * anything written before this existed, and anything round-tripped through the Apple App Group,
   * whose Swift coder drops keys it does not know. Absent means "judge this the way you always
   * did", so a bridged record is never refused for lacking a counter it could not have.
   */
  readonly syncEpoch?: number;
}

export interface StorageAdapter {
  /** Read the persisted settings record, or null if nothing has been written yet. */
  get(): Promise<StoredSettingsRecord | null>;
  /** Persist settings and any cloud metadata together. */
  set(record: StoredSettingsRecord): Promise<void>;
  /** Observe changes from any context (other tabs, the options page, the cloud mirror). */
  subscribe(listener: (record: StoredSettingsRecord) => void): () => void;
}

/**
 * In-memory adapter: the unit-test double and the base building block for the WKWebView/App-Group
 * adapter in U17. `set` notifies subscribers, mirroring how `chrome.storage.onChanged` fires for the
 * extension's own writes — the SettingsCache dedupes echoes via last-write-wins.
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  private value: StoredSettingsRecord | null;
  private readonly listeners = new Set<(record: StoredSettingsRecord) => void>();

  constructor(initial: StillSettings | StoredSettingsRecord | null = null) {
    this.value = initial && "settings" in initial && "syncMetadata" in initial
      ? initial
      : initial
        ? { settings: initial, syncMetadata: null }
        : null;
  }

  async get(): Promise<StoredSettingsRecord | null> {
    return this.value;
  }

  async set(record: StoredSettingsRecord): Promise<void> {
    this.value = record;
    this.emit(record);
  }

  subscribe(listener: (record: StoredSettingsRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Simulate an external write from another context/device (tests, bridge integration). */
  emitExternal(settings: StillSettings | StoredSettingsRecord): void {
    const record = "settings" in settings && "syncMetadata" in settings
      ? settings
      : { settings, syncMetadata: null };
    this.value = record;
    this.emit(record);
  }

  private emit(record: StoredSettingsRecord): void {
    for (const l of [...this.listeners]) l(record);
  }
}
