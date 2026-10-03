import type { BenefitAccessSnapshot, BenefitId, AccessState } from "@still/shared-types";
import { initialAccessSnapshot, parseBenefitAccessSnapshot, type TrustedAccessContext } from "./access-policy.js";

export interface EntitlementAdapter {
  get(): Promise<boolean | null>;
  observeBenefits?(signal?: AbortSignal): Promise<BenefitAccessSnapshot>;
  subscribeAccess?(listener: () => void): () => void;
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
  readonly access?: Pick<TrustedAccessContext, "paidMode" | "supported">;
}

export class EntitlementCache {
  private snapshot: boolean;
  private readonly listeners = new Set<(entitled: boolean) => void>();
  private readonly modernPaidMode: boolean;
  private accessSnapshot: BenefitAccessSnapshot;
  private readonly accessListeners = new Set<(snapshot: BenefitAccessSnapshot) => void>();
  private accessUnwatch: (() => void) | null = null;
  private accessFlight: Promise<BenefitAccessSnapshot> | null = null;
  private accessEpoch = 0;
  private accessAbort: AbortController | null = null;
  private accessRefreshDeadline = Infinity;
  private accessObservedWall = 0;
  private accessTimer: ReturnType<typeof setTimeout> | null = null;
  private accessWatching = false;
  private accessScheduled = false;
  private unwatch: (() => void) | null = null;

  constructor(
    private readonly adapter: EntitlementAdapter,
    opts: EntitlementCacheOptions = {},
  ) {
    this.snapshot = opts.initial ?? false;
    this.accessSnapshot = initialAccessSnapshot(opts.access);
    this.modernPaidMode = this.accessSnapshot.refreshAfterMs !== null;
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
    this.accessWatching = true;
    this.accessUnwatch ??= this.adapter.subscribeAccess?.(() => this.invalidateAccess()) ?? null;
    this.unwatch ??= this.adapter.subscribe((entitled) => this.apply(entitled));
    return () => {
      this.accessWatching = false;
      this.accessEpoch++;
      this.accessAbort?.abort(); this.accessAbort = null;
      this.accessUnwatch?.(); this.accessUnwatch = null;
      if (this.accessTimer !== null) clearTimeout(this.accessTimer);
      this.accessTimer = null;
      this.unwatch?.();
      this.unwatch = null;
    };
  }

  subscribe(listener: (entitled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setEntitled(entitled: boolean): Promise<void> {
    await this.adapter.set(entitled);
    this.apply(entitled);
  }

  currentAccess(benefit: BenefitId): AccessState { return this.currentAccessSnapshot().states[benefit]; }
  currentAccessSnapshot(): BenefitAccessSnapshot {
    // A suspended page cannot return a paid grant merely because its refresh timer has not run.
    // This is cache freshness only; the authoritative persisted paid clock stays in its writer.
    if (Date.now() >= this.accessRefreshDeadline || Date.now() < this.accessObservedWall) {
      this.accessRefreshDeadline = Infinity;
      this.holdAccess(); this.scheduleAccess();
    }
    return this.accessSnapshot;
  }

  subscribeAccess(listener: (snapshot: BenefitAccessSnapshot) => void): () => void {
    this.accessListeners.add(listener);
    return () => this.accessListeners.delete(listener);
  }

  refreshAccess(): Promise<BenefitAccessSnapshot> {
    if (this.accessFlight) return this.accessFlight;
    if (!this.modernPaidMode || !this.adapter.observeBenefits) return Promise.resolve(this.accessSnapshot);
    const epoch = this.accessEpoch;
    const controller = new AbortController(); this.accessAbort = controller;
    const operation = this.adapter.observeBenefits(controller.signal).then(parseBenefitAccessSnapshot).then(value => {
      if (epoch === this.accessEpoch) {
        this.accessObservedWall = Date.now();
        this.accessRefreshDeadline = value.refreshAfterMs === null ? Infinity : this.accessObservedWall + value.refreshAfterMs;
        this.applyAccess(value);
      }
      return this.accessSnapshot;
    }, () => {
      if (epoch === this.accessEpoch) this.holdAccess();
      return this.accessSnapshot;
    });
    const flight = operation.finally(() => {
      if (this.accessFlight === flight) this.accessFlight = null;
      if (this.accessAbort === controller) this.accessAbort = null;
      if (!this.accessWatching) return;
      if (epoch !== this.accessEpoch) this.scheduleAccess();
      else this.armAccessTimer();
    });
    this.accessFlight = flight;
    return flight;
  }

  private invalidateAccess(): void {
    this.accessEpoch++;
    this.holdAccess(false);
    this.scheduleAccess();
  }
  private scheduleAccess(): void {
    if (!this.accessWatching || this.accessScheduled) return;
    this.accessScheduled = true;
    queueMicrotask(() => {
      this.accessScheduled = false;
      if (this.accessWatching) void this.refreshAccess();
    });
  }
  private armAccessTimer(): void {
    if (this.accessTimer !== null) clearTimeout(this.accessTimer);
    this.accessTimer = null;
    const delay = this.accessSnapshot.refreshAfterMs;
    if (delay === null) return;
    this.accessTimer = setTimeout(() => { this.accessTimer = null; void this.refreshAccess(); }, delay);
  }
  private holdAccess(preserveIndependent = true): void {
    const states = Object.fromEntries(Object.entries(this.accessSnapshot.states).map(([key, value]) => [key,
      value === "free" || value === "unsupported" ? value : preserveIndependent && this.accessSnapshot.independentProtection.includes(key as BenefitId) ? "protected" : "verification_required",
    ])) as BenefitAccessSnapshot["states"];
    this.applyAccess({ ...this.accessSnapshot, states,
      independentProtection: preserveIndependent ? this.accessSnapshot.independentProtection : [],
    });
  }
  private applyAccess(snapshot: BenefitAccessSnapshot): void {
    if (JSON.stringify(snapshot) === JSON.stringify(this.accessSnapshot)) return;
    this.accessSnapshot = parseBenefitAccessSnapshot(snapshot);
    for (const listener of [...this.accessListeners]) listener(this.accessSnapshot);
  }

  private apply(entitled: boolean): void {
    if (this.snapshot === entitled) return;
    this.snapshot = entitled;
    for (const listener of [...this.listeners]) listener(entitled);
  }
}
