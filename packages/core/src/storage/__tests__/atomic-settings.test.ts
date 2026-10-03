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
import { createSettingsIntentRouter } from "../settings-messages.js";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const LINEAGE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
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
