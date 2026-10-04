import type { FeatureId, ServiceId, SettingsField, StillSettings } from "@still/shared-types";
import { SettingsStorageRecovery, type AtomicSettingsState, type CanonicalSettingsEnvelope, type SettingsScope } from "./atomic-settings.js";
import { DEFAULT_SETTINGS, SETTINGS_FIELDS } from "@still/shared-types";
import { requireModernSettings } from "./atomic-settings.js";
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
  /** Explicit internal rollout option; callers must provide durable ownership evidence. */
  readonly atomicOwnership?: AtomicSettingsState["ownership"];
}

export type SettingsChangeSource = "local" | "external" | "synced";
export type SettingsListener = (settings: StillSettings, source: SettingsChangeSource) => void;
export type SettingsAuthorityListener = () => void;

export interface AtomicSettingsIntentOutcome {
  /** Request-specific authority receipt; false does not distinguish refusal from a no-op. */
  readonly intentCommitted: boolean;
  /** Current accepted projection, which may already supersede this request's receipt. */
  readonly settings: StillSettings;
}

export class SettingsCache {
  private snapshot: StillSettings;
  private atomic: AtomicSettingsState | undefined;
  private readonly atomicOwnership: AtomicSettingsState["ownership"] | undefined;
  private syncMetadata: SettingsSyncMetadata | null = null;
  // Which account this browser profile is pointed at, counted rather than named. See
  // StoredSettingsRecord.syncEpoch: it is what lets every context in the browser accept a reconcile
  // that resets the server version, instead of each one arbitrating a shared browser for itself.
  private syncEpoch = 0;
  private readonly now: () => number;
  private readonly listeners = new Set<SettingsListener>();
  private readonly authorityListeners = new Set<SettingsAuthorityListener>();
  private publishedAuthority: string | null = null;
  private intentsInFlight = 0;
  private unwatch: (() => void) | null = null;
  private hydration: Promise<StillSettings> | null = null;
  private authorityTicket = 0;
  private committedGeneration = 0;
  private hydrationRecovery: SettingsStorageRecovery | null = null;

  constructor(
    private readonly adapter: StorageAdapter,
    opts: SettingsCacheOptions = {},
  ) {
    this.atomicOwnership = opts.atomicOwnership;
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
    return { settings: this.snapshot, syncMetadata: this.syncMetadata, syncEpoch: this.syncEpoch, ...(this.atomic ? { atomic: this.atomic } : {}) };
  }

  /** Load persisted settings once at startup. LWW so a newer in-memory edit isn't clobbered. */
  hydrate(): Promise<StillSettings> {
    this.hydration ??= this.load();
    return this.hydration;
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
    return this.hydration === null ? Promise.resolve() : this.hydration.then(() => {
      if (this.hydrationRecovery) throw this.hydrationRecovery;
    }, () => { if (this.hydrationRecovery) throw this.hydrationRecovery; });
  }

  private async load(): Promise<StillSettings> {
    const authorityTicket = this.authorityTicket;
    const committedGeneration = this.committedGeneration;
    try {
      const stored = this.atomicOwnership !== undefined && this.adapter.initializeAtomic
        ? await this.adapter.initializeAtomic(this.atomicOwnership) : await this.adapter.get();
      // Same-authority captured reads cannot undo accepted backwards-clock command receipts.
      // A demonstrably newer legacy epoch/version still reaches the existing record arbitration;
      // either atomic record retains both the command-generation and authority-ticket fences.
      const newerLegacyAuthority = stored && !stored.atomic && !this.atomic && stored.syncEpoch !== undefined &&
        (stored.syncEpoch > this.syncEpoch || stored.syncEpoch === this.syncEpoch &&
          stored.syncMetadata !== null && this.syncMetadata !== null &&
          stored.syncMetadata.version > this.syncMetadata.version);
      if (stored && (committedGeneration === this.committedGeneration || newerLegacyAuthority) &&
        ((!stored.atomic && !this.atomic) || authorityTicket === this.authorityTicket))
        void this.applyStoredRecord(stored, "external");
      return this.snapshot;
    } catch (error) {
      if (error instanceof SettingsStorageRecovery && authorityTicket === this.authorityTicket) {
        if (!error.retained) { this.hydrationRecovery = error; this.notifyAuthority(); throw error; }
        // Last-known local choices keep free blocking useful during unavailable native reads.
        // Sync hydration remains a recovery gate, never a fresh canonical receipt.
        this.acceptCommitted(error.retained, "external", false);
        if (this.atomic) this.atomic = { ...this.atomic, paused: "native-authority-unavailable" };
        this.hydrationRecovery = error;
        this.notifyAuthority();
        return this.snapshot;
      }
      throw error;
    }
  }

