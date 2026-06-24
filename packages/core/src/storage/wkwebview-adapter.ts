import type { StillSettings } from "@still/shared-types";
import type { StorageAdapter } from "./adapter.js";

// WKWebView ↔ native bridge (KTD4). The Apple app hosts the one shared Svelte UI in a WKWebView;
// this is the third StorageAdapter implementation, alongside chrome.storage (the extension) and the
// in-memory test double. It persists through native Swift into the App Group container shared with
// the Safari extension:
//
//   web → native:  window.webkit.messageHandlers.still.postMessage({kind,...}) → Promise<reply>
//                  (native uses WKScriptMessageHandlerWithReply, so postMessage returns a Promise)
//   native → web:  window.__stillApplyRemote(settings) pushes an external change (e.g. the Safari
//                  extension wrote a newer value) into the already-running UI.
//
// Settings cross the bridge as JSON strings so the Swift side decodes them with a plain JSONDecoder
// straight into StillKit's `StillSettings` Codable — no field-by-field marshalling on the bridge.

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
  private readonly listeners = new Set<(s: StillSettings) => void>();

  constructor(
    private readonly win: StillBridgeWindow = globalThis as unknown as StillBridgeWindow,
  ) {}

  private get port(): StillMessagePort | null {
    return this.win.webkit?.messageHandlers?.still ?? null;
  }

  async get(): Promise<StillSettings | null> {
    return parseSettings(await this.post({ kind: "get" }));
  }

  async set(settings: StillSettings): Promise<void> {
    // Native persists via last-write-wins and replies with the resolved value, so if the App Group
    // already held something newer (an extension write the app hadn't seen) we surface it back to
    // the cache rather than silently clobbering it.
    const resolved = parseSettings(await this.post({ kind: "set", settings: JSON.stringify(settings) }));
    if (resolved && resolved.updatedAt !== settings.updatedAt) this.emit(resolved);
  }

  subscribe(listener: (settings: StillSettings) => void): () => void {
    this.listeners.add(listener);
    // Install the native→web callback once. Native invokes it on every external App Group change;
    // it accepts both a JS object literal (the common path) and a JSON string defensively.
    this.win.__stillApplyRemote ??= (s) => {
      const parsed = parseSettings(s);
      if (parsed) this.emit(parsed);
    };
    return () => this.listeners.delete(listener);
  }

  private async post(message: BridgeMessage): Promise<unknown> {
    // No native host (e.g. the bundle opened in a plain browser) → behave as an empty store rather
    // than throwing, so the UI still renders with bundled defaults.
    const port = this.port;
    return port ? port.postMessage(message) : null;
  }

  private emit(settings: StillSettings): void {
    for (const l of [...this.listeners]) l(settings);
  }
}

/** Coerce a bridge value (JSON string, parsed object, null, "") into StillSettings or null. */
function parseSettings(value: unknown): StillSettings | null {
  if (value == null || value === "") return null;
  const obj: unknown = typeof value === "string" ? safeParse(value) : value;
  if (!obj || typeof obj !== "object") return null;
  const s = obj as Partial<StillSettings>;
  if (typeof s.globalOn !== "boolean" || typeof s.updatedAt !== "number" || !s.services) return null;
  return obj as StillSettings;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
