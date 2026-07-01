export interface EntitlementAdapter {
  get(): Promise<boolean | null>;
  /** Persist the entitlement. `updatedAt` (ms epoch) defaults to now; the Safari App-Group pull
   * passes the app's last server-confirmed stamp so the TTL measures from real server contact. */
  set(entitled: boolean, updatedAt?: number): Promise<void>;
  subscribe(listener: (entitled: boolean) => void): () => void;
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