  /** Start reacting to external writes (other contexts / cloud mirror). Returns an unsubscribe. */
  watch(): () => void {
    this.unwatch ??= this.adapter.subscribe((record) => {
      // Safari subscriptions supply a successful authority reread, never the auxiliary signal.
      if (!record.atomic && !this.atomic && (record.syncEpoch ?? this.syncEpoch) >= this.syncEpoch) {
        this.authorityTicket += 1;
        this.hydrationRecovery = null;
      }
      this.applyStoredRecord(record, "external");
      // Atomic acceptance already publishes; legacy same-choice rereads can clear recovery here.
      if (!record.atomic && !this.atomic) this.notifyAuthority();
    });
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
    else this.notifyAuthority();
    return true;
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Observe current record/recovery changes without inventing a saved edit or owning watchers. */
  subscribeAuthority(listener: SettingsAuthorityListener): () => void {
    if (this.authorityListeners.size === 0) this.publishedAuthority = this.authoritySignature();
    this.authorityListeners.add(listener);
    return () => { this.authorityListeners.delete(listener); };
  }

  /** Capability only; never initializes storage or proves current ownership/access. */
  supportsAtomicIntents(): boolean {
    return typeof this.adapter.commitIntent === "function";
  }

  /** Explicit V3 command entry: no legacy optimistic persistence fallback. */
  commitAtomicIntent(path: SettingsField, value: boolean): Promise<AtomicSettingsIntentOutcome> {
    if (!SETTINGS_FIELDS.includes(path) || typeof value !== "boolean")
      return Promise.reject(new TypeError("Invalid settings intent"));
    if (!this.supportsAtomicIntents() || !this.atomic || this.atomic.paused !== null ||
      this.atomic.ownership === "unknown" || !("schemaVersion" in this.snapshot) || this.snapshot.schemaVersion !== 2)
      return Promise.reject(new SettingsStorageRecovery("atomic-command-unavailable"));
    try { requireModernSettings(this.currentRecord()); }
    catch { return Promise.reject(new SettingsStorageRecovery("atomic-command-unavailable")); }
    return this.executeIntent(path, value);
  }

  setGlobalOn(on: boolean): Promise<StillSettings> {
    if (this.adapter.commitIntent) return this.commitIntent("globalOn", on);
    return this.commit({ ...this.snapshot, globalOn: on });
  }

  setService(id: ServiceId, on: boolean): Promise<StillSettings> {
    if (this.adapter.commitIntent) return this.commitIntent(`services.${id}`, on);
    return this.commit({ ...this.snapshot, services: { ...this.snapshot.services, [id]: on } });
  }

  setFeature(id: FeatureId, on: boolean): Promise<StillSettings> {
    if (!this.adapter.commitIntent) return Promise.reject(new Error("Atomic settings authority unavailable"));
    return this.commitIntent(`sites.${id}`, on);
  }

  async enterAtomicScope(accountId: string | null, sessionId?: string): Promise<SettingsScope> {
    if (!this.adapter.enterScope) throw new Error("Atomic settings authority unavailable");
    const record = await this.adapter.enterScope(accountId, sessionId);
    this.acceptCommitted(record, "synced");
    return record.atomic!.scope;
  }

  async acknowledgeAtomic(envelope: CanonicalSettingsEnvelope, scope: SettingsScope): Promise<void> {
    if (!this.adapter.acknowledgeAtomic) throw new Error("Atomic settings authority unavailable");
    this.acceptCommitted(await this.adapter.acknowledgeAtomic(envelope, scope), "synced");
  }

  private async commitIntent(path: SettingsField, value: boolean): Promise<StillSettings> {
    return (await this.executeIntent(path, value)).settings;
  }

  private async executeIntent(path: SettingsField, value: boolean): Promise<AtomicSettingsIntentOutcome> {
    const previous = this.snapshot;
    const authorityTicket = this.authorityTicket;
    this.intentsInFlight += 1;
    let committed = false;
    try {
      const record = await this.adapter.commitIntent!({ path, value, updatedAt: this.now() });
      this.acceptCommitted(record, "external");
      committed = record.intentCommitted === true;
      return { settings: this.snapshot, intentCommitted: committed };
    } catch (error) {
      if (error instanceof SettingsStorageRecovery && authorityTicket === this.authorityTicket) {
        this.hydrationRecovery = error;
        if (this.atomic) this.atomic = { ...this.atomic, paused: error.reason };
        this.notifyAuthority();
      }
      throw error;
    } finally {
      this.intentsInFlight -= 1;
      if (committed) this.notify("local");
      else if (this.intentsInFlight === 0 && !sameSettings(previous, this.snapshot)) this.notify("external");
    }
  }

  private acceptCommitted(record: StoredSettingsRecord, source: SettingsChangeSource, publishAuthority = true): boolean {
    const previous = this.snapshot;
    if (record.atomic && this.atomic) {
      if (record.atomic.scope.generation < this.atomic.scope.generation) return false;
      if (record.atomic.scope.generation === this.atomic.scope.generation &&
        (record.atomic.scope.accountId !== this.atomic.scope.accountId || record.atomic.sequence < this.atomic.sequence)) return false;
    }
    // Any accepted authority result supersedes failures of requests started before it.
    this.authorityTicket += 1;
    this.committedGeneration += 1;
    this.hydrationRecovery = null;
    this.snapshot = record.settings;
    this.syncMetadata = record.syncMetadata;
    this.syncEpoch = record.syncEpoch ?? this.syncEpoch;
    this.atomic = record.atomic;
    if (record.atomic) {
      for (const [path, value] of Object.entries(record.atomic.held)) {
        if (path === "globalOn") this.snapshot = { ...this.snapshot, globalOn: value! };
        else if (path.startsWith("services.")) this.snapshot = { ...this.snapshot, services: { ...this.snapshot.services, [path.slice(9)]: value } };
        else if (path.startsWith("sites.") && "sites" in this.snapshot) {
          const sites = (this.snapshot as unknown as import("@still/shared-types").SettingsV2).sites;
          this.snapshot = { ...this.snapshot, ...{ sites: { ...sites, [path.slice(6)]: value } } };
        }
      }
    }
    const changed = !sameSettings(previous, this.snapshot);
    if (changed) this.notify(source, publishAuthority);
    else if (publishAuthority) this.notifyAuthority();
    return changed;
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
   * A record with NO epoch is judged by the version rules alone, exactly as before this existed,
   * and that softness is deliberate. Two shapes arrive without one and neither can undo a repoint
   * here. A bare settings payload parses to no metadata and no counter, and the last branch of this
   * method refuses any record with no metadata once this cache is synced. A record with metadata
   * but no counter comes either from a store that has never been repointed, where there is no
   * repoint to undo, or from a build older than the field, where refusing it would strand settings
   * coming back across the Apple bridge for the sake of a counter their writer could not stamp.
   */
  private applyStoredRecord(record: StoredSettingsRecord, source: SettingsChangeSource): boolean {
    if (record.atomic) {
      if (this.atomic && record.atomic.scope.generation < this.atomic.scope.generation) return false;
      return this.acceptCommitted(record, source);
    }
    if (this.atomic) return false;
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
      else this.notifyAuthority();
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
            this.notifyAuthority();
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
      else this.notifyAuthority();
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

  private notify(source: SettingsChangeSource, publishAuthority = true): void {
    if (source === "external" && this.intentsInFlight > 0) {
      if (publishAuthority) this.notifyAuthority();
      return;
    }
    for (const l of [...this.listeners]) l(this.snapshot, source);
    if (publishAuthority) this.notifyAuthority();
  }

  private authoritySignature(): string {
    return JSON.stringify([this.currentRecord(), this.hydrationRecovery?.reason ?? null]);
  }

  private notifyAuthority(): void {
    if (this.authorityListeners.size === 0) return;
    const signature = this.authoritySignature();
    if (signature === this.publishedAuthority) return;
    this.publishedAuthority = signature;
    for (const listener of [...this.authorityListeners]) {
      if (this.publishedAuthority !== signature) break;
      if (!this.authorityListeners.has(listener)) continue;
      try { listener(); }
      catch { /* Read-only observers cannot change writer receipts or sibling delivery. */ }
    }
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
