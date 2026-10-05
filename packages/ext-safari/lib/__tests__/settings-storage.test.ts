import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { AtomicSettingsWriter, ChromeStorageAdapter, InMemoryStorageAdapter, SettingsCache,
  type SettingsIntent, type StoredSettingsRecord, SettingsStorageRecovery } from "@still/core/storage";

async function fixture(modern = true, ownership: "unknown" | "never-linked" = "unknown") {
  const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, globalOn: modern, updatedAt: 1 });
  const writer = new AtomicSettingsWriter(storage);
  let projection = modern ? await writer.initialize(ownership) : (await storage.get())!;
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
  it("a delayed legacy native retry cannot replace newer Off projection or unavailable-authority fallback", async () => {
    const h = await fixture(false); vi.useFakeTimers();
    let release!: () => void; let began!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { began = r; });
    const native = h.sendNativeMessage.getMockImplementation()!;
    h.sendNativeMessage.mockImplementation(async (app, message) => {
      const reply = await native(app, message);
      if (message.kind === "get") { began(); await gate; }
      return reply;
    });
    const adapter = new ChromeStorageAdapter({ authority: true, nativeMirror: true });
    h.set.mockRejectedValueOnce(new Error("quota"));
    await adapter.commitIntent({ path: "globalOn", value: true, updatedAt: 10 }); await started;
    const latest = await adapter.commitIntent({ path: "globalOn", value: false, updatedAt: 11 });
    expect(h.projection().settings).toEqual(latest.settings);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(h.projection().settings).toEqual(latest.settings);
    expect((await h.storage.get())!.settings.globalOn).toBe(false);
    expect(h.sendNativeMessage.mock.calls.map(c => c[1].kind)).toEqual(["settingsIntent", "get", "settingsIntent"]);
    h.sendNativeMessage.mockRejectedValue(new Error("unavailable"));
    const fallback = new SettingsCache(new ChromeStorageAdapter()); await fallback.hydrate();
    expect(fallback.current().globalOn).toBe(false);
    await expect(fallback.whenHydrated()).rejects.toThrow("native-authority-unavailable");
    expect(h.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("actual background nativeMirror retries direct native authority after transient projection failure", async () => {
    const h = await fixture(true, "never-linked"); const report = vi.fn(); vi.useFakeTimers();
    const adapter = new ChromeStorageAdapter({ authority: true, nativeMirror: true, onProjectionFailure: report });
    h.set.mockRejectedValueOnce(new Error("quota"));
    const reply = await adapter.commitIntent({ path: "globalOn", value: false, updatedAt: 10 });
    expect(reply.settings.globalOn).toBe(false); await vi.advanceTimersByTimeAsync(0);
    expect(h.sendNativeMessage.mock.calls.map(c => c[1].kind)).toEqual(["settingsIntent", "get"]);
    expect(h.projection().settings.globalOn).toBe(false); expect(h.projection().atomic).toEqual((await h.storage.get())!.atomic);
    expect(h.set).toHaveBeenCalledTimes(2); expect(report).toHaveBeenCalledTimes(1);
    expect((await h.storage.get())!.atomic!.pending).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
    h.sendNativeMessage.mockRejectedValue(new Error("unavailable"));
    const fallback = new SettingsCache(new ChromeStorageAdapter()); await fallback.hydrate();
    expect(fallback.current().globalOn).toBe(false); await expect(fallback.whenHydrated()).rejects.toThrow("native-authority-unavailable");
    expect(h.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("background projection retries singleflight latest durable state and cannot overwrite concurrent success", async () => {
    const h = await fixture(true, "never-linked"); vi.useFakeTimers(); let release!: () => void; let began!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { began = r; });
    const native = h.sendNativeMessage.getMockImplementation()!;
    h.sendNativeMessage.mockImplementation(async (app, message) => {
      if (message.kind === "get") { began(); await gate; }
      return native(app, message);
    });
    const adapter = new ChromeStorageAdapter({ authority: true, nativeMirror: true });
    h.set.mockRejectedValueOnce(new Error("quota")).mockRejectedValueOnce(new Error("quota"));
    await adapter.commitIntent({ path: "globalOn", value: false, updatedAt: 10 }); await started;
    await adapter.commitIntent({ path: "services.youtube", value: false, updatedAt: 11 });
    const latest = await adapter.commitIntent({ path: "services.instagram", value: false, updatedAt: 12 });
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(h.sendNativeMessage.mock.calls.filter(c => c[1].kind === "get")).toHaveLength(1);
    expect(h.sendNativeMessage.mock.calls.filter(c => c[1].kind === "settingsIntent")).toHaveLength(3);
    expect(h.projection().atomic).toEqual(latest.atomic); expect(h.projection().settings).toEqual(latest.settings);
    expect((await h.storage.get())!.atomic!.pending).toHaveLength(3); expect(vi.getTimerCount()).toBe(0); expect(h.listeners.size).toBe(0);
  });
  it("an older successful native reply and stale retry read cannot reduce a later durable projection", async () => {
    const h = await fixture(true, "never-linked"); vi.useFakeTimers(); let releaseIntent!: () => void; let releaseRead!: () => void;
    let began!: () => void; const started = new Promise<void>(r => { began = r; });
    const intentGate = new Promise<void>(r => { releaseIntent = r; }); const readGate = new Promise<void>(r => { releaseRead = r; });
    const native = h.sendNativeMessage.getMockImplementation()!; let first = true;
    h.sendNativeMessage.mockImplementation(async (app, message) => {
      const reply = await native(app, message);
      if (message.kind === "settingsIntent" && first) { first = false; began(); await intentGate; }
      if (message.kind === "get") await readGate;
      return reply;
    });
    const adapter = new ChromeStorageAdapter({ authority: true, nativeMirror: true });
    const old = adapter.commitIntent({ path: "globalOn", value: false, updatedAt: 10 }); await started;
    h.set.mockRejectedValueOnce(new Error("quota"));
    await adapter.commitIntent({ path: "services.youtube", value: false, updatedAt: 11 });
    const latest = await adapter.commitIntent({ path: "services.instagram", value: false, updatedAt: 12 });
    releaseIntent(); await old; releaseRead(); await vi.advanceTimersByTimeAsync(0);
    expect(h.projection().atomic).toEqual(latest.atomic); expect(h.projection().settings).toEqual(latest.settings);
    expect((await h.storage.get())!.atomic!.pending).toHaveLength(3); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])("failed bounded background projection retry tears down and a later failure can retry again (modern=%s)", async modern => {
    const h = await fixture(modern); vi.useFakeTimers(); const native = h.sendNativeMessage.getMockImplementation()!;
    h.sendNativeMessage.mockImplementation(async (app, message) => message.kind === "get" ? new Promise(() => {}) : native(app, message));
    const write = h.set.getMockImplementation()!;
    h.set.mockRejectedValue(new Error("quota"));
    const adapter = new ChromeStorageAdapter({ authority: true, nativeMirror: true });
    await adapter.commitIntent({ path: "globalOn", value: false, updatedAt: 10 });
    expect(vi.getTimerCount()).toBe(1); await vi.advanceTimersByTimeAsync(8_000); expect(vi.getTimerCount()).toBe(0);
    h.sendNativeMessage.mockImplementation(native); h.set.mockReset();
    h.set.mockImplementation(write).mockRejectedValueOnce(new Error("quota"));
    await adapter.commitIntent({ path: "services.youtube", value: false, updatedAt: 11 }); await vi.advanceTimersByTimeAsync(0);
    expect(h.sendNativeMessage.mock.calls.filter(c => c[1].kind === "get")).toHaveLength(2);
    expect(h.projection().settings).toMatchObject({ globalOn: false, services: { youtube: false } });
    expect(vi.getTimerCount()).toBe(0); expect(h.listeners.size).toBe(0);
  });
  it.each([false, true])("delayed native recovery rejection cannot poison a later healthy authority result (replaceAccount=%s)", async replaceAccount => {
    const h = await fixture(); const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";
    await h.writer.enterScope(A);
    let reject!: (error: Error) => void; let began!: () => void; const started = new Promise<void>(r => { began = r; }); let first = true;
    const adapter = new ChromeStorageAdapter({ nativeIntent: async intent => {
      if (first) { first = false; began(); return new Promise((_r, r) => { reject = r; }); }
      return h.writer.commit(intent);
    } });
    const cache = new SettingsCache({ get: adapter.get.bind(adapter), set: adapter.set.bind(adapter), subscribe: adapter.subscribe.bind(adapter),
      commitIntent: adapter.commitIntent.bind(adapter), enterScope: h.writer.enterScope.bind(h.writer), acknowledgeAtomic: h.writer.acknowledge.bind(h.writer) }, { now: () => 10 });
    await cache.hydrate(); const old = cache.setGlobalOn(false); const rejected = expect(old).rejects.toThrow("native-authority-unavailable"); await started;
    if (replaceAccount) await cache.enterAtomicScope(B);
    const scoped = (await h.storage.get())!;
    await cache.acknowledgeAtomic({ protocol: 2, empty: true, settings: scoped.settings, version: 0, serverUpdatedAt: null, lastWriteId: null,
      lineage: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", receipt: { version: 1, lineage: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", revision: 0, mac: "A".repeat(43) } }, scoped.atomic!.scope);
    await cache.setService("youtube", false); const healthy = cache.currentRecord();
    reject(new SettingsStorageRecovery("native-authority-unavailable")); await rejected;
    expect(cache.currentRecord()).toEqual(healthy); expect(cache.currentRecord().atomic!.paused).toBeNull();
    expect(cache.currentRecord().atomic!.scope.accountId).toBe(replaceAccount ? B : A);
    await expect(cache.whenHydrated()).resolves.toBeUndefined(); expect((await h.storage.get())!.atomic).toEqual(healthy.atomic);
    expect(h.listeners.size).toBe(0);
  });

  it.each([false, true])("accepted native commit survives rejected auxiliary projection (injected=%s)", async injected => {
    const h = await fixture(true, "never-linked"); const report = vi.fn();
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

  it("unknown ownership saves local choices and retries nativeMirror without inventing cloud authority", async () => {
    const h = await fixture();
    vi.useFakeTimers();
    const report = vi.fn();
    const adapter = new ChromeStorageAdapter({
      authority: true,
      nativeMirror: true,
      onProjectionFailure: report,
    });
    const localAuthority = {
      format: 1,
      ownership: "unknown",
      scope: { accountId: null, generation: 0 },
      anchor: null,
      pending: [],
      held: {},
      paused: null,
    };
    expect((await h.storage.get())!.atomic).toEqual({
      ...localAuthority,
      sequence: 0,
    });

    const global = await adapter.commitIntent({
      path: "globalOn",
      value: false,
      updatedAt: 10,
    });
    expect(global.intentCommitted).toBe(true);
    expect(global.settings).toMatchObject({ globalOn: false, updatedAt: 10 });
    expect((await h.storage.get())!.atomic).toEqual({
      ...localAuthority,
      sequence: 1,
    });
    expect(h.projection().settings).toEqual(global.settings);
    expect(h.projection().atomic).toEqual({ ...localAuthority, sequence: 1 });

    h.set.mockRejectedValueOnce(new Error("quota"));
    const service = await adapter.commitIntent({
      path: "services.youtube",
      value: false,
      updatedAt: 11,
    });
    expect(service.intentCommitted).toBe(true);
    const saved = structuredClone((await h.storage.get())!);
    expect(saved.settings).toMatchObject({
      globalOn: false,
      services: { youtube: false, instagram: true, tiktok: true, facebook: true },
      updatedAt: 11,
      clocks: {
        globalOn: { baseRevision: 0, localStep: 1 },
        "services.youtube": { baseRevision: 0, localStep: 1 },
      },
    });
    expect(saved.atomic).toEqual({ ...localAuthority, sequence: 2 });
    expect(saved.syncMetadata).toBeNull();
    // The failed auxiliary write has not yet projected the service choice.
    expect(h.projection().settings.services.youtube).toBe(true);
    expect(h.projection().atomic).toEqual({ ...localAuthority, sequence: 1 });

    await vi.advanceTimersByTimeAsync(0);
    expect(await h.storage.get()).toEqual(saved);
    expect(h.projection().settings).toEqual(saved.settings);
    expect(h.projection().atomic).toEqual({ ...localAuthority, sequence: 2 });
    expect(h.sendNativeMessage.mock.calls.map((c) => c[1].kind)).toEqual([
      "settingsIntent",
      "settingsIntent",
      "get",
    ]);
    expect(h.set).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledTimes(1);
    expect(h.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
