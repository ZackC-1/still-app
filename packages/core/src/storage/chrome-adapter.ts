import type { StorageAdapter, StoredSettingsRecord } from "./adapter.js";
import { parseSettingsIntentReply, parseStoredSettingsRecord } from "./settings-validation.js";
import { AtomicSettingsWriter, SettingsStorageRecovery, type AtomicSettingsState, type CanonicalSettingsEnvelope, type SettingsIntent, type SettingsScope } from "./atomic-settings.js";
import { settingsIntentMessage } from "./settings-messages.js";

const STORAGE_KEY = "still:settings";
export interface ChromeSettingsAuthorityOptions {
  readonly authority?: boolean;
  /** Safari background receives records from the authoritative native store. */
  readonly nativeMirror?: boolean;
  /** Safari directly calls its native authority so an asleep background never gates free edits. */
  readonly nativeIntent?: (intent: SettingsIntent) => Promise<StoredSettingsRecord>;
}
export class ChromeStorageAdapter implements StorageAdapter {
  private readonly writer: AtomicSettingsWriter | null;
  constructor(private readonly options: ChromeSettingsAuthorityOptions = {}) {
    this.writer = options.authority ? new AtomicSettingsWriter({
      get: () => this.get(), set: record => this.write(record), subscribe: listener => this.subscribe(listener),
    }) : null;
  }
  async get(): Promise<StoredSettingsRecord | null> {
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
      const record = await this.options.nativeIntent(intent);
      const { intentCommitted: _committed, ...persisted } = record;
      await this.write(persisted); // read-only local mirror of an already committed native action
      return record;
    }
    if (chrome.runtime.getURL("").startsWith("safari-web-extension:")) {
      const reply: unknown = await chrome.runtime.sendNativeMessage("com.chartash.still", { kind: "settingsIntent", ...intent });
      const record = reply && typeof reply === "object" ? parseSettingsIntentReply((reply as { settings?: unknown }).settings) : null;
      if (!record) throw new SettingsStorageRecovery("native-authority-unavailable");
      const { intentCommitted: _committed, ...persisted } = record;
      await this.write(persisted);
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
  enterScope(accountId: string | null): Promise<StoredSettingsRecord> {
    if (!this.writer) return Promise.reject(new SettingsStorageRecovery("authority-unavailable"));
    return this.writer.enterScope(accountId);
  }
  acknowledgeAtomic(envelope: CanonicalSettingsEnvelope, scope: SettingsScope): Promise<StoredSettingsRecord> {
    if (!this.writer) return Promise.reject(new SettingsStorageRecovery("authority-unavailable"));
    return this.writer.acknowledge(envelope, scope);
  }
  private async write(record: StoredSettingsRecord): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: record });
  }
  subscribe(listener: (record: StoredSettingsRecord) => void): () => void {
    const handler = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
      if (areaName !== "local") return;
      const change = changes[STORAGE_KEY];
      const record = change ? parseStoredSettingsRecord(change.newValue) : null;
      if (record) listener(record);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }
}
