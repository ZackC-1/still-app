import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, MAX_SETTINGS_LOCAL_STEP, type SettingsV2 } from "@still/shared-types";
import { AtomicSettingsWriter } from "../atomic-settings.js";
import { type StoredSettingsRecord } from "../adapter.js";
import { SettingsCache } from "../cache.js";
import { parseStoredSettingsRecord } from "../settings-validation.js";
import { EntitlementCache } from "../../entitlement/cache.js";
import { initialAccessSnapshot } from "../../entitlement/access-policy.js";
import { createDesktopPopupBinding } from "../../ui/v3/desktop-popup-binding.js";
import { A, SESSION, authority, canonical } from "./atomic-settings-test-fixtures.js";

// The 196-edit soak drives every edit through the real popup binding, cache and writer, each of which
// revalidates the full atomic journal (up to 64 old requests). That is roughly 1-3s of pure CPU per case
// on an idle machine and several times that when the suite shares the CPU with other workers. The work is
// deterministic (no timers, no polling), so the default 5s wall-clock budget only measured machine load;
// this explicit budget remains a hang detector for that known workload.
const SOAK_BUDGET_MS = 60_000;

describe("retained unknown local-only authority", () => {
  it("adopts a nonempty account without uploading or promoting unknown local choices", async () => {
    const h = authority(); await h.writer.initialize("unknown");
    await h.writer.commit({ path: "globalOn", value: false, updatedAt: 200 });
    const entered = await h.writer.enterScope(A, SESSION);
    expect(entered.atomic).toMatchObject({ ownership: "previous-account", pending: [], paused: "ownership-unconfirmed" });
    const clean = authority(); const account = await clean.writer.initialize("unknown");
    const adopted = await h.writer.acknowledge(canonical(account, 1), entered.atomic!.scope);
    expect(adopted.settings.globalOn).toBe(true);
    expect(adopted.atomic).toMatchObject({ ownership: "previous-account", pending: [], held: {}, paused: null });
  });

  it.each(["sequence", "ordering"] as const)("refuses exhausted %s without rewriting unknown authority", async kind => {
    const h = authority(); const record = await h.writer.initialize("unknown");
    const modern = record.settings as unknown as SettingsV2;
    const current = { ...record, settings: { ...modern, pauses: [], clocks: { ...modern.clocks,
      globalOn: { baseRevision: 0, localStep: kind === "ordering" ? MAX_SETTINGS_LOCAL_STEP : 0 } } },
      atomic: { ...record.atomic!, sequence: kind === "sequence" ? Number.MAX_SAFE_INTEGER : 0 } };
    await h.storage.set(current); const write = vi.spyOn(h.storage, "set");
    await expect(h.writer.commit({ path: "globalOn", value: false, updatedAt: 200 })).rejects.toThrow(kind === "sequence" ? "sequence-saturated" : "ordering-hold");
    expect(write).not.toHaveBeenCalled(); expect(await h.storage.get()).toEqual(current);
  });

  it.each([0, 63, 64])("keeps 196 deliberate edits and reopened choices local with %i old requests", async count => {
    // A serialized JSON snapshot/reopen boundary: every read parses fresh bytes and every write replaces
    // them, exactly as a temp file would, without filesystem latency. Not a crash-atomicity claim.
    let snapshot: string | null = null;
    const savedBytes = () => snapshot;
    const storage = {
      get: async (): Promise<StoredSettingsRecord | null> => {
        if (snapshot === null) return null;
        const raw = JSON.parse(snapshot); return parseStoredSettingsRecord(raw) ? raw : null;
      },
      set: async (record: StoredSettingsRecord) => { snapshot = JSON.stringify(record); },
      subscribe: () => () => {},
    };
    const uuid = vi.fn(() => "dddddddd-dddd-dddd-dddd-dddddddddddd");
    const stops: (() => void)[] = [];
    const makeHost = async () => {
      const writer = new AtomicSettingsWriter(storage, uuid);
      const cache = new SettingsCache({ ...storage, commitIntent: writer.commit.bind(writer) }, { now: () => 500 });
      await cache.hydrate();
      const access = new EntitlementCache({ get: async () => false, set: async () => {}, subscribe: () => () => {},
        observeBenefits: async () => initialAccessSnapshot() });
      await access.refreshAccess();
      const binding = createDesktopPopupBinding(cache, access); stops.push(binding.stop);
      return { writer, cache, binding };
    };
    try {
      const legacySettings = { ...DEFAULT_SETTINGS, globalOn: false,
        services: { ...DEFAULT_SETTINGS.services, facebook: false, tiktok: false }, updatedAt: 21,
        futureChoice: { keep: false } };
      const legacy = { settings: legacySettings, syncEpoch: 3,
        syncMetadata: { version: 7, serverUpdatedAt: "2026-10-02T00:00:00Z", lastWriteId: A }, futureRoot: { keep: true } };
      await storage.set(legacy);
      const migrated = await new AtomicSettingsWriter(storage, uuid).initialize("unknown");
      const modern = migrated.settings as unknown as SettingsV2;
      const pending = Array.from({ length: count }, (_, i) => ({
        writeId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        scope: migrated.atomic!.scope, receipt: null,
        operations: [{ path: "globalOn" as const, value: i % 2 === 1, baseRevision: 0, localStep: i + 1 }],
      }));
      const initial = { ...migrated, settings: { ...modern, pauses: [], clocks: { ...modern.clocks,
        globalOn: { baseRevision: 0, localStep: count } } }, atomic: { ...migrated.atomic!, sequence: count, pending } };
      await storage.set(initial);
      const immutablePending = JSON.stringify(pending);
      let host = await makeHost(); let commits = 0;
      const steps = new Map<string, number>([["globalOn", count]]);
      const change = async (path: "globalOn" | "services.youtube" | "services.instagram" | "sites.youtube.shorts", value: boolean) => {
        const outcome = path === "globalOn" ? await host.binding.setGlobalOn(value)
          : path === "sites.youtube.shorts" ? await host.binding.setFeature("youtube.shorts", value)
          : await host.binding.setService(path === "services.youtube" ? "youtube" : "instagram", value);
        expect(outcome, `deliberate edit ${commits + 1}: ${path}`).toEqual({ status: "committed" });
        const record = (await storage.get())!; const settings = record.settings as unknown as SettingsV2;
        steps.set(path, (steps.get(path) ?? 0) + 1);
        expect(settings.clocks[path]).toMatchObject({ baseRevision: 0, localStep: steps.get(path) });
        expect(record.atomic).toMatchObject({ ownership: "unknown", scope: { accountId: null, generation: 0 },
          anchor: null, paused: null, held: {}, sequence: count + ++commits });
        expect(JSON.stringify(record.atomic!.pending)).toBe(immutablePending);
        expect(record).toMatchObject({ syncEpoch: 3, syncMetadata: legacy.syncMetadata, futureRoot: { keep: true },
          settings: { futureChoice: { keep: false }, services: { facebook: false, tiktok: false } } });
        expect(host.binding.current().commandAvailability).toBe("ready");
        expect(uuid).not.toHaveBeenCalled();
      };
      await change("globalOn", true);
      for (let round = 0; round < 24; round++) {
        await change("globalOn", false); await change("globalOn", true);
        await change("services.youtube", false); await change("services.youtube", true);
        await change("sites.youtube.shorts", false); await change("sites.youtube.shorts", true);
        await change("services.instagram", false); await change("services.instagram", true);
        if (round === 11) {
          const bytes = savedBytes(); host.binding.stop(); host = await makeHost();
          expect(savedBytes()).toBe(bytes);
          expect(host.binding.current().commandAvailability).toBe("ready");
        }
      }
      await change("sites.youtube.shorts", false); await change("services.youtube", false); await change("globalOn", false);
      expect(commits).toBe(196);
      const bytes = savedBytes(); host.binding.stop(); host = await makeHost();
      expect(host.cache.current()).toMatchObject({ globalOn: false, services: { youtube: false, facebook: false, tiktok: false }, sites: { "youtube.shorts": false } });
      expect(await host.binding.setGlobalOn(false)).toEqual({ status: "not-committed" });
      expect(savedBytes()).toBe(bytes); expect(uuid).not.toHaveBeenCalled();
      const entered = await host.writer.enterScope(A, SESSION);
      expect(entered.atomic).toMatchObject({ ownership: "previous-account", pending: [], paused: "ownership-unconfirmed" });
      const account = await authority().writer.initialize("unknown");
      const adopted = await host.writer.acknowledge({ ...canonical(account, 0), empty: true }, entered.atomic!.scope);
      expect(adopted.atomic!.pending).toEqual([]);
      expect(adopted.atomic!.held).toMatchObject({ globalOn: false, "services.youtube": false, "sites.youtube.shorts": false });
      expect(uuid).not.toHaveBeenCalled();
    } finally { for (const stop of stops) stop(); }
  }, SOAK_BUDGET_MS);

  it("saves only the deliberate held field and preserves unrelated overlays and opaque state", async () => {
    const h = authority(); const record = await h.writer.initialize("unknown");
    const initial = { ...record, atomic: { ...record.atomic!, held: { globalOn: false, "services.youtube": false }, futureState: { keep: true } } };
    await h.storage.set(initial);
    const saved = await h.writer.commit({ path: "globalOn", value: false, updatedAt: 200 });
    expect(saved.intentCommitted).toBe(true);
    expect(saved.settings.globalOn).toBe(false);
    expect(saved.atomic).toMatchObject({ ownership: "unknown", pending: [], held: { "services.youtube": false }, futureState: { keep: true } });
    expect(saved.atomic!.held).not.toHaveProperty("globalOn");
  });
});
