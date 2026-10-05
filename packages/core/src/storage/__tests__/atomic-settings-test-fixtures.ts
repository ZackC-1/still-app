import { DEFAULT_SETTINGS } from "@still/shared-types";
import { AtomicSettingsWriter, type CanonicalSettingsEnvelope } from "../atomic-settings.js";
import { InMemoryStorageAdapter, type StoredSettingsRecord } from "../adapter.js";

export const A = "11111111-1111-1111-1111-111111111111";

export const B = "22222222-2222-2222-2222-222222222222";

export const LINEAGE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

export const SESSION = "cccccccc-cccc-cccc-cccc-cccccccccccc";

export function authority() {
  const storage = new InMemoryStorageAdapter({ ...DEFAULT_SETTINGS, updatedAt: 1 });
  const writer = new AtomicSettingsWriter(storage);
  const port = { get: () => storage.get(), set: (r: StoredSettingsRecord) => writer.replace(r).then(() => undefined),
    subscribe: storage.subscribe.bind(storage), commitIntent: writer.commit.bind(writer), initializeAtomic: writer.initialize.bind(writer),
    enterScope: writer.enterScope.bind(writer), acknowledgeAtomic: writer.acknowledge.bind(writer) };
  return { storage, writer, port };
}

export function canonical(record: StoredSettingsRecord, revision: number): CanonicalSettingsEnvelope {
  return { protocol: 2, empty: false, settings: record.settings, version: revision,
    serverUpdatedAt: "2026-10-02T00:00:00Z", lastWriteId: null, lineage: LINEAGE,
    receipt: { version: 1, lineage: LINEAGE, revision, mac: "A".repeat(43) } };
}
