import { boundedAccessRead } from "./access-policy.js";

/** Internal metadata only; never a public signed policy or purchase/rating authorization. */
export interface PolicyCacheRecord<P> {
  readonly schema: 1;
  readonly revision: number;
  readonly projection: P;
  readonly lastSuccess: number;
  readonly highWater: number;
}
export type PolicyCacheRead<P> = { readonly status: "missing" | "unreadable" } |
  { readonly status: "loaded"; readonly record: PolicyCacheRecord<P> };
export interface PolicyCachePorts<P> {
  readonly now: () => number;
  readonly readTrusted: (signal: AbortSignal) => Promise<PolicyCacheRead<P>>;
  readonly fetchVerified: (signal: AbortSignal) => Promise<{ readonly revision: number; readonly projection: P }>;
  /** The authoritative adapter must check both fences at the actual storage mutation,
   * preserve prior storage on failure, and acknowledge only committed writes. Aborting
   * JavaScript cannot roll back a write the adapter already acknowledged. */
  readonly commit: (record: PolicyCacheRecord<P>, context: { readonly signal: AbortSignal; readonly isCurrent: () => boolean }) => Promise<{ readonly status: "committed" }>;
}
interface PolicyCacheSnapshot<P> {
  readonly status: "unchecked" | "missing" | "unreadable" | "loaded";
  readonly projection: P | null;
  readonly revision: number | null;
  readonly pending: boolean;
  readonly stopped: boolean;
}

const SUCCESS_SPACING = 6 * 60 * 60 * 1000;
const FAILURE_SPACING = 15 * 60 * 1000;
const safeWall = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** Host projections are opaque bounded plain data, not executable or mutable collections.
 * This copying is not signature verification: the trusted ports own that boundary. */
function detach<P>(projection: P): { readonly projection: P; readonly identity: string } {
  if (projection === null || projection === undefined) throw new Error("Missing policy projection");
  let remaining = 4096;
  const copy = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 32) throw new Error("Unbounded policy projection");
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return Object.freeze(value.map(item => copy(item, depth + 1)));
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new Error("Non-data policy projection");
    }
    const entries = Object.keys(value).sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("Executable policy projection");
      return [key, copy(descriptor.value, depth + 1)] as const;
    });
    return Object.freeze(Object.fromEntries(entries));
  };
  const result = copy(projection, 0) as P;
  const identity = JSON.stringify(result);
  if (identity.length > 65_536) throw new Error("Unbounded policy projection");
  return { projection: result, identity };
}

interface Flight { readonly generation: number; readonly controller: AbortController; promise: Promise<void> }

/** Dormant ordinary UI-open cache only. It never authorizes a purchase or rating: those
 * require their separate fresh online checks. No polling, account or content triggers.
 * Failed-check spacing is live-instance metadata; failures never rewrite stored bytes. */
export class OrdinaryPolicyCache<P> {
  private record: PolicyCacheRecord<P> | null = null;
  private identity: string | null = null;
  private status: PolicyCacheSnapshot<P>["status"] = "unchecked";
  private highWater = 0;
  private failedAt: number | null = null;
  private generation = 0;
  private stopped = false;
  private flight: Flight | null = null;
  private readonly listeners = new Set<(snapshot: PolicyCacheSnapshot<P>) => void>();

  constructor(private readonly ports: PolicyCachePorts<P>) {}

  current(): PolicyCacheSnapshot<P> {
    return Object.freeze({ status: this.status, projection: this.record?.projection ?? null,
      revision: this.record?.revision ?? null, pending: this.flight !== null, stopped: this.stopped });
  }

