// QA-ONLY. Never import this from product code (guarded by tests/qa/webkit/guard.spec.ts).
//
// The in-page half of the WebKit lane's recorded-state boundary shim. Playwright installs it as an
// init script in every frame, before any page script runs. It only acts in the two origins the
// lane serves (the built Safari extension and the built Apple web view) and fakes exactly the
// host boundary those bundles talk to; everything else on the page is the shipped code:
//
//   extension origin → globalThis.browser / globalThis.chrome: runtime (id, getURL, sendMessage,
//     sendNativeMessage, getPlatformInfo, openOptionsPage, onMessage) and storage (local, onChanged).
//     getURL answers with a safari-web-extension: URL so the shared adapter takes its Safari lanes.
//   app origin → window.webkit.messageHandlers.still (WKScriptMessageHandlerWithReply).
//
// Every message is forwarded to the Node-side NativeModel through one exposed binding, which logs
// it and answers it with the native host's own reply shape. Nothing here decides what a screen
// shows. This function must stay self-contained: Playwright serializes it into each frame.
export interface BoundaryShimConfig {
  readonly marker: string;
  readonly extensionOrigin: string;
  readonly appOrigin: string;
  readonly extensionHost: string;
  readonly platform: "ios" | "mac";
  /** browser.storage.local as the extension background left it (its projection of the App Group). */
  readonly storage: Record<string, unknown>;
  /**
   * The device screen the page sees (window.screen). Playwright's own screen emulation reaches only
   * the top-level page, and the visual runner frames the page under test in an iframe.
   */
  readonly screen?: { readonly width: number; readonly height: number };
}

export const BOUNDARY_SHIM_MARKER = "__STILL_QA_BOUNDARY_SHIM__";

export function installBoundaryShim(config: BoundaryShimConfig): void {
  const w = globalThis as unknown as Record<string, unknown> & {
    __stillQaBoundary: (surface: string, message: unknown) => Promise<unknown>;
  };
  const origin = location.origin;
  if (origin !== config.extensionOrigin && origin !== config.appOrigin) return;
  w[config.marker] = true;
  if (config.screen) {
    const device = config.screen;
    for (const [name, value] of [["width", device.width], ["height", device.height], ["availWidth", device.width], ["availHeight", device.height]] as const)
      Object.defineProperty(screen, name, { configurable: true, get: () => value });
  }
  const clone = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const call = (surface: string, message: unknown): Promise<unknown> => w.__stillQaBoundary(surface, clone(message));

  if (origin === config.appOrigin) {
    w.webkit = { messageHandlers: { still: { postMessage: (message: unknown) => call("app", message) } } };
    return;
  }

  // ---- Safari Web Extension page APIs -------------------------------------------------------
  const base = `safari-web-extension://${config.extensionHost}/`;
  const area = new Map<string, unknown>(Object.entries(config.storage).map(([k, v]) => [k, clone(v)]));
  type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
  const changeListeners = new Set<(changes: Changes, areaName: string) => void>();
  const emit = (changes: Changes): void => {
    if (Object.keys(changes).length === 0) return;
    for (const listener of [...changeListeners]) setTimeout(() => listener(clone(changes) as Changes, "local"), 0);
  };
  const keysOf = (keys: unknown): string[] | null =>
    keys === null || keys === undefined ? null : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys.map(String) : Object.keys(keys as object);
  const local = {
    async get(keys?: unknown): Promise<Record<string, unknown>> {
      const wanted = keysOf(keys) ?? [...area.keys()];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (area.has(key)) out[key] = clone(area.get(key));
      if (keys && typeof keys === "object" && !Array.isArray(keys))
        for (const [key, fallback] of Object.entries(keys as Record<string, unknown>)) if (!(key in out)) out[key] = fallback;
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      const changes: Changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: clone(area.get(key)), newValue: clone(value) };
        area.set(key, clone(value));
      }
      emit(changes);
    },
    async remove(keys: unknown): Promise<void> {
      const changes: Changes = {};
      for (const key of keysOf(keys) ?? []) {
        if (!area.has(key)) continue;
        changes[key] = { oldValue: clone(area.get(key)) };
        area.delete(key);
      }
      emit(changes);
    },
    async clear(): Promise<void> {
      await local.remove([...area.keys()]);
    },
  };
  const event = <T>(set: Set<T>) => ({
    addListener: (fn: T) => void set.add(fn),
    removeListener: (fn: T) => void set.delete(fn),
    hasListener: (fn: T) => set.has(fn),
  });
  const api = {
    runtime: {
      id: "com.chartash.still.Extension (UM9HVDH3P3)",
      getURL: (path = "") => base + String(path).replace(/^\//, ""),
      getManifest: () => ({ manifest_version: 3, name: "Still", version: "0.0.0" }),
      getPlatformInfo: async () => ({ os: config.platform, arch: "arm64" }),
      sendMessage: (message: unknown) => call("extension-background", message),
      sendNativeMessage: (_application: string, message: unknown) => call("extension-native", message),
      openOptionsPage: () => call("extension-background", { kind: "qa:openOptionsPage" }).then(() => undefined),
      onMessage: event(new Set<unknown>()),
      onInstalled: event(new Set<unknown>()),
      lastError: undefined,
    },
    storage: {
      local,
      onChanged: event(changeListeners),
    },
  };
  w.browser = api;
  w.chrome = api;
}
