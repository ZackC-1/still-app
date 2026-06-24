import type { StillSettings } from "@still/shared-types";

// The storage-adapter interface (KTD4): one shared UI/engine persists through an injected adapter,
// so the same code runs in the Chromium/Safari extension (chrome.storage) and the Apple WKWebView
// (App-Group bridge, U17). All operations are async; the synchronous read path is the SettingsCache
// snapshot, never the adapter directly.

export interface StorageAdapter {
  /** Read the persisted settings, or null if nothing has been written yet. */
  get(): Promise<StillSettings | null>;
  /** Persist settings. Implementations may notify subscribers of their own writes (realistic). */
  set(settings: StillSettings): Promise<void>;
  /** Observe changes from any context (other tabs, the options page, the cloud mirror). */
  subscribe(listener: (settings: StillSettings) => void): () => void;
}

/**
 * In-memory adapter: the unit-test double and the base building block for the WKWebView/App-Group
 * adapter in U17. `set` notifies subscribers, mirroring how `chrome.storage.onChanged` fires for the
 * extension's own writes — the SettingsCache dedupes echoes via last-write-wins.
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  private value: StillSettings | null;
  private readonly listeners = new Set<(s: StillSettings) => void>();

  constructor(initial: StillSettings | null = null) {
    this.value = initial;
  }

  async get(): Promise<StillSettings | null> {
    return this.value;
  }

  async set(settings: StillSettings): Promise<void> {
    this.value = settings;
    this.emit(settings);
  }

  subscribe(listener: (s: StillSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Simulate an external write from another context/device (tests, bridge integration). */
  emitExternal(settings: StillSettings): void {
    this.value = settings;
    this.emit(settings);
  }

  private emit(settings: StillSettings): void {
    for (const l of [...this.listeners]) l(settings);
  }
}
