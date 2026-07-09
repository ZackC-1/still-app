import type { StillSettings } from "@still/shared-types";
import type { StorageAdapter, StoredSettingsRecord } from "./adapter.js";
import { parseSettings, parseStoredSettingsRecord } from "./settings-validation.js";

// WKWebView ↔ native bridge (KTD4). The Apple app hosts the one shared Svelte UI in a WKWebView;
// this is the third StorageAdapter implementation, alongside chrome.storage (the extension) and the
// in-memory test double. It persists through native Swift into the App Group container shared with
// the Safari extension:
//
//   web → native:  window.webkit.messageHandlers.still.postMessage({kind,...}) → Promise<reply>
//                  (native uses WKScriptMessageHandlerWithReply, so postMessage returns a Promise)
//   native → web:  window.__stillApplyRemote(record) pushes an external change (e.g. the Safari
//                  extension wrote a newer value) into the already-running UI.
//
// Payloads cross the bridge as JSON so the Swift side round-trips them with a plain JSONCoder — no
// field-by-field marshalling. Web → native sends the record as a JSON string; native replies (and
// pushes) the full StoredSettingsRecord, as an object literal or its JSON-encoded string — the
// parsers below accept both forms.

/** The WKScriptMessageHandlerWithReply surface: postMessage returns a Promise of the native reply. */
export interface StillMessagePort {
  postMessage(message: unknown): Promise<unknown>;
}

/** The subset of `window` the adapter touches — injectable/overridable in tests. */
export interface StillBridgeWindow {
  webkit?: { messageHandlers?: { still?: StillMessagePort } };
  __stillApplyRemote?: (settings: StillSettings | string) => void;
}

/** The message envelope sent web → native. Settings travel as a JSON string (see file header). */
export type BridgeMessage =
  | { readonly kind: "get" }
  | { readonly kind: "set"; readonly settings: string };

export class WKWebViewStorageAdapter implements StorageAdapter {
  private readonly listeners = new Set<(record: StoredSettingsRecord) => void>();

  constructor(
    private readonly win: StillBridgeWindow = globalThis as unknown as StillBridgeWindow,
  ) {}

  private get port(): StillMessagePort | null {
    return this.win.webkit?.messageHandlers?.still ?? null;
  }

  async get(): Promise<StoredSettingsRecord | null> {
    return parseStoredSettingsRecord(await this.post({ kind: "get" }));
  }

  async set(record: StoredSettingsRecord): Promise<void> {
    // Native persists via last-write-wins and replies with the resolved value, so if the App Group
    // already held something newer (an extension write the app hadn't seen) we surface it back to
    // the cache rather than silently clobbering it.
    const resolved = parseStoredSettingsRecord(await this.post({ kind: "set", settings: JSON.stringify(record) }));
    if (resolved && resolved.settings.updatedAt !== record.settings.updatedAt) this.emit(resolved);
  }

  subscribe(listener: (record: StoredSettingsRecord) => void): () => void {
    this.listeners.add(listener);
    // Install the native→web callback once. Native invokes it on every external App Group change;
    // it accepts both a JS object literal (the common path) and a JSON string defensively.
    this.win.__stillApplyRemote ??= (s) => {
      const parsed = parseStoredSettingsRecord(s) ?? parseSettings(s);
      if (parsed) this.emit("settings" in parsed ? parsed : { settings: parsed, syncMetadata: null });
    };
    return () => this.listeners.delete(listener);
  }

  private async post(message: BridgeMessage): Promise<unknown> {
    // No native host (e.g. the bundle opened in a plain browser) → behave as an empty store rather
    // than throwing, so the UI still renders with bundled defaults.
    const port = this.port;
    return port ? port.postMessage(message) : null;
  }

  private emit(record: StoredSettingsRecord): void {
    for (const l of [...this.listeners]) l(record);
  }
}
