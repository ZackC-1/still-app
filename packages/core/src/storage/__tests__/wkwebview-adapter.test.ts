import { describe, it, expect, vi } from "vitest";
import type { StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { WKWebViewStorageAdapter, type StillBridgeWindow } from "../wkwebview-adapter.js";

function settings(over: Partial<StillSettings> = {}): StillSettings {
  return { ...DEFAULT_SETTINGS, ...over };
}

function record(over: Partial<StillSettings> = {}) {
  return { settings: settings(over), syncMetadata: null };
}

/**
 * A fake native host: an App Group with last-write-wins, exposed through a postMessage port that
 * mirrors WKScriptMessageHandlerWithReply (returns a Promise) and replies exactly like the Swift
 * SettingsBridge: the full StoredSettingsRecord JSON-encoded as a string (encodeRecord), with the
 * syncMetadata key omitted when nil.
 */
function makeNativeHost(stored: StillSettings | null = null) {
  let value: StillSettings | null = stored;
  const posted: unknown[] = [];
  const encodeRecord = () => JSON.stringify({ settings: value });
  const port = {
    postMessage: vi.fn(async (msg: unknown): Promise<unknown> => {
      posted.push(msg);
      const m = msg as { kind: string; settings?: string };
      if (m.kind === "get") return value ? encodeRecord() : "";
      if (m.kind === "set") {
        const parsed = JSON.parse(m.settings!) as StillSettings | { settings: StillSettings };
        const incoming = "settings" in parsed ? parsed.settings : parsed;
        if (!value || incoming.updatedAt > value.updatedAt) value = incoming; // native LWW
        return encodeRecord();
      }
      return null;
    }),
  };
  const win: StillBridgeWindow = { webkit: { messageHandlers: { still: port } } };
  return {
    win,
    port,
    posted,
    get value() {
      return value;
    },
    /** Simulate native pushing an external App Group change into the live UI. */
    pushExternal(s: StillSettings) {
      value = s;
      win.__stillApplyRemote?.(s);
    },
  };
}

describe("WKWebViewStorageAdapter", () => {
  it("get() returns the parsed settings the native host holds", async () => {
    const host = makeNativeHost(settings({ globalOn: false, updatedAt: 5000 }));
    const adapter = new WKWebViewStorageAdapter(host.win);
    const got = await adapter.get();
    expect(got?.settings.globalOn).toBe(false);
    expect(host.port.postMessage).toHaveBeenCalledWith({ kind: "get" });
  });

  it("get() returns null when the native host is empty", async () => {
    const host = makeNativeHost(null);
    const adapter = new WKWebViewStorageAdapter(host.win);
    expect(await adapter.get()).toBeNull();
  });

  it("set() posts the settings as a JSON string and persists them natively", async () => {
    const host = makeNativeHost(null);
    const adapter = new WKWebViewStorageAdapter(host.win);
    await adapter.set(record({ globalOn: false, updatedAt: 7000 }));
    const msg = host.posted.at(-1) as { kind: string; settings: string };
    expect(msg.kind).toBe("set");
    expect(typeof msg.settings).toBe("string");
    expect(JSON.parse(msg.settings).settings.globalOn).toBe(false);
    expect(host.value?.updatedAt).toBe(7000);
  });

  it("set() surfaces the native LWW-resolved value when the App Group held something newer", async () => {
    // Native already holds a newer value (an extension write the app hadn't seen).
    const host = makeNativeHost(settings({ globalOn: true, updatedAt: 9000 }));
    const adapter = new WKWebViewStorageAdapter(host.win);
    const seen = vi.fn();
    adapter.subscribe(seen);
    await adapter.set(record({ globalOn: false, updatedAt: 6000 })); // stale → native keeps 9000
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0].settings.updatedAt).toBe(9000);
    expect(seen.mock.calls[0]![0].settings.globalOn).toBe(true);
  });

  it("set() does not echo to subscribers when our own write wins", async () => {
    const host = makeNativeHost(settings({ updatedAt: 1000 }));
    const adapter = new WKWebViewStorageAdapter(host.win);
    const seen = vi.fn();
    adapter.subscribe(seen);
    await adapter.set(record({ globalOn: false, updatedAt: 2000 })); // newer → ours wins
    expect(seen).not.toHaveBeenCalled();
  });

  it("subscribe() receives native pushes via window.__stillApplyRemote (object form)", () => {
    const host = makeNativeHost(null);
    const adapter = new WKWebViewStorageAdapter(host.win);
    const seen = vi.fn();
    adapter.subscribe(seen);
    host.pushExternal(settings({ globalOn: false, updatedAt: 4242 }));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0].settings.updatedAt).toBe(4242);
  });

  it("subscribe() also accepts a native push delivered as a JSON string", () => {
    const host = makeNativeHost(null);
    const adapter = new WKWebViewStorageAdapter(host.win);
    const seen = vi.fn();
    adapter.subscribe(seen);
    host.win.__stillApplyRemote?.(JSON.stringify(settings({ globalOn: false, updatedAt: 99 })));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0].settings.globalOn).toBe(false);
  });

  it("subscribe() accepts a native push in the Swift encodeRecord shape (record JSON string)", () => {
    const host = makeNativeHost(null);
    const adapter = new WKWebViewStorageAdapter(host.win);
    const seen = vi.fn();
    adapter.subscribe(seen);
    host.win.__stillApplyRemote?.(
      JSON.stringify({ settings: settings({ globalOn: false, updatedAt: 123 }) }),
    );
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0].settings.updatedAt).toBe(123);
    expect(seen.mock.calls[0]![0].syncMetadata).toBeNull();
  });

  it("unsubscribe() stops delivery", () => {
    const host = makeNativeHost(null);
    const adapter = new WKWebViewStorageAdapter(host.win);
    const seen = vi.fn();
    const off = adapter.subscribe(seen);
    off();
    host.pushExternal(settings({ updatedAt: 1 }));
    expect(seen).not.toHaveBeenCalled();
  });

  it("degrades to an empty store with no native host (plain browser)", async () => {
    const adapter = new WKWebViewStorageAdapter({});
    expect(await adapter.get()).toBeNull();
    await expect(adapter.set(record({ updatedAt: 1 }))).resolves.toBeUndefined();
  });
});
