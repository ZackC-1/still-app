import type { ServiceId, StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { etldPlusOne } from "../rules/match.js";
import type { StorageAdapter } from "./adapter.js";

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

export class SettingsCache {
  private snapshot: StillSettings;
  private readonly now: () => number;
  private readonly listeners = new Set<(s: StillSettings) => void>();
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

  /** Load persisted settings once at startup. LWW so a newer in-memory edit isn't clobbered. */
  async hydrate(): Promise<StillSettings> {
    const stored = await this.adapter.get();
    if (stored) this.applyRemote(stored);
    return this.snapshot;
  }

  /** Start reacting to external writes (other contexts / cloud mirror). Returns an unsubscribe. */
  watch(): () => void {
    this.unwatch ??= this.adapter.subscribe((s) => this.applyRemote(s));
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
    if (incoming.updatedAt <= this.snapshot.updatedAt) return false;
    this.snapshot = incoming;
    this.notify();
    return true;
  }

  subscribe(listener: (s: StillSettings) => void): () => void {
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
    await this.adapter.set(stamped);
    this.notify();
    return stamped;
  }

  private notify(): void {
    for (const l of [...this.listeners]) l(this.snapshot);
  }
}
