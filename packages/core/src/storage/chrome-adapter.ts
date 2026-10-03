import type { StorageAdapter, StoredSettingsRecord } from "./adapter.js";
import { parseSettingsIntentReply, parseStoredSettingsRecord } from "./settings-validation.js";
import { AtomicSettingsWriter, SettingsStorageRecovery, type AtomicSettingsState, type CanonicalSettingsEnvelope, type SettingsIntent, type SettingsScope } from "./atomic-settings.js";
import { settingsIntentMessage } from "./settings-messages.js";

const STORAGE_KEY = "still:settings";
export interface ChromeSettingsAuthorityOptions {
  readonly authority?: boolean;
  /** Safari background maintains only an auxiliary projection of the authoritative native store. */
  readonly nativeMirror?: boolean;
  /** Safari directly calls its native authority so an asleep background never gates free edits. */
  readonly nativeIntent?: (intent: SettingsIntent) => Promise<StoredSettingsRecord>;
}
export class ChromeStorageAdapter implements StorageAdapter {
  private readonly writer: AtomicSettingsWriter | null;
  constructor(private readonly options: ChromeSettingsAuthorityOptions = {}) {
    this.writer = options.authority ? new AtomicSettingsWriter({
      get: () => this.getProjection(), set: record => this.write(record), subscribe: listener => this.subscribe(listener),
    }) : null;
  }
  private isSafari(): boolean { return chrome.runtime?.getURL?.("").startsWith("safari-web-extension:") ?? false; }
  async get(): Promise<StoredSettingsRecord | null> {
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new SettingsStorageRecovery("native-authority-unavailable")), 8_000);
        })]);
      } finally { clearTimeout(timer); }
    } catch {
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
      const record = await this.options.nativeIntent(intent);
      const { intentCommitted: _committed, ...persisted } = record;
      await this.write(persisted); // auxiliary projection/change signal; Safari readers reread native authority
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
    let active = true;
    const handler = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
      if (areaName !== "local") return;
      const change = changes[STORAGE_KEY];
      const record = change ? parseStoredSettingsRecord(change.newValue) : null;
      if (!record) return;
      if (this.isSafari() && !this.options.nativeMirror) {
        // Projection writes are change signals. Reread the actual native authority, including
        // after an obsolete direct reply; no background wake is needed for an extension page.
        void this.get().then(current => { if (active && current) listener(current); }, () => undefined);
      } else listener(record);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => { active = false; chrome.storage.onChanged.removeListener(handler); };
  }
}
