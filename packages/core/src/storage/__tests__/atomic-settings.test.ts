import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS, MAX_SETTINGS_LOCAL_STEP, type SettingsV2 } from "@still/shared-types";
import { AtomicSettingsWriter, pendingSettingsRequest, type CanonicalSettingsEnvelope } from "../atomic-settings.js";
import { InMemoryStorageAdapter, type StoredSettingsRecord } from "../adapter.js";
import { SettingsCache } from "../cache.js";
import { WKWebViewStorageAdapter } from "../wkwebview-adapter.js";
import { parseStoredSettingsRecord } from "../settings-validation.js";
import { ChromeStorageAdapter } from "../chrome-adapter.js";
import { createExtensionContentEntry } from "../../content/extension-entry.js";
import type { ContentScriptHandle } from "../../content/index.js";
import { createSettingsIntentRouter } from "../settings-messages.js";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const LINEAGE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SESSION = "cccccccc-cccc-cccc-cccc-cccccccccccc";
function authority() {
  const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
  const writer = new AtomicSettingsWriter(storage);
  const port = { get: () => storage.get(), set: (r: StoredSettingsRecord) => writer.replace(r).then(() => undefined),
    subscribe: storage.subscribe.bind(storage), commitIntent: writer.commit.bind(writer), initializeAtomic: writer.initialize.bind(writer),
    enterScope: writer.enterScope.bind(writer), acknowledgeAtomic: writer.acknowledge.bind(writer) };
  return { storage, writer, port };
}
function canonical(record: StoredSettingsRecord, revision: number): CanonicalSettingsEnvelope {
  return { protocol: 2, empty: false, settings: record.settings, version: revision,
    serverUpdatedAt: "2026-10-02T00:00:00Z", lastWriteId: null, lineage: LINEAGE,
    receipt: { version: 1, lineage: LINEAGE, revision, mac: "A".repeat(43) } };
}
describe("existing cache and serialized complete-record authority", () => {
  it.each(["mirror", "replace"] as const)("%s orders legacy records by epoch, metadata version, then timestamp", async operation => {
    const current = { settings: { ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 11 }, syncEpoch: 2,
      syncMetadata: { version: 3, serverUpdatedAt: "2026-10-02T00:00:00Z", lastWriteId: A }, opaque: { preserved: true } };
    const storage = new InMemoryStorageAdapter(current); const writer = new AtomicSettingsWriter(storage);
    for (const stale of [
      { ...current, syncEpoch: 1, settings: { ...current.settings, updatedAt: 999 } },
      { ...current, syncMetadata: null, settings: { ...current.settings, updatedAt: 999 } },
      { ...current, syncMetadata: { ...current.syncMetadata, version: 2 }, settings: { ...current.settings, updatedAt: 999 } },
      { ...current, settings: { ...current.settings, globalOn: true, updatedAt: 10 } },
    ]) {
      expect(await writer[operation](stale)).toEqual(current); expect(await storage.get()).toEqual(current);
    }
    const newerVersion = { ...current, settings: { ...current.settings, updatedAt: 1 }, syncMetadata: { ...current.syncMetadata, version: 4 } };
    expect(await writer[operation](newerVersion)).toEqual(newerVersion);
    const replacementAccount = { ...current, syncEpoch: 3, settings: { ...current.settings, updatedAt: 0 }, syncMetadata: null };
    expect(await writer[operation](replacementAccount)).toEqual(replacementAccount);
    expect((await storage.get()) as typeof current).toHaveProperty("opaque", { preserved: true });
  });
  it.each(["ordinary", "generation", "sequence", "epoch"] as const)("never-linked null scope preserves the complete Off record at %s bounds", async bound => {
    const h = authority(); await h.writer.initialize("never-linked");
    await h.writer.commit({ path: "globalOn", value: false, updatedAt: 10 });
    const saved = (await h.storage.get())!;
    const record = { ...saved, futureRoot: { retained: false }, syncEpoch: bound === "epoch" ? Number.MAX_SAFE_INTEGER : saved.syncEpoch,
      atomic: { ...saved.atomic!, futureState: { retained: true }, sequence: bound === "sequence" ? Number.MAX_SAFE_INTEGER : saved.atomic!.sequence,
        scope: { ...saved.atomic!.scope, generation: bound === "generation" ? Number.MAX_SAFE_INTEGER : saved.atomic!.scope.generation } } };
    await h.storage.set(record); const before = JSON.stringify(await h.storage.get());
    const write = vi.spyOn(h.storage, "set");
    expect(JSON.stringify(await h.writer.enterScope(null))).toBe(before);
    expect(JSON.stringify(await h.storage.get())).toBe(before); expect(write).not.toHaveBeenCalled();
    expect(record.atomic.pending[0]!.operations).toEqual([{ path: "globalOn", value: false, baseRevision: 0, localStep: 1 }]);
  });
  it("a pre-anchor hold resolves after acknowledgement and a deliberate later edit", async () => {
    const h = authority(); await h.writer.initialize("never-linked");
    const linked = await h.writer.enterScope(A);
    await h.writer.commit({ path: "globalOn", value: false, updatedAt: 10 });
    const account = { ...linked, settings: { ...linked.settings, globalOn: false } };
    await h.writer.acknowledge(canonical(account, 1), linked.atomic!.scope);
    const saved = await h.writer.commit({ path: "globalOn", value: true, updatedAt: 11 });
    expect(saved.atomic).toMatchObject({ paused: null, held: {} });
    expect(pendingSettingsRequest(saved.atomic!.pending[0]!, saved.atomic!)).toMatchObject({ receipt: { revision: 1 }, operations: [{ value: true, localStep: 1 }] });
  });
  it.each([A, B])("prior-account held choices do not overlay a nonempty replacement scope (%s)", async account => {
    const h = authority(); await h.writer.initialize("unknown");
    const cache = new SettingsCache(h.port, { now: () => 10 }); await cache.hydrate();
    await cache.setGlobalOn(false); const first = await cache.enterAtomicScope(A);
    const defaults = authority(); const baseline = await defaults.writer.initialize("unknown");
    await cache.acknowledgeAtomic({ ...canonical(baseline, 0), empty: true }, first);
    expect(cache.current().globalOn).toBe(false);
    await cache.enterAtomicScope(null);
    const replacement = await cache.enterAtomicScope(account);
    await cache.acknowledgeAtomic(canonical(baseline, 1), replacement);
    expect(cache.current().globalOn).toBe(true);
    expect(cache.currentRecord().atomic).toMatchObject({ paused: null, held: {} });
  });
  it("an undelivered old A generation retires without replay after A-null-B-null-A", async () => {
    const h = authority(); await h.writer.initialize("unknown");
    const linked = await h.writer.enterScope(A); const row = canonical(linked, 1);
    await h.writer.acknowledge(row, linked.atomic!.scope);
    const sent = await h.writer.commit({ path: "globalOn", value: false, updatedAt: 10 });
    const original = structuredClone(sent.atomic!.pending);
    await h.writer.enterScope(null); await h.writer.enterScope(B); await h.writer.enterScope(null);
    const current = await h.writer.enterScope(A);
    const resolved = await h.writer.acknowledge(row, current.atomic!.scope);
    expect(resolved.settings.globalOn).toBe(true);
    expect(resolved.atomic!.pending).toEqual([]);
    expect(pendingSettingsRequest(original[0]!, resolved.atomic!)).toBeNull();
  });
  it("bounded broker denies content hosts and malformed actions before allocation", async () => {
    const h = authority(); await h.writer.initialize("unknown");
    const commit = vi.fn(h.writer.commit.bind(h.writer));
    const route = createSettingsIntentRouter(commit, "still", "chrome-extension://still/");
    const message = { kind: "still:settings-intent", path: "globalOn", value: false, updatedAt: 10 };
    const reply = vi.fn();
    expect(route(message, { id: "still", url: "https://youtube.com/" }, reply)).toBe(false);
    for (const invalid of [{ ...message, value: 0 }, { ...message, updatedAt: 1.5 }, { ...message, extra: true }, { ...message, path: "sites.tiktok" }])
      expect(route(invalid, { id: "still", url: "chrome-extension://still/popup.html" }, reply)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect((await h.storage.get())!.atomic!.pending).toEqual([]);
  });
  it("trusted popup broker commits free intent without auth and replies after persistence", async () => {
    const h = authority(); await h.writer.initialize("unknown");
    const route = createSettingsIntentRouter(h.writer.commit.bind(h.writer), "still", "chrome-extension://still/");
    const response = new Promise<unknown>(resolveReply => {
      expect(route({ kind: "still:settings-intent", path: "globalOn", value: false, updatedAt: 10 },
        { id: "still", url: "chrome-extension://still/popup.html" }, resolveReply)).toBe(true);
    });
    const reply = await response as { status: string; record: StoredSettingsRecord };
    expect(reply.status).toBe("committed");
    expect(reply.record.settings.globalOn).toBe(false);
    expect((await h.storage.get())!.atomic!.pending).toEqual(reply.record.atomic!.pending);
  });
  it("two actual cache hosts merge independent actions and allocate no duplicate step", async () => {
    const h = authority();
    const left = new SettingsCache(h.port, { atomicOwnership: "unknown", now: () => 10 });
    const right = new SettingsCache(h.port, { now: () => 10 });
    await left.hydrate(); await right.hydrate();
    await Promise.all([left.setGlobalOn(false), right.setService("youtube", false)]);
    await right.setGlobalOn(true);
    const saved = (await h.storage.get())!;
    const settings = saved.settings as unknown as SettingsV2;
    expect(settings.clocks.globalOn.localStep).toBe(2);
    expect(settings.clocks["services.youtube"].localStep).toBe(1);
    expect(saved.atomic?.pending).toHaveLength(3);
    expect(new Set(saved.atomic?.pending.map(p => p.writeId)).size).toBe(3);
    expect(saved.settings.services.youtube).toBe(false);
    expect(saved.atomic?.sequence).toBe(3);
  });
  it("older acknowledgement keeps newer action and immutable retry body", async () => {
    const h = authority(); await h.writer.initialize("unknown");
    const scoped = await h.writer.enterScope(A);
    await h.writer.acknowledge(canonical(scoped, 1), scoped.atomic!.scope);
    const sent = await h.writer.commit({ path: "globalOn", value: false, updatedAt: 10 });
    const request = pendingSettingsRequest(sent.atomic!.pending[0]!, sent.atomic!)!;
    const retry = JSON.stringify(request);
    await h.writer.commit({ path: "globalOn", value: true, updatedAt: 11 });
    const resolved = await h.writer.acknowledge(canonical(sent, 2), sent.atomic!.scope);
    expect(resolved.settings.globalOn).toBe(true);
    expect(resolved.atomic!.pending).toHaveLength(1);
    expect(JSON.stringify(request)).toBe(retry);
    expect(resolved.atomic!.pending[0]!.operations[0]!.localStep).toBe(2);
    expect(resolved.atomic!.pending[0]!.operations[0]!.baseRevision).toBe(1);
  });
  it("durable scope fences an A-to-B-to-A delayed response", async () => {
    const h = authority(); await h.writer.initialize("unknown");
    const first = await h.writer.enterScope(A);
    await h.writer.enterScope(B);
    const current = await h.writer.enterScope(A);
    const before = await h.storage.get();
    expect(current.atomic!.scope.generation).toBe(3);
    await h.writer.acknowledge(canonical(first, 9), first.atomic!.scope);
    expect(await h.storage.get()).toEqual(before);
  });
  it("saturation keeps local choice in held state without inventing a step", async () => {
    const h = authority(); const initial = await h.writer.initialize("unknown");
    const modern = initial.settings as unknown as SettingsV2;
    const saturated = { ...modern, pauses: [], clocks: { ...modern.clocks,
      globalOn: { baseRevision: 0, localStep: MAX_SETTINGS_LOCAL_STEP } } };
    await h.storage.set({ ...initial, settings: saturated });
    const cache = new SettingsCache(h.port, { now: () => 10 }); await cache.hydrate();
    await cache.setGlobalOn(false);
    const saved = (await h.storage.get())!;
    expect(cache.current().globalOn).toBe(false);
    expect(saved.settings.globalOn).toBe(true);
    expect((saved.settings as unknown as SettingsV2).clocks.globalOn.localStep).toBe(MAX_SETTINGS_LOCAL_STEP);
    expect(saved.atomic).toMatchObject({ held: { globalOn: false }, paused: "ordering-hold", pending: [] });
  });
  it("no-op/read do not allocate or notify and coarse snapshots preserve whole modern record", async () => {
    const h = authority(); const initial = await h.writer.initialize("unknown");
    const set = vi.spyOn(h.storage, "set");
    const cache = new SettingsCache(h.port, { now: () => 10 }); await cache.hydrate();
    const notify = vi.fn(); cache.subscribe(notify);
    await cache.setGlobalOn(true); await cache.hydrate();
    expect(set).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
    await h.writer.replace({ settings: { ...DEFAULT_SETTINGS, globalOn: false, updatedAt: 999 }, syncMetadata: null });
    expect(await h.storage.get()).toEqual(initial);
  });
  it("unknown ownership never uploads pre-link intent; proven never-linked transfers only actual intent", async () => {
    for (const owner of ["unknown", "never-linked"] as const) {
      const h = authority(); await h.writer.initialize(owner);
      await h.writer.commit({ path: "globalOn", value: false, updatedAt: 10 });
      const scope = await h.writer.enterScope(A);
      const clean = authority(); const account = await clean.writer.initialize("unknown");
      const resolved = await h.writer.acknowledge(canonical(account, 0), scope.atomic!.scope);
      const requests = resolved.atomic!.pending.map(p => pendingSettingsRequest(p, resolved.atomic!)).filter(Boolean);
      expect(requests).toHaveLength(owner === "never-linked" ? 1 : 0);
      if (requests[0]) expect(requests[0].operations).toEqual([{ path: "globalOn", value: false, baseRevision: 0, localStep: 1 }]);
    }
  });
  it("Safari content read timeout keeps local Off choices and fences a late broker reply", async () => {
    const h = authority(); await h.writer.initialize("unknown");
    const saved = await h.writer.commit({ path: "globalOn", value: false, updatedAt: 10 });
    let release!: (reply: unknown) => void;
    const pending = new Promise<unknown>(resolveReply => { release = resolveReply; });
    vi.stubGlobal("location", { protocol: "https:" });
    vi.stubGlobal("chrome", { runtime: { getURL: () => "safari-web-extension://still/", sendMessage: () => pending },
      storage: { local: { get: async () => ({ "still:settings": saved }) } } });
    vi.useFakeTimers();
    try {
      const cache = new SettingsCache(new ChromeStorageAdapter()); const hydration = cache.hydrate();
      await vi.advanceTimersByTimeAsync(8_000); await hydration;
      expect(cache.current().globalOn).toBe(false);
      expect(cache.currentRecord().atomic!.paused).toBe("native-authority-unavailable");
      await expect(cache.whenHydrated()).rejects.toThrow("native-authority-unavailable");
      release({ status: "ready", record: { ...saved, settings: { ...saved.settings, globalOn: true } } });
      await Promise.resolve(); await Promise.resolve();
      expect(cache.current().globalOn).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
  it("a local action during empty-account adoption keeps earlier unknown-owner choices held", async () => {
    const h = authority(); await h.writer.initialize("unknown");
    const cache = new SettingsCache(h.port, { now: () => 10 }); await cache.hydrate();
    await cache.setGlobalOn(false); const pending: never[] = [];
    const scope = await cache.enterAtomicScope(A); await cache.setService("youtube", false);
    const clean = authority(); const defaults = await clean.writer.initialize("unknown");
    await cache.acknowledgeAtomic({ ...canonical(defaults, 0), empty: true }, scope);
    expect(cache.current()).toMatchObject({ globalOn: false, services: { youtube: false } });
    expect((await h.storage.get())!.atomic).toMatchObject({ pending, paused: "ownership-hold",
      held: { globalOn: false, "services.youtube": false } });
  });
  it("writer rejects reused operation identity before mutation", async () => {
    const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
    const writer = new AtomicSettingsWriter(storage, () => A);
    await writer.initialize("unknown");
    await writer.commit({ path: "globalOn", value: false, updatedAt: 10 });
    const before = await storage.get();
    await expect(writer.commit({ path: "globalOn", value: true, updatedAt: 11 })).rejects.toThrow("write-id-conflict");
    expect(await storage.get()).toEqual(before);
  });
  it("future and malformed data remain raw and cannot become fresh", () => {
    expect(parseStoredSettingsRecord({ settings: { ...DEFAULT_SETTINGS, schemaVersion: 99 }, atomic: {} })).toBeNull();
    expect(parseStoredSettingsRecord({ settings: { ...DEFAULT_SETTINGS, globalOn: 1 } })).toBeNull();
  });
});

describe.skipIf(process.platform !== "darwin")("actual compiled two-process native authority", () => {
  let temporary: string; let binary: string;
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), "still-atomic-native-")); binary = join(temporary, "writer");
    const root = resolve(import.meta.dirname, "../../../../..");
    await copyFile(join(import.meta.dirname, "support/atomic-settings-main.swift"), join(temporary, "main.swift"));
    await promisify(execFile)("swiftc", [...["StillSettings", "SharedSettingsStore", "SettingsBridge", "SettingsV2", "SettingsFieldOrder", "PackagedFeatureRegistry", "AtomicSettingsBacking", "AtomicSettingsRecord"]
      .map(name => join(root, "apps/apple/StillKit/Sources/StillKit", `${name}.swift`)), join(temporary, "main.swift"),
      "-module-cache-path", join(temporary, "modules"), "-o", binary]);
  }, 60_000);
  afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });
  function host(directory: string, pause = false) {
    const child = spawn(binary, [directory, ...(pause ? ["pause"] : [])], { stdio: ["pipe", "pipe", "pipe"] });
    const queue: { resolve: (value: string) => void; reject: (e: Error) => void }[] = [];
    const lines = createInterface({ input: child.stdout });
    lines.on("line", value => queue.shift()?.resolve(value));
    child.on("exit", () => queue.splice(0).forEach(p => p.reject(new Error("native exited"))));
    const post = (message: unknown) => new Promise<string>((resolveReply, reject) => {
      queue.push({ resolve: resolveReply, reject }); child.stdin.write((typeof message === "string" ? message : JSON.stringify(message)) + "\n");
    });
    return { child, post, adapter: new WKWebViewStorageAdapter({ webkit: { messageHandlers: { still: { postMessage: post } } } }),
      async close() { lines.close(); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(r => child.once("exit", r)); } } };
  }

  it("TS and compiled native preserve never-linked null scope bytes and original Off intent until acknowledgement", async () => {
    const h = authority(); const baseline = await h.writer.initialize("never-linked");
    await h.writer.commit({ path: "globalOn", value: false, updatedAt: 10 });
    const saved = (await h.storage.get())!;
    const original = structuredClone(saved.atomic!.pending[0]!);
    const native = host(join(temporary, "never-linked-null"));
    try {
      for (const bound of ["ordinary", "generation", "sequence", "epoch"] as const) {
        const record = { ...saved, futureRoot: { retained: false }, syncEpoch: bound === "epoch" ? Number.MAX_SAFE_INTEGER : saved.syncEpoch,
          atomic: { ...saved.atomic!, futureState: { retained: true }, sequence: bound === "sequence" ? Number.MAX_SAFE_INTEGER : saved.atomic!.sequence,
            scope: { ...saved.atomic!.scope, generation: bound === "generation" ? Number.MAX_SAFE_INTEGER : saved.atomic!.scope.generation } } };
        const bytes = JSON.stringify(record, null, 2); await h.storage.set(record); await native.post("replace:" + JSON.stringify(record));
        // The host replacement is one line; whitespace is covered independently by StillKit.
        const nativeBytes = await native.post({ kind: "get" });
        expect(await h.writer.enterScope(null)).toEqual(record); expect(await native.adapter.enterScope(null)).toEqual(record);
        expect(await native.post({ kind: "get" })).toBe(nativeBytes);
        expect(JSON.stringify(await h.storage.get(), null, 2)).toBe(bytes);
      }
      for (const ownership of ["unknown", "previous-account"] as const) {
        const unowned = { ...saved, atomic: { ...saved.atomic!, ownership } };
        await h.storage.set(unowned); await native.post("replace:" + JSON.stringify(unowned));
        for (const adapter of [h.port, native.adapter]) {
          const retired = await adapter.enterScope(null);
          expect(retired.settings).toEqual(saved.settings); expect(retired.atomic!.pending).toEqual([]);
          expect(retired.atomic!.scope.generation).toBe(saved.atomic!.scope.generation + 1);
          expect(pendingSettingsRequest(original, retired.atomic!)).toBeNull();
        }
      }
      await h.storage.set(saved); await native.post("replace:" + JSON.stringify(saved));
      for (const adapter of [h.port, native.adapter]) {
        await adapter.enterScope(null); const linked = await adapter.enterScope(A, SESSION);
        expect(linked.atomic!.pending[0]).toMatchObject({ writeId: original.writeId, operations: original.operations, receipt: original.receipt,
          originScope: original.scope, scope: linked.atomic!.scope });
        const waiting = await adapter.acknowledgeAtomic(canonical(baseline, 0), linked.atomic!.scope);
        expect(waiting.settings.globalOn).toBe(false);
        expect(waiting.atomic!.pending[0]).toMatchObject({ writeId: original.writeId, operations: original.operations });
        const accepted = await adapter.acknowledgeAtomic(canonical(waiting, 1), linked.atomic!.scope);
        expect(accepted.settings.globalOn).toBe(false); expect(accepted.atomic!.pending).toEqual([]);
      }
    } finally { await native.close(); }
  });

  it("TS and independent native hosts require session provenance and fence a new login for the same UUID", async () => {
    const h = authority(); const baseline = await h.writer.initialize("unknown");
    const native = host(join(temporary, "session-provenance")); const peer = host(join(temporary, "session-provenance"));
    const nextSession = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const exercise = async (adapter: typeof h.port | WKWebViewStorageAdapter) => {
      const linked = await adapter.enterScope(A, SESSION);
      await adapter.acknowledgeAtomic(canonical(baseline, 1), linked.atomic!.scope);
      const before = await adapter.commitIntent({ path: "globalOn", value: false, updatedAt: 10 });
      const immutable = structuredClone(before.atomic!.pending[0]!);
      expect(await adapter.enterScope(A, SESSION)).toEqual({ ...before, intentCommitted: undefined });
      const replacement = await adapter.enterScope(A, nextSession);
      expect(replacement.atomic).toMatchObject({ scope: { accountId: A, sessionId: nextSession, generation: linked.atomic!.scope.generation + 1 },
        ownership: "previous-account", pending: [] });
      expect(replacement.settings).toEqual(before.settings);
      expect(pendingSettingsRequest(immutable, replacement.atomic!)).toBeNull();
      expect(await adapter.acknowledgeAtomic(canonical(baseline, 9), before.atomic!.scope)).toEqual(replacement);
      return replacement;
    };
    try {
      await native.post("seed"); const ts = await exercise(h.port); const swift = await exercise(peer.adapter);
      expect(swift).toEqual(ts);
      const unknown = structuredClone(ts); delete (unknown.atomic!.scope as { sessionId?: string }).sessionId;
      await h.storage.set(unknown); await native.post("replace:" + JSON.stringify(unknown));
      await expect(h.writer.enterScope(A, nextSession)).rejects.toThrow("session-unconfirmed");
      await expect(peer.adapter.enterScope(A, nextSession)).rejects.toThrow("native-atomic-unavailable");
      expect(await h.storage.get()).toEqual(unknown); expect(await native.adapter.get()).toEqual(unknown);
      for (const invalid of ["", SESSION + "\n", "x".repeat(1000), 1]) {
        await expect(h.writer.enterScope(A, invalid as string)).rejects.toThrow("session-unconfirmed");
        const reply = await peer.post({ kind: "settingsAtomic", command: JSON.stringify({ action: "scope", accountId: A, sessionId: invalid }) });
        expect(JSON.parse(reply)).toEqual({ status: "unavailable" });
        expect(await h.storage.get()).toEqual(unknown); expect(await native.adapter.get()).toEqual(unknown);
      }
    } finally { await native.close(); await peer.close(); }
  });

  it.each([A, B])("TS and compiled native resume immutable eligible64, retire obsolete64 and admit current intent (%s)", async account => {
    const h = authority(); await h.writer.initialize("unknown");
    const native = host(join(temporary, "retirement-" + account));
    const peer = host(join(temporary, "retirement-" + account));
    const exercise = async (adapter: typeof h.port | WKWebViewStorageAdapter) => {
      const initial = (await adapter.get())!; const linked = await adapter.enterScope(A, SESSION);
      await adapter.acknowledgeAtomic(canonical(initial, 1), linked.atomic!.scope);
      for (let i = 0; i < 65; i++) await adapter.commitIntent({ path: "globalOn", value: i % 2 !== 0, updatedAt: 10 + i });
      const before = (await adapter.get())!; const pending = structuredClone(before.atomic!.pending);
      expect(pending).toHaveLength(64); expect(before.atomic!.held).toEqual({ globalOn: false });
      const resumed = await adapter.enterScope(A, SESSION);
      expect(resumed).toEqual(before); // no epoch, anchor, rank, ID or held mutation on process resume
      const acknowledged = await adapter.acknowledgeAtomic(canonical(initial, 1), resumed.atomic!.scope);
      expect(acknowledged.atomic!.pending).toEqual(pending); expect(acknowledged.atomic!.held).toEqual({ globalOn: false });
      expect(pending.map(p => pendingSettingsRequest(p, acknowledged.atomic!)).filter(Boolean)).toHaveLength(64);
      const signedOut = await adapter.enterScope(null);
      expect(signedOut.atomic!.pending).toEqual([]); expect(signedOut.atomic!.held).toEqual({ globalOn: false });
      expect(signedOut.settings.globalOn).toBe(before.settings.globalOn);
      const next = await adapter.enterScope(account);
      expect(next.atomic!.scope.generation).toBeGreaterThan(before.atomic!.scope.generation);
      const adopted = await adapter.acknowledgeAtomic(canonical(initial, 1), next.atomic!.scope);
      expect(adopted.atomic!.held).toEqual({}); expect(adopted.atomic!.ownership).toBe("previous-account");
      const fresh = await adapter.commitIntent({ path: "services.youtube", value: false, updatedAt: 100 });
      expect(fresh.atomic!.pending).toHaveLength(1); expect(fresh.atomic!.paused).toBeNull();
      const request = pendingSettingsRequest(fresh.atomic!.pending[0]!, fresh.atomic!)!;
      expect(request.operations).toEqual([{ path: "services.youtube", value: false, baseRevision: 1, localStep: 1 }]);
      expect(pending.some(p => p.writeId === request.writeId)).toBe(false);
      expect(pending.map(p => pendingSettingsRequest(p, fresh.atomic!)).filter(Boolean)).toEqual([]);
      return { scope: fresh.atomic!.scope, operations: request.operations, anchor: fresh.atomic!.anchor, held: fresh.atomic!.held,
        paused: fresh.atomic!.paused, sequence: fresh.atomic!.sequence, settings: fresh.settings, ownership: fresh.atomic!.ownership };
    };
    try {
      await native.post("seed");
      const ts = await exercise(h.port); const swift = await exercise(peer.adapter);
      expect(swift).toEqual(ts); expect((await native.adapter.get())!.atomic!.pending).toHaveLength(1);
    } finally { await native.close(); await peer.close(); }
  });
  it("TS and compiled Swift ordering holds clear only after canonical matching choice and permit a new rank", async () => {
    const h = authority(); const initial = await h.writer.initialize("unknown");
    const scoped = await h.writer.enterScope(A); await h.writer.acknowledge(canonical(initial, 1), scoped.atomic!.scope);
    const saved = (await h.storage.get())!; const settings = saved.settings as unknown as SettingsV2;
    const saturated = { ...saved, settings: { ...settings, pauses: [], clocks: { ...settings.clocks, globalOn: { baseRevision: 1, localStep: MAX_SETTINGS_LOCAL_STEP } } } };
    await h.storage.set(saturated); const native = host(join(temporary, "ordering-hold"));
    try {
      await native.post("replace:" + JSON.stringify(saturated));
      for (const adapter of [h.port, native.adapter]) {
        const held = await adapter.commitIntent({ path: "globalOn", value: false, updatedAt: 10 });
        expect(held.atomic).toMatchObject({ paused: "ordering-hold", held: { globalOn: false }, pending: [] });
        const canonicalSettings = { ...settings, globalOn: false, clocks: { ...settings.clocks, globalOn: { baseRevision: 2, localStep: 0 } } };
        const acknowledged = await adapter.acknowledgeAtomic(canonical({ ...saved, settings: { ...canonicalSettings, pauses: [] } }, 2), scoped.atomic!.scope);
        expect(acknowledged.atomic).toMatchObject({ paused: null, held: {}, pending: [] });
        const committed = await adapter.commitIntent({ path: "globalOn", value: true, updatedAt: 11 });
        expect(committed.atomic!.pending[0]!.operations).toEqual([{ path: "globalOn", value: true, baseRevision: 2, localStep: 1 }]);
      }
    } finally { await native.close(); }
  });
  it("already persisted obsolete generations retire on the TS and compiled native commit boundary", async () => {
    const h = authority(); await h.writer.initialize("unknown"); const initial = (await h.storage.get())!;
    const linked = await h.writer.enterScope(A); await h.writer.acknowledge(canonical(initial, 1), linked.atomic!.scope);
    for (let i = 0; i < 64; i++) await h.writer.commit({ path: "globalOn", value: i % 2 !== 0, updatedAt: i + 10 });
    const saved = (await h.storage.get())!;
    const prior22b = { ...saved, atomic: { ...saved.atomic!, scope: { accountId: A, generation: saved.atomic!.scope.generation + 2 } } };
    await h.storage.set(prior22b); const native = host(join(temporary, "persisted-retired"));
    try {
      await native.post("replace:" + JSON.stringify(prior22b));
      for (const adapter of [h.port, native.adapter]) {
        const current = await adapter.commitIntent({ path: "services.youtube", value: false, updatedAt: 100 });
        expect(current.atomic!.pending).toHaveLength(1); expect(current.atomic!.paused).toBeNull();
        expect(current.atomic!.pending[0]!.scope).toEqual(prior22b.atomic.scope);
        expect(pendingSettingsRequest(current.atomic!.pending[0]!, current.atomic!)).not.toBeNull();
        expect((current.settings as unknown as SettingsV2).clocks.globalOn).toEqual((saved.settings as unknown as SettingsV2).clocks.globalOn);
        expect(saved.atomic!.pending.map(p => pendingSettingsRequest(p, current.atomic!)).filter(Boolean)).toEqual([]);
      }
    } finally { await native.close(); }
  });
  it("two independent native hosts allocate distinct steps and preserve peer fields immediately", async () => {
    const directory = join(temporary, "parallel"); const first = host(directory), peer = host(directory);
    try {
      await first.post("seed");
      const left = new SettingsCache(first.adapter, { now: () => 10 });
      const right = new SettingsCache(peer.adapter, { now: () => 10 });
      await left.hydrate(); await right.hydrate();
      await Promise.all([left.setGlobalOn(false), right.setService("youtube", false)]);
      await right.setGlobalOn(true);
      const saved = (await first.adapter.get())!;
      expect(saved.settings.services.youtube).toBe(false);
      expect((saved.settings as unknown as SettingsV2).clocks.globalOn.localStep).toBe(2);
      expect(saved.atomic!.pending).toHaveLength(3);
      expect(new Set(saved.atomic!.pending.map(p => p.writeId)).size).toBe(3);
    } finally { await Promise.all([first.close(), peer.close()]); }
  });
  it("characterizes near-bound native persistence and live-holder contention on the macOS test host", async () => {
    const directory = join(temporary, "native-latency"); const native = host(directory);
    let holder: ReturnType<typeof spawn> | undefined;
    try {
      await native.post("seed"); const record = (await native.adapter.get())!;
      const padded = { ...record, padding: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`p${i}`, "x".repeat(8_192)])) };
      const bytes = JSON.stringify(padded); expect(Buffer.byteLength(bytes)).toBeGreaterThan(120_000);
      expect(Buffer.byteLength(bytes)).toBeLessThan(131_072); await native.post("replace:" + bytes);
      const reads: number[] = [], writes: number[] = [];
      for (let i = 0; i < 20; i++) {
        let began = performance.now(); await native.adapter.get(); reads.push(performance.now() - began);
        began = performance.now(); await native.adapter.commitIntent({ path: "globalOn", value: i % 2 !== 0, updatedAt: 10 + i }); writes.push(performance.now() - began);
      }
      holder = spawn(binary, [directory, "hold"], { stdio: ["ignore", "pipe", "pipe"] });
      const exit = new Promise<void>((resolveExit, reject) => { holder!.once("exit", code => code === 0 ? resolveExit() : reject(new Error("holder failed"))); });
      await new Promise<void>(resolveHolding => holder!.stdout!.once("data", () => resolveHolding()));
      const began = performance.now(); await native.adapter.get(); const contention = performance.now() - began; await exit;
      expect(contention).toBeGreaterThan(100);
      expect((await native.adapter.get())!.atomic!.pending).toHaveLength(20);
      expect((await readdir(directory)).filter(name => name.endsWith(".tmp"))).toEqual([]);
      const p95 = (samples: number[]) => samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * .95) - 1];
      process.stdout.write("native-temporary-file-characterization " + JSON.stringify({ bytes: Buffer.byteLength(bytes), samples: 20,
        readP95Ms: p95(reads), commitP95Ms: p95(writes), liveHolderMs: contention, platform: process.platform }) + "\n");
    } finally {
      if (holder && holder.exitCode === null && holder.signalCode === null) { holder.kill("SIGKILL"); await new Promise(r => holder!.once("exit", r)); }
      await native.close();
    }
  });
  it("compiled native acknowledgement validates damaged and future local documents without losing bytes", async () => {
    const native = host(join(temporary, "native-damage"));
    try {
      await native.post("seed"); const initial = (await native.adapter.get())!;
      const linked = await native.adapter.enterScope(A);
      const envelope = { ...canonical(initial, 0), empty: true };
      for (const variant of ["future", "boolean", "missing", "legacy"] as const) {
        const corrupted = structuredClone(linked) as unknown as { settings: Record<string, unknown> };
        if (variant === "future") corrupted.settings.schemaVersion = 99;
        if (variant === "boolean") corrupted.settings.globalOn = 1;
        if (variant === "missing") delete corrupted.settings.globalOn;
        if (variant === "legacy") { delete corrupted.settings.schemaVersion; delete corrupted.settings.clocks; delete corrupted.settings.sites; }
        const bytes = JSON.stringify(corrupted); await native.post("replace:" + bytes);
        await expect(native.adapter.acknowledgeAtomic(envelope, linked.atomic!.scope)).rejects.toThrow();
        expect(await native.post({ kind: "get" })).toBe(bytes);
      }
    } finally { await native.close(); }
  });
  it("compiled native pre-anchor and pending-limit holds recover with original ranks", async () => {
    const native = host(join(temporary, "native-recovery"));
    try {
      await native.post("seed:never-linked"); const linked = await native.adapter.enterScope(A);
      await native.adapter.commitIntent({ path: "globalOn", value: false, updatedAt: 10 });
      await native.adapter.acknowledgeAtomic(canonical({ ...linked, settings: { ...linked.settings, globalOn: false } }, 1), linked.atomic!.scope);
      const resolved = await native.adapter.commitIntent({ path: "globalOn", value: true, updatedAt: 11 });
      expect(resolved.atomic).toMatchObject({ paused: null, held: {} });
      const before = structuredClone(resolved.atomic!.pending);
      for (let i = 0; i < 63; i++) await native.adapter.commitIntent({ path: "globalOn", value: i % 2 !== 0, updatedAt: 12 + i });
      const held = await native.adapter.commitIntent({ path: "globalOn", value: true, updatedAt: 90 });
      expect(held.atomic).toMatchObject({ paused: "pending-limit", held: { globalOn: true } });
      expect(held.atomic!.pending).toHaveLength(64); expect(held.atomic!.pending[0]).toEqual(before[0]);
      const pending = structuredClone(held.atomic!.pending);
      const ack = await native.adapter.acknowledgeAtomic(canonical(held, 2), linked.atomic!.scope);
      expect(ack.atomic!.pending).toEqual([]);
      expect(ack.atomic!.held).toEqual({ globalOn: true });
      const committed = await native.adapter.commitIntent({ path: "globalOn", value: false, updatedAt: 91 });
      expect(committed.atomic).toMatchObject({ paused: null, held: {} });
      expect(pending[0]).toEqual(before[0]);
    } finally { await native.close(); }
  });
  it("compiled native replacement adoption removes old overlays and cannot revive an old A generation", async () => {
    const native = host(join(temporary, "native-generation"));
    try {
      await native.post("seed"); const baseline = (await native.adapter.get())!;
      const cache = new SettingsCache(native.adapter, { now: () => 10 }); await cache.hydrate();
      await cache.setGlobalOn(false); const first = await cache.enterAtomicScope(A);
      await cache.acknowledgeAtomic({ ...canonical(baseline, 0), empty: true }, first);
      expect(cache.current().globalOn).toBe(false);
      await cache.enterAtomicScope(null);
      const sameA = await cache.enterAtomicScope(A); await cache.acknowledgeAtomic(canonical(baseline, 1), sameA);
      expect(cache.current().globalOn).toBe(true); expect(cache.currentRecord().atomic!.held).toEqual({});
      await cache.setGlobalOn(false);
      await cache.enterAtomicScope(null); const replacement = await cache.enterAtomicScope(B);
      await cache.acknowledgeAtomic(canonical(baseline, 1), replacement);
      expect(cache.current().globalOn).toBe(true); expect(cache.currentRecord().atomic!.held).toEqual({});
      await cache.enterAtomicScope(null); const scopeA = await cache.enterAtomicScope(A);
      await cache.acknowledgeAtomic(canonical(baseline, 1), scopeA);
      await cache.setGlobalOn(false); const original = structuredClone(cache.currentRecord().atomic!.pending);
      await cache.enterAtomicScope(null); await cache.enterAtomicScope(B); await cache.enterAtomicScope(null);
      const laterA = await cache.enterAtomicScope(A);
      await cache.acknowledgeAtomic(canonical(baseline, 1), laterA);
      expect(cache.current().globalOn).toBe(true);
      expect(cache.currentRecord().atomic!.pending).toEqual([]);
      expect(original.map(p => pendingSettingsRequest(p, cache.currentRecord().atomic!)).filter(Boolean)).toEqual([]);
    } finally { await native.close(); }
  });
  it("Safari popup/content startup rereads native authority after reversed direct replies", async () => {
    const { createAppGroupReconciler } = await import(resolve(import.meta.dirname, "../../../../ext-safari/lib/app-group-reconcile.ts")) as {
      createAppGroupReconciler(deps: {
        local: ChromeStorageAdapter; pullFromApp(): Promise<StoredSettingsRecord | null>; pushToApp(record: StoredSettingsRecord): Promise<void>;
      }): { reconcile(): Promise<void>; stop(): void };
    };
    const native = host(join(temporary, "safari-projection"));
    const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
    let saved: StoredSettingsRecord;
    let release!: () => void; let began!: () => void;
    const started = new Promise<void>(r => { began = r; });
    const delayed = new Promise<void>(r => { release = r; });
    let delayFirst = true; let unavailable = false;
    let delayRead = false; let readStarted = () => {}; let readGate = Promise.resolve();
    let releaseRead = () => {};
    const sendNative = vi.fn(async (_app: string, message: unknown) => {
      if (unavailable) throw new Error("native unavailable");
      const settings = await native.post(message);
      if ((message as { kind: string }).kind === "get" && delayRead) {
        delayRead = false; readStarted(); await readGate;
      }
      if ((message as { kind: string }).kind === "settingsIntent" && delayFirst) {
        delayFirst = false; began(); await delayed;
      }
      return { settings };
    });
    const origin = "safari-web-extension://synthetic/";
    const local = {
      async get(key: string) { return { [key]: saved }; },
      async set(values: Record<string, StoredSettingsRecord>) {
        const next = values["still:settings"]!; const old = saved; saved = structuredClone(next);
        for (const listener of listeners) listener({ "still:settings": { oldValue: old, newValue: next } }, "local");
      },
    };
    vi.stubGlobal("chrome", { storage: { local, onChanged: {
      addListener: (listener: typeof listeners extends Set<infer T> ? T : never) => listeners.add(listener),
      removeListener: (listener: typeof listeners extends Set<infer T> ? T : never) => listeners.delete(listener),
    } }, runtime: { getURL: () => origin, sendNativeMessage: sendNative,
      sendMessage: vi.fn(),
    } });
    vi.stubGlobal("location", { protocol: "safari-web-extension:" });
    let reconciler: ReturnType<typeof createAppGroupReconciler> | undefined;
    let stopContent: (() => void) | undefined;
    let contentScript: ContentScriptHandle | undefined;
    try {
      await native.post("seed"); saved = (await native.adapter.get())!;
      const background = new ChromeStorageAdapter({ authority: true, nativeMirror: true });
      const route = createSettingsIntentRouter(background.commitIntent.bind(background), "still", origin,
        background.set.bind(background), async () => {
          const reply = await sendNative("com.chartash.still", { kind: "get" });
          const record = parseStoredSettingsRecord(reply.settings); if (!record) throw new Error("unavailable"); return record;
        });
      // Runtime closure resolves this binding only after setup.
      Object.assign(chrome.runtime, { sendMessage: (message: unknown) => new Promise(resolveReply => route(message,
        { id: "still", url: "https://www.youtube.com/" }, resolveReply)) });
      reconciler = createAppGroupReconciler({ local: background,
        pullFromApp: () => native.adapter.get(), pushToApp: record => native.adapter.set(record) });
      const popup = new SettingsCache(new ChromeStorageAdapter(), { now: () => 10 }); await popup.hydrate();
      const first = popup.setGlobalOn(false); await started;
      const peer = new SettingsCache(native.adapter, { now: () => 11 }); await peer.hydrate(); await peer.setService("youtube", false);
      await reconciler.reconcile(); const latest = (await native.adapter.get())!;
      release(); await first;
      const canonicalBefore = await native.adapter.get();
      // A reboot ignores the auxiliary browser projection even if the obsolete direct reply wrote it.
      const reopened = new SettingsCache(new ChromeStorageAdapter()); await reopened.hydrate();
      expect(reopened.currentRecord().atomic!.sequence).toBe(latest.atomic!.sequence);
      expect(reopened.current().services.youtube).toBe(false);
      vi.stubGlobal("location", { protocol: "https:" });
      const content = new SettingsCache(new ChromeStorageAdapter()); await content.hydrate(); stopContent = content.watch();
      expect(content.currentRecord().atomic!.sequence).toBe(latest.atomic!.sequence);
      expect(content.current().services.youtube).toBe(false);
      const obsoleteReadStarted = new Promise<void>(r => { readStarted = r; });
      readGate = new Promise<void>(r => { releaseRead = r; }); delayRead = true;
      await local.set({ "still:settings": latest }); await obsoleteReadStarted;
      await native.adapter.enterScope(B); const current = (await native.adapter.get())!;
      await local.set({ "still:settings": current });
      await vi.waitFor(() => expect(content.currentRecord().atomic!.scope).toEqual(current.atomic!.scope));
      releaseRead();
      await local.set({ "still:settings": latest }); // stale account-generation projection is only a nudge
      await new Promise(r => setTimeout(r, 0));
      expect(content.currentRecord().atomic!.scope).toEqual(current.atomic!.scope);
      expect(await native.adapter.get()).toEqual(current);
      expect(canonicalBefore).toEqual(latest);
      // Use the actual shared constructor called by Safari's content/index entrypoint.
      const hydrate = SettingsCache.prototype.hydrate;
      const observeHydrate = vi.spyOn(SettingsCache.prototype, "hydrate").mockImplementation(function (this: SettingsCache) {
        return hydrate.call(this);
      });
      const entryCache = () => observeHydrate.mock.contexts.at(-1) as SettingsCache | undefined;
      const entry = createExtensionContentEntry({ storage: { get: async () => ({}) }, prod: false, earlyRedirect: false,
        win: { location: { href: "https://www.youtube.com/", replace: vi.fn() }, history: { pushState() {}, replaceState() {} },
          addEventListener() {}, removeEventListener() {}, MutationObserver: window.MutationObserver,
          requestAnimationFrame: window.requestAnimationFrame.bind(window) } as never,
        doc: document, onScriptCreated: script => { contentScript = script; } });
      await entry(); await vi.waitFor(() => expect(entryCache()?.currentRecord().atomic?.scope).toEqual(current.atomic!.scope));
      expect(entryCache()!.current().services.youtube).toBe(false);
      contentScript!.stop(); contentScript = undefined;
      unavailable = true;
      await entry(); await vi.waitFor(() => expect(entryCache()?.currentRecord().atomic?.paused).toBe("native-authority-unavailable"));
      expect(entryCache()!.current().globalOn).toBe(false);
      expect(document.documentElement.classList.contains("still-active")).toBe(false);
      contentScript!.stop(); contentScript = undefined;
      const heldStartup = new SettingsCache(new ChromeStorageAdapter());
      await heldStartup.hydrate();
      await expect(heldStartup.whenHydrated()).rejects.toThrow("native-authority-unavailable");
      expect(heldStartup.currentRecord().atomic!.paused).toBe("native-authority-unavailable");
      observeHydrate.mockRestore();
      expect(heldStartup.current().services.youtube).toBe(false); // retained local choice, not defaults
      await local.set({ "still:settings": latest }); await new Promise(r => setTimeout(r, 0));
      expect(content.currentRecord().atomic!.scope).toEqual(current.atomic!.scope);
    } finally {
      release(); releaseRead(); contentScript?.stop(); stopContent?.(); reconciler?.stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await native.close();
    }
    expect(listeners.size).toBe(0);
  });
  it("compiled native unknown/previous ownership preserves all-Off holds on empty account", async () => {
    for (const owner of ["unknown", "previous-account", "never-linked"] as const) {
      const native = host(join(temporary, `native-adoption-${owner}`));
      try {
        await native.post(`seed:${owner}`);
        const cache = new SettingsCache(native.adapter, { now: () => 10 }); await cache.hydrate();
        await cache.setGlobalOn(false);
        for (const id of ["youtube", "instagram", "facebook", "tiktok"] as const) await cache.setService(id, false);
        const scope = await cache.enterAtomicScope(A);
        // A new local choice while first account read is outstanding cannot erase the hold provenance.
        if (owner !== "never-linked") await cache.setGlobalOn(true);
        const defaults = authority(); const baseline = await defaults.writer.initialize("unknown");
        await cache.acknowledgeAtomic({ ...canonical(baseline, 0), empty: true }, scope);
        expect(cache.current().globalOn).toBe(owner !== "never-linked");
        expect(Object.values(cache.current().services).every(on => !on)).toBe(true);
        const saved = (await native.adapter.get())!;
        if (owner !== "never-linked") {
          expect(saved.atomic).toMatchObject({ paused: "ownership-hold", held: { "services.youtube": false } });
          expect(saved.atomic!.held.globalOn).toBeUndefined();
          expect(saved.settings.globalOn).toBe(true);
          expect(saved.atomic!.pending).toEqual([]);
          expect(saved.atomic!.pending.map(p => pendingSettingsRequest(p, saved.atomic!)).filter(Boolean)).toEqual([]);
        } else {
          expect(saved.atomic!.held).toEqual({});
          expect(saved.atomic!.pending.map(p => pendingSettingsRequest(p, saved.atomic!)).filter(Boolean)).toHaveLength(5);
        }
        const reopened = new SettingsCache(native.adapter); await reopened.hydrate();
        expect(reopened.current().globalOn).toBe(owner !== "never-linked");
      } finally { await native.close(); }
    }
  });
  it("actual native scope/anchor transaction keeps newer intent behind an older acknowledgement", async () => {
    const native = host(join(temporary, "native-ack"));
    try {
      await native.post("seed");
      const linked = await native.adapter.enterScope(A);
      await native.adapter.acknowledgeAtomic(canonical(linked, 1), linked.atomic!.scope);
      const sent = await native.adapter.commitIntent({ path: "globalOn", value: false, updatedAt: 10 });
      await native.adapter.commitIntent({ path: "globalOn", value: true, updatedAt: 11 });
      const resolved = await native.adapter.acknowledgeAtomic(canonical(sent, 2), sent.atomic!.scope);
      expect(resolved.settings.globalOn).toBe(true);
      expect(resolved.atomic!.pending).toHaveLength(1);
      expect(resolved.atomic!.pending[0]!.operations[0]).toMatchObject({ baseRevision: 1, localStep: 2, value: true });
      const next = await native.adapter.commitIntent({ path: "services.youtube", value: false, updatedAt: 12 });
      expect((next.settings as unknown as SettingsV2).clocks["services.youtube"]).toMatchObject({ baseRevision: 2, localStep: 1 });
      await native.adapter.enterScope(B); await native.adapter.enterScope(A);
      const before = await native.adapter.get();
      await native.adapter.acknowledgeAtomic(canonical(sent, 99), sent.atomic!.scope);
      expect(await native.adapter.get()).toEqual(before);
    } finally { await native.close(); }
  });
  it("killed replacement leaves prior bytes; OS releases lock and a peer removes orphan resources", async () => {
    const directory = join(temporary, "interrupted"); const first = host(directory); let interrupted: ReturnType<typeof host> | null = null;
    try {
      await first.post("seed"); const before = await first.adapter.get();
      interrupted = host(directory, true);
      expect(await interrupted.post({ kind: "settingsIntent", path: "globalOn", value: false, updatedAt: 10 })).toBe("paused");
      await interrupted.close();
      expect(await first.adapter.get()).toEqual(before);
      await first.adapter.commitIntent({ path: "services.youtube", value: false, updatedAt: 11 });
      expect((await first.adapter.get())!.settings.services.youtube).toBe(false);
      expect((await readdir(directory)).filter(name => name.endsWith(".tmp"))).toEqual([]);
    } finally { await first.close(); if (interrupted) await interrupted.close(); }
  });
});
