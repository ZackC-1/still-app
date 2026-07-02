import type { EntitlementAdapter, EntitlementRecord, EntitlementRecordStore } from "./cache.js";
import { recordMatchesSession } from "./cache.js";

/** In-memory adapter for tests and headless callers. Mirrors ChromeEntitlementAdapter's record
 * semantics (identity binding, verbatim `updatedAt` stamping, false-write notification) minus the
 * TTL — staleness policy belongs to the persistent store, not the fake. */
export class InMemoryEntitlementAdapter implements EntitlementAdapter, EntitlementRecordStore {
  private record: EntitlementRecord | null;
  private readonly listeners = new Set<(entitled: boolean) => void>();

  constructor(
    initial: boolean | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.record = initial === null ? null : { entitled: initial, updatedAt: this.now() };
  }

  async get(): Promise<boolean | null> {
    return this.record?.entitled ?? null;
  }

  async set(entitled: boolean, updatedAt: number = this.now()): Promise<void> {
    await this.setRecord({ entitled, updatedAt }); // no userId: mirrors the Safari-pull write shape
  }

  /** The stored record; a `sessionUserId` mismatch with a bound record is "no cache" (R8). */
  async getRecord(sessionUserId?: string): Promise<EntitlementRecord | null> {
    if (!this.record || !recordMatchesSession(this.record, sessionUserId)) return null;
    return this.record;
  }

  async setRecord(record: EntitlementRecord): Promise<void> {
    this.record = record;
    this.emit(record.entitled);
  }

  subscribe(listener: (entitled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitExternal(entitled: boolean): void {
    this.record = { entitled, updatedAt: this.now() };
    this.emit(entitled);
  }

  private emit(entitled: boolean): void {
    for (const listener of [...this.listeners]) listener(entitled);
  }
}