  onOrdinaryOpen(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.flight) return this.flight.promise;
    const wall = this.wall();
    if (wall === null || !this.due(wall)) return Promise.resolve();
    const flight: Flight = { generation: this.generation, controller: new AbortController(), promise: Promise.resolve() };
    this.flight = flight;
    flight.promise = boundedAccessRead(() => this.check(flight), flight.controller.signal)
      .catch(() => {
        if (!this.isCurrent(flight)) return;
        if (this.status === "unchecked") this.status = "unreadable";
        this.failedAt = this.wall() ?? this.highWater;
      }).finally(() => {
        const current = this.isCurrent(flight);
        flight.controller.abort();
        if (current) { this.flight = null; this.emit(); }
      });
    this.emit();
    return flight.promise;
  }

  subscribe(listener: (snapshot: PolicyCacheSnapshot<P>) => void): () => void {
    if (!this.stopped) this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  invalidate(): void {
    this.generation++;
    const previous = this.flight;
    this.flight = null;
    previous?.controller.abort();
    if (!this.stopped) this.emit();
  }

  stop(): void {
    this.stopped = true;
    this.listeners.clear();
    this.invalidate();
  }

  private isCurrent(flight: Flight): boolean {
    return !this.stopped && this.flight === flight && flight.generation === this.generation && !flight.controller.signal.aborted;
  }

  private assertCurrent(flight: Flight): void {
    if (!this.isCurrent(flight)) throw new Error("Stale policy check");
  }

  private wall(): number | null {
    let wall: number;
    try { wall = this.ports.now(); } catch { return null; }
    if (!safeWall(wall) || wall < this.highWater) return null;
    this.highWater = wall;
    return wall;
  }

  private due(wall: number): boolean {
    return this.failedAt !== null ? wall - this.failedAt >= FAILURE_SPACING :
      !this.record || wall - this.record.lastSuccess >= SUCCESS_SPACING;
  }

  private emit(): void {
    const snapshot = this.current();
    for (const listener of [...this.listeners]) {
      // An observer cannot convert an acknowledged commit into a failed check.
      try { listener(snapshot); } catch { /* Observer isolation. */ }
    }
  }

  private async check(flight: Flight): Promise<void> {
    const read = await this.ports.readTrusted(flight.controller.signal);
    this.assertCurrent(flight);
    if (read.status === "unreadable") throw new Error("Unreadable policy storage");
    if (read.status === "loaded") {
      const { record } = read;
      if (record.schema !== 1 || !Number.isSafeInteger(record.revision) || record.revision <= 0 ||
        !safeWall(record.lastSuccess) || !safeWall(record.highWater) || record.highWater < record.lastSuccess) {
        throw new Error("Unreadable policy metadata");
      }
      const accepted = detach(record.projection);
      if (this.record && (record.revision < this.record.revision ||
        record.lastSuccess < this.record.lastSuccess || record.highWater < this.record.highWater ||
        (record.revision === this.record.revision && accepted.identity !== this.identity))) {
        throw new Error("Regressed policy storage");
      }
      this.record = Object.freeze({ ...record, projection: accepted.projection });
      this.identity = accepted.identity;
      this.highWater = Math.max(this.highWater, record.highWater);
      this.status = "loaded";
      this.emit();
    } else if (read.status === "missing") {
      if (this.record) throw new Error("Lost policy storage");
      this.status = "missing";
    } else throw new Error("Unreadable policy storage");
    this.assertCurrent(flight);
    const started = this.wall();
    if (started === null || !this.due(started)) return;
    const candidate = await this.ports.fetchVerified(flight.controller.signal);
    this.assertCurrent(flight);
    if (!Number.isSafeInteger(candidate.revision) || candidate.revision <= 0) throw new Error("Invalid policy revision");
    const accepted = detach(candidate.projection);
    if (this.record && (candidate.revision < this.record.revision ||
      (candidate.revision === this.record.revision && accepted.identity !== this.identity))) {
      throw new Error("Conflicting policy revision");
    }
    const wall = this.wall();
    if (wall === null) throw new Error("Untrusted policy clock");
    const next: PolicyCacheRecord<P> = Object.freeze({ schema: 1, revision: candidate.revision,
      projection: accepted.projection, lastSuccess: wall, highWater: this.highWater });
    const acknowledgment = await this.ports.commit(next, {
      signal: flight.controller.signal, isCurrent: () => this.isCurrent(flight),
    });
    this.assertCurrent(flight);
    if (acknowledgment.status !== "committed") throw new Error("Unacknowledged policy persistence");
    this.record = next;
    this.identity = accepted.identity;
    this.status = "loaded";
    this.failedAt = null;
    this.emit();
  }
}
