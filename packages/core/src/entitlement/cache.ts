export interface EntitlementAdapter {
  get(): Promise<boolean | null>;
  /** Persist the entitlement. `updatedAt` (ms epoch) defaults to now; the Safari App-Group pull
   * passes the app's last server-confirmed stamp so the TTL measures from real server contact. */
  set(entitled: boolean, updatedAt?: number): Promise<void>;
  subscribe(listener: (entitled: boolean) => void): () => void;
}

/** The full stored entitlement record. `userId` binds the grant to the account it was verified
 * for (R8); it is absent on records written by the Safari App-Group pull (no browser session
 * there) and on legacy records — both stay readable. */
export interface EntitlementRecord {
  readonly entitled: boolean;
  readonly userId?: string;
  /** ms epoch of the last server-confirmed write; the offline TTL measures from here. */
  readonly updatedAt: number;
}

/**
 * Record-level access to the stored entitlement for session orchestration (staleness and
 * identity checks). Content scripts keep the boolean EntitlementAdapter contract above; this
 * wider interface exists for writers (server reconcile, teardown) that must see and stamp the
 * whole record.
 */
export interface EntitlementRecordStore {
  /** The stored record, or null when absent/expired — and, when `sessionUserId` is given, when
   * the stored record is bound to a DIFFERENT user (an identity mismatch is "no cache", R8). */
  getRecord(sessionUserId?: string): Promise<EntitlementRecord | null>;
  /** Persist the record verbatim. Callers stamp `updatedAt` on every write — an unchanged
   * `entitled: true` rewrite still refreshes the offline TTL (R7). An explicit `entitled: false`
   * write notifies subscribers, so teardown must write false, never remove the key. */
  setRecord(record: EntitlementRecord): Promise<void>;
}

/** R8 identity binding: a record bound to one user is invisible to another user's session. An
 * unbound record (Safari pull / legacy) and a session-less read (content scripts) both pass. */
export function recordMatchesSession(record: EntitlementRecord, sessionUserId?: string): boolean {
  return record.userId === undefined || sessionUserId === undefined || record.userId === sessionUserId;
}

export interface EntitlementCacheOptions {
  readonly initial?: boolean;
}

export class EntitlementCache {
  private snapshot: boolean;
  private readonly listeners = new Set<(entitled: boolean) => void>();
  private unwatch: (() => void) | null = null;

  constructor(
    private readonly adapter: EntitlementAdapter,
    opts: EntitlementCacheOptions = {},
  ) {
    this.snapshot = opts.initial ?? false;
  }

  current(): boolean {
    return this.snapshot;
  }

  async hydrate(): Promise<boolean> {
    const stored = await this.adapter.get();
    if (stored !== null) this.apply(stored);
    return this.snapshot;
  }

  watch(): () => void {
    this.unwatch ??= this.adapter.subscribe((entitled) => this.apply(entitled));
    return () => {
      this.unwatch?.();
      this.unwatch = null;
    };
  }

  subscribe(listener: (entitled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setEntitled(entitled: boolean): Promise<void> {
    this.apply(entitled);
    await this.adapter.set(entitled);
  }

  private apply(entitled: boolean): void {
    if (this.snapshot === entitled) return;
    this.snapshot = entitled;
    for (const listener of [...this.listeners]) listener(entitled);
  }
}

