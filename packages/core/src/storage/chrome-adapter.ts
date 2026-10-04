import type { StorageAdapter, StoredSettingsRecord } from "./adapter.js";
import { parseSettingsIntentReply, parseStoredSettingsRecord } from "./settings-validation.js";
import { AtomicSettingsWriter, SettingsStorageRecovery, type AtomicSettingsState, type CanonicalSettingsEnvelope, type SettingsIntent, type SettingsScope } from "./atomic-settings.js";
import { settingsIntentMessage } from "./settings-messages.js";

const STORAGE_KEY = "still:settings";
// Raw key presence, including null/corruption, rules out pristine history. The startup cohort
// record is deliberately separate: its own write neither grants nor denies installation proof.
const FRESH_HISTORY_KEYS = [STORAGE_KEY, "still:auth", "still:auth-code-verifier", "still:last-identity",
  "still:entitlement", "still:pending-otp", "still:checkout-pending", "still:nudge-stamp"];
// Reuse the existing mirror transaction for auxiliary replies in this host. It never allocates
// intent; only native records can enter this projection, and Safari reads remain authoritative.
const nativeProjections = new WeakMap<object, AtomicSettingsWriter>();
export interface ChromeSettingsAuthorityOptions {
  readonly authority?: boolean;
  /** Safari background maintains only an auxiliary projection of the authoritative native store. */
  readonly nativeMirror?: boolean;
  /** Safari directly calls its native authority so an asleep background never gates free edits. */
  readonly nativeIntent?: (intent: SettingsIntent) => Promise<StoredSettingsRecord>;
  readonly onProjectionFailure?: () => void;
}
export class ChromeStorageAdapter implements StorageAdapter {
  private readonly writer: AtomicSettingsWriter | null;
  private projectionRetry: Promise<void> | null = null;
  constructor(private readonly options: ChromeSettingsAuthorityOptions = {}) {
    this.writer = options.authority ? (options.nativeMirror ? nativeProjections.get(chrome.storage.local) : undefined) ?? new AtomicSettingsWriter({
      get: () => this.getProjection(), set: record => this.write(record), subscribe: listener => this.subscribe(listener),
    }) : null;
    if (options.nativeMirror && this.writer) nativeProjections.set(chrome.storage.local, this.writer);
  }
  private isSafari(): boolean { return chrome.runtime?.getURL?.("").startsWith("safari-web-extension:") ?? false; }
  async get(): Promise<StoredSettingsRecord | null> {
    return this.getAuthoritative();
  }
  private async bounded<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new SettingsStorageRecovery("native-authority-unavailable"));
        timer = setTimeout(cancel, 8_000);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
      })]);
    } catch {
      throw new SettingsStorageRecovery("native-authority-unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
  private async getAuthoritative(signal?: AbortSignal): Promise<StoredSettingsRecord | null> {
    if (!this.isSafari() || this.options.nativeMirror) return this.getProjection();
    try {
      const operation = globalThis.location?.protocol === "safari-web-extension:"
        ? this.readNativeAuthority()
        : chrome.runtime.sendMessage({ kind: "still:settings-read" }).then((reply: unknown) => {
          if (!reply || typeof reply !== "object" || (reply as { status?: unknown }).status !== "ready")
            throw new SettingsStorageRecovery("native-authority-unavailable");
          if ((reply as { record?: unknown }).record === null) return null;
          const record = parseStoredSettingsRecord((reply as { record?: unknown }).record);
          if (!record) throw new SettingsStorageRecovery("native-authority-unavailable");
          return record;
        });
      return await this.bounded(operation, signal);
    } catch {
      if (signal?.aborted) throw new SettingsStorageRecovery("native-authority-unavailable");
      // Auxiliary browser bytes may support last-known local blocking, never confirm canonical
      // account state. Recovery stays typed so sync cannot treat this as a fresh successful read.
      throw new SettingsStorageRecovery("native-authority-unavailable", await this.getProjection());
    }
  }
  async readNativeAuthority(): Promise<StoredSettingsRecord | null> {
    const reply: unknown = await chrome.runtime.sendNativeMessage("com.chartash.still", { kind: "get" });
    if (!reply || typeof reply !== "object" || !("settings" in reply)) throw new SettingsStorageRecovery("native-authority-unavailable");
    const value = (reply as { settings: unknown }).settings;
    if (value === "") return null; // actual native absence, distinct from an unavailable reply
    const record = parseStoredSettingsRecord(value);
    if (!record) throw new SettingsStorageRecovery("native-authority-unavailable");
    return record;
  }
  private async getProjection(): Promise<StoredSettingsRecord | null> {
    const value = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    const parsed = parseStoredSettingsRecord(value);
    if (value !== undefined && value !== null && !parsed) throw new SettingsStorageRecovery("unreadable");
    // Preserve opaque legacy members too; the validated projection alone is never write authority.
    if (!parsed || !value || typeof value !== "object") return parsed;
    const root = value as Record<string, unknown>;
    const settings = root.settings && typeof root.settings === "object" ? root.settings : root;
    return { ...("settings" in root ? root : {}), ...parsed, settings: { ...settings, ...parsed.settings,
      services: { ...(settings as { services?: object }).services, ...parsed.settings.services } } };
  }
  async set(record: StoredSettingsRecord): Promise<void> {
    if (this.writer) { await (this.options.nativeMirror ? this.writer.mirror(record) : this.writer.replace(record)); return; }
    // Snapshot imports/reconcile are legacy compatibility. Modern records are owned exclusively
    // by the background/native authority; consumer snapshots cannot mutate their metadata.
    const current = await this.get();
    if (current?.atomic) return;
    const reply: unknown = await chrome.runtime.sendMessage({ kind: "still:settings-record", record });
    if (!reply || typeof reply !== "object" || (reply as { status?: unknown }).status !== "committed")
      throw new SettingsStorageRecovery("authority-unavailable");
  }
  async commitIntent(intent: SettingsIntent): Promise<StoredSettingsRecord> {
    if (this.options.nativeIntent) {
      const record = await this.bounded(this.options.nativeIntent(intent));
      if (!parseStoredSettingsRecord(record)) throw new SettingsStorageRecovery("invalid-commit");
      await this.publishNative(record);
      return record;
    }
    if (chrome.runtime.getURL("").startsWith("safari-web-extension:")) {
      const reply: unknown = await this.bounded(chrome.runtime.sendNativeMessage("com.chartash.still", { kind: "settingsIntent", ...intent }));
      const record = reply && typeof reply === "object" ? parseSettingsIntentReply((reply as { settings?: unknown }).settings) : null;
      if (!record) throw new SettingsStorageRecovery("native-authority-unavailable");
      await this.publishNative(record);
      return record;
    }
    if (this.writer) return this.writer.commit(intent);
    const reply: unknown = await chrome.runtime.sendMessage(settingsIntentMessage(intent));
    if (!reply || typeof reply !== "object" || (reply as { status?: unknown }).status !== "committed")
      throw new SettingsStorageRecovery("authority-unavailable");
    const record = parseStoredSettingsRecord((reply as { record?: unknown }).record);
    if (!record) throw new SettingsStorageRecovery("invalid-commit");
    return { ...record, intentCommitted: (reply as { record: StoredSettingsRecord }).record.intentCommitted };
  }
  initializeAtomic(ownership: AtomicSettingsState["ownership"]): Promise<StoredSettingsRecord> {
    if (!this.writer) return Promise.reject(new SettingsStorageRecovery("authority-unavailable"));
    return this.writer.initialize(ownership);
  }
  /** Called only by the maintained background's actual browser install-event closure. */
  initializeFreshAtomic(): Promise<StoredSettingsRecord> {
    if (!this.writer || this.options.nativeMirror || this.options.nativeIntent || this.isSafari())
      return Promise.reject(new SettingsStorageRecovery("authority-unavailable"));
    return this.writer.initializeFresh(async () => {
      const raw = await chrome.storage.local.get(FRESH_HISTORY_KEYS);
      return FRESH_HISTORY_KEYS.every(key => !Object.hasOwn(raw, key));
    });
  }
  serializeLocalMutation<T>(body: () => Promise<T>): Promise<T> {
    if (!this.writer || this.options.nativeMirror || this.options.nativeIntent || this.isSafari())
      return Promise.reject(new SettingsStorageRecovery("authority-unavailable"));
    return this.writer.serializeLocalMutation(body);
  }
  enterScope(accountId: string | null, sessionId?: string): Promise<StoredSettingsRecord> {
    if (!this.writer) return Promise.reject(new SettingsStorageRecovery("authority-unavailable"));
    return this.writer.enterScope(accountId, sessionId);
  }
  acknowledgeAtomic(envelope: CanonicalSettingsEnvelope, scope: SettingsScope): Promise<StoredSettingsRecord> {
    if (!this.writer) return Promise.reject(new SettingsStorageRecovery("authority-unavailable"));
    return this.writer.acknowledge(envelope, scope);
  }
  private async write(record: StoredSettingsRecord): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: record });
  }
  private mirrorNative(record: StoredSettingsRecord): Promise<StoredSettingsRecord> {
    const area = chrome.storage.local;
    let writer = nativeProjections.get(area);
    if (!writer) {
      writer = new AtomicSettingsWriter({ get: () => this.getProjection(), set: value => this.write(value), subscribe: () => () => {} });
      nativeProjections.set(area, writer);
    }
    const { intentCommitted: _committed, ...persisted } = record;
    return writer.mirror(persisted);
  }
  private async publishNative(record: StoredSettingsRecord): Promise<void> {
    try { await this.mirrorNative(record); }
    catch {
      try { this.options.onProjectionFailure?.(); } catch { /* diagnostics cannot hide a native commit */ }
      if (!this.isSafari()) return;
      // One bounded authority reread/retry, never replay the already accepted intent.
      this.projectionRetry ??= this.bounded(this.readNativeAuthority()).then(async latest => { if (latest) await this.mirrorNative(latest); })
        .catch(() => undefined).finally(() => { this.projectionRetry = null; });
    }
  }
  subscribe(listener: (record: StoredSettingsRecord) => void): () => void {
    let active = true;
    const reads = new AbortController();
    const handler = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
      if (areaName !== "local") return;
      const change = changes[STORAGE_KEY];
      const record = change ? parseStoredSettingsRecord(change.newValue) : null;
      if (!record) return;
      if (this.isSafari() && !this.options.nativeMirror) {
        // Projection writes are change signals. Reread the actual native authority, including
        // after an obsolete direct reply; no background wake is needed for an extension page.
        void this.getAuthoritative(reads.signal).then(current => { if (active && current) listener(current); }, () => undefined);
      } else listener(record);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => { active = false; reads.abort(); chrome.storage.onChanged.removeListener(handler); };
  }
}
