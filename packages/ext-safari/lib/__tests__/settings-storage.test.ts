import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { AtomicSettingsWriter, ChromeStorageAdapter, InMemoryStorageAdapter, SettingsCache,
  type SettingsIntent, type StoredSettingsRecord } from "@still/core/storage";

async function fixture() {
  const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
  const writer = new AtomicSettingsWriter(storage); let projection = await writer.initialize("unknown");
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  const sendNativeMessage = vi.fn(async (_app: string, message: { kind: string } & SettingsIntent) => {
    if (message.kind === "get") return { settings: JSON.stringify(await storage.get()) };
    const result = await writer.commit(message);
    return { settings: JSON.stringify({ status: "committed", changed: result.intentCommitted, record: result }) };
  });
  const set = vi.fn(async (values: Record<string, StoredSettingsRecord>) => {
    projection = structuredClone(values["still:settings"]!);
    listeners.forEach(listener => listener({ "still:settings": { newValue: projection } }, "local"));
  });
  vi.stubGlobal("location", { protocol: "safari-web-extension:" });
  vi.stubGlobal("chrome", { runtime: { getURL: () => "safari-web-extension://still/", sendNativeMessage },
    storage: { local: { get: async () => ({ "still:settings": projection }), set }, onChanged: {
      addListener: (listener: typeof listeners extends Set<infer T> ? T : never) => listeners.add(listener),
      removeListener: (listener: typeof listeners extends Set<infer T> ? T : never) => listeners.delete(listener),
    } } });
  return { writer, storage, set, sendNativeMessage, listeners, projection: () => projection,
    signal() { listeners.forEach(listener => listener({ "still:settings": { newValue: projection } }, "local")); } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Safari authoritative native settings failure boundaries", () => {
  it.each([false, true])("accepted native commit survives rejected auxiliary projection (injected=%s)", async injected => {
    const h = await fixture(); const report = vi.fn();
    if (injected) report.mockImplementation(() => { throw new Error("diagnostic failed"); });
    const cache = new SettingsCache(new ChromeStorageAdapter({ onProjectionFailure: report,
      ...(injected ? { nativeIntent: h.writer.commit.bind(h.writer) } : {}) }), { now: () => 10 });
    await cache.hydrate(); h.set.mockRejectedValue(new Error("quota"));
    await expect(cache.setGlobalOn(false)).resolves.toMatchObject({ globalOn: false });
    expect((await h.storage.get())!.settings.globalOn).toBe(false);
    expect(cache.current().globalOn).toBe(false); expect(report).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.sendNativeMessage.mock.calls.filter(c => c[1].kind === "get").length).toBeGreaterThan(1));
    expect((await h.storage.get())!.atomic!.pending).toHaveLength(1);
  });
  it.each([false, true])("missing native host retains useful Off and reports typed paused recovery (injected=%s)", async injected => {
    const h = await fixture(); await h.writer.commit({ path: "globalOn", value: false, updatedAt: 10 });
    const adapter = new ChromeStorageAdapter(injected ? { nativeIntent: async () => { throw new Error("no host"); } } : {});
    const cache = new SettingsCache(adapter, { now: () => 11 }); await cache.hydrate();
    if (!injected) h.sendNativeMessage.mockRejectedValueOnce(new Error("no host"));
    await expect(cache.setGlobalOn(true)).rejects.toThrow("native-authority-unavailable");
    expect(cache.current().globalOn).toBe(false); expect(h.set).not.toHaveBeenCalled();
    expect(cache.currentRecord().atomic!.paused).toBe("native-authority-unavailable");
    await expect(cache.whenHydrated()).rejects.toThrow("native-authority-unavailable");
  });
  it.each([false, true])("never-resolved intent times out and late native result has no projection effect (injected=%s)", async injected => {
    const h = await fixture();
    let release!: (value: StoredSettingsRecord) => void;
    const pending = new Promise<StoredSettingsRecord>(r => { release = r; });
    const adapter = new ChromeStorageAdapter(injected ? { nativeIntent: () => pending } : {});
    const cache = new SettingsCache(adapter, { now: () => 10 }); await cache.hydrate();
    const before = h.projection();
    if (!injected) h.sendNativeMessage.mockImplementation(async () => ({ settings: JSON.stringify({ status: "committed", changed: true, record: await pending }) }));
    vi.useFakeTimers();
    const action = cache.setGlobalOn(false); const rejected = expect(action).rejects.toThrow("native-authority-unavailable");
    await vi.advanceTimersByTimeAsync(8_000); await rejected;
    expect(cache.current().globalOn).toBe(true);
    await expect(cache.whenHydrated()).rejects.toThrow("native-authority-unavailable");
    const accepted = await h.writer.commit({ path: "globalOn", value: false, updatedAt: 10 });
    release(accepted); await vi.advanceTimersByTimeAsync(0);
    expect(h.projection()).toEqual(before); expect(h.set).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // Timeout releases cache intent suppression: a subsequent authoritative notification lands.
    h.sendNativeMessage.mockImplementation(async () => ({ settings: JSON.stringify(await h.storage.get()) }));
    const stop = cache.watch(); h.signal(); await vi.advanceTimersByTimeAsync(0);
    expect(cache.current().globalOn).toBe(false); await expect(cache.whenHydrated()).resolves.toBeUndefined();
    stop(); expect(h.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("reversed native replies cannot reduce the fallback projection sequence", async () => {
    const h = await fixture(); let release!: () => void; let began!: () => void;
    const started = new Promise<void>(r => { began = r; }); const gate = new Promise<void>(r => { release = r; });
    let first = true;
    const adapter = new ChromeStorageAdapter({ nativeIntent: async intent => {
      const committed = await h.writer.commit(intent);
      if (first) { first = false; began(); await gate; }
      return committed;
    } });
    const old = adapter.commitIntent({ path: "globalOn", value: false, updatedAt: 10 }); await started;
    const latest = await adapter.commitIntent({ path: "services.youtube", value: false, updatedAt: 11 });
    release(); await old;
    expect(h.projection().atomic!.sequence).toBe(latest.atomic!.sequence);
    h.sendNativeMessage.mockRejectedValue(new Error("unavailable"));
    const reopened = new SettingsCache(new ChromeStorageAdapter()); await reopened.hydrate();
    expect(reopened.current()).toMatchObject({ globalOn: false, services: { youtube: false } });
    await expect(reopened.whenHydrated()).rejects.toThrow("native-authority-unavailable");
  });
  it.each(["late", "deadline"])("unsubscribe aborts an unresolved reread before %s with no timer/listener/delivery", async ending => {
    const h = await fixture(); let release!: (value: { settings: string }) => void;
    h.sendNativeMessage.mockImplementation(() => new Promise(r => { release = r; }));
    vi.useFakeTimers(); const delivery = vi.fn(); const stop = new ChromeStorageAdapter().subscribe(delivery);
    h.signal(); expect(vi.getTimerCount()).toBe(1); stop(); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0); expect(h.listeners.size).toBe(0);
    if (ending === "late") release({ settings: JSON.stringify(await h.storage.get()) });
    else await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(0); expect(delivery).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
