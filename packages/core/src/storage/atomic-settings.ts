import {
  DEFAULT_SETTINGS, SETTINGS_FIELDS, readSettingsOperationRequest,
  type SettingsField, type SettingsV2, type UntrustedSettingsReceipt,
  type UntrustedSettingsFieldOperation, type UntrustedSettingsOperationRequest,
} from "@still/shared-types";
import type { StorageAdapter, StoredSettingsRecord, SyncedSettingsEnvelope } from "./adapter.js";
import { migrateSettingsV2 } from "./settings-v2.js";
import { allocateSettingsFieldEdit, mergeSettingsField, pendingSettingsFieldAfterAck } from "../sync/field-order.js";

export interface SettingsIntent { readonly path: SettingsField; readonly value: boolean; readonly updatedAt: number }
export interface SettingsScope { readonly accountId: string | null; readonly generation: number }
export interface PendingSettingsIntent {
  readonly writeId: string;
  readonly scope: SettingsScope;
  readonly receipt: UntrustedSettingsReceipt | null;
  readonly originScope?: SettingsScope;
  readonly operations: readonly UntrustedSettingsFieldOperation[];
}
export interface AtomicSettingsState {
  readonly format: 1;
  /** Durable local commit order, never server/field priority. */
  readonly sequence: number;
  readonly ownership: "never-linked" | "previous-account" | "unknown";
  readonly scope: SettingsScope;
  readonly anchor: UntrustedSettingsReceipt | null;
  readonly pending: readonly PendingSettingsIntent[];
  readonly held: Readonly<Partial<Record<SettingsField, boolean>>>;
  readonly paused: string | null;
}
export interface CanonicalSettingsEnvelope extends Omit<SyncedSettingsEnvelope, "serverUpdatedAt"> {
  readonly serverUpdatedAt: string | null;
  readonly empty: boolean;
  readonly protocol: 2;
  readonly lineage: string;
  readonly receipt: UntrustedSettingsReceipt;
}
export class SettingsStorageRecovery extends Error {
  constructor(readonly reason: string, readonly retained: StoredSettingsRecord | null = null) { super(`Settings storage requires recovery: ${reason}`); }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const shape = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function sameSettingsScope(a: SettingsScope, b: SettingsScope): boolean {
  return a.accountId === b.accountId && a.generation === b.generation;
}
function scope(v: unknown): v is SettingsScope {
  return shape(v) && (v.accountId === null || typeof v.accountId === "string" && UUID.test(v.accountId)) && integer(v.generation);
}
export function readSettingsReceipt(v: unknown): UntrustedSettingsReceipt | null {
  if (!shape(v)) return null;
  const result = readSettingsOperationRequest({ protocol: 2,
    writeId: "00000000-0000-0000-0000-000000000000", expectedLineage: v.lineage, receipt: v,
    operations: [{ path: "globalOn", value: false, baseRevision: 0, localStep: 1 }] });
  return result.status === "parsed" ? result.request.receipt : null;
}
export function readAtomicSettingsState(v: unknown): AtomicSettingsState | null {
  if (!shape(v) || v.format !== 1 || !integer(v.sequence) || !["never-linked", "previous-account", "unknown"].includes(String(v.ownership)) ||
    !scope(v.scope) || !Array.isArray(v.pending) || v.pending.length > 64 || !shape(v.held) ||
    !(v.paused === null || typeof v.paused === "string") || !(v.anchor === null || readSettingsReceipt(v.anchor))) return null;
  if (Object.entries(v.held).some(([path, value]) => !SETTINGS_FIELDS.includes(path as SettingsField) || typeof value !== "boolean")) return null;
  const ids = new Set<string>();
  for (const p of v.pending) {
    if (!shape(p) || p.originScope !== undefined && !scope(p.originScope) || !scope(p.scope) || typeof p.writeId !== "string" || !UUID.test(p.writeId) || ids.has(p.writeId) ||
      !(p.receipt === null || readSettingsReceipt(p.receipt))) return null;
    const result = readSettingsOperationRequest({ protocol: 2, writeId: p.writeId,
      expectedLineage: readSettingsReceipt(p.receipt)?.lineage ?? "00000000-0000-0000-0000-000000000000",
      receipt: p.receipt ?? { version: 1, lineage: "00000000-0000-0000-0000-000000000000", revision: 0, mac: "A".repeat(43) }, operations: p.operations });
    if (result.status !== "parsed") return null;
    ids.add(p.writeId);
  }
  return structuredClone(v) as unknown as AtomicSettingsState;
}
export function settingsFieldValue(settings: SettingsV2, path: SettingsField): boolean {
  if (path === "globalOn") return settings.globalOn;
  return (path.startsWith("services.") ? settings.services[path.slice(9)] : settings.sites[path.slice(6)]) as boolean;
}
function withField(settings: SettingsV2, path: SettingsField, value: boolean): SettingsV2 {
  if (path === "globalOn") return { ...settings, globalOn: value };
  const group = path.startsWith("services.") ? "services" : "sites";
  const key = path.slice(group.length + 1);
  return { ...settings, [group]: { ...settings[group], [key]: value } };
}
export function requireModernSettings(record: StoredSettingsRecord): SettingsV2 {
  const result = migrateSettingsV2(record.settings, { kind: "readable-local", provenInitialization: record.settings.updatedAt === 0 });
  if (result.status !== "ready") throw new SettingsStorageRecovery(result.reason);
  return result.settings;
}
function projection(settings: SettingsV2): StoredSettingsRecord["settings"] {
  return { ...settings, pauses: [] };
}
function resolvedPause(state: AtomicSettingsState, held: AtomicSettingsState["held"]): string | null {
  if (Object.keys(held).length === 0 && (state.scope.accountId === null || state.anchor !== null) &&
    ["awaiting-anchor", "ownership-hold", "pending-limit", "ordering-hold"].includes(state.paused ?? "")) return null;
  return state.paused;
}

/** One serialized writer around the EXISTING storage value. Hosts never allocate from a cache. */
export class AtomicSettingsWriter {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly adapter: StorageAdapter, private readonly uuid: () => string = () => crypto.randomUUID()) {}
  private transaction<T>(body: () => Promise<T>): Promise<T> {
    const run = this.tail.then(body, body);
    this.tail = run.catch(() => undefined);
    return run;
  }
  initialize(ownership: AtomicSettingsState["ownership"]): Promise<StoredSettingsRecord> {
    return this.transaction(async () => {
      const current = await this.adapter.get();
      if (!current) throw new SettingsStorageRecovery("missing-provenance");
      if (current.atomic) return current;
      const settings = requireModernSettings(current);
      const next: StoredSettingsRecord = { ...current, settings: projection(settings), atomic: {
        format: 1, sequence: 0, ownership, scope: { accountId: null, generation: 0 }, anchor: null, pending: [], held: {}, paused: null,
      } };
      await this.adapter.set(structuredClone(next));
      return next;
    });
  }
  commit(intent: SettingsIntent): Promise<StoredSettingsRecord> {
    return this.transaction(async () => {
      if (!SETTINGS_FIELDS.includes(intent.path) || typeof intent.value !== "boolean" || !integer(intent.updatedAt) || intent.updatedAt === 0)
        throw new TypeError("Invalid settings intent");
      const current = await this.adapter.get() ?? { settings: DEFAULT_SETTINGS, syncMetadata: null, syncEpoch: 0 };
      if (!current.atomic) {
        if ("schemaVersion" in current.settings) throw new SettingsStorageRecovery("missing-provenance");
        if (intent.path.startsWith("sites.")) throw new SettingsStorageRecovery("rollout-held");
        const prior = intent.path === "globalOn" ? current.settings.globalOn : current.settings.services[intent.path.slice(9) as keyof typeof current.settings.services];
        if (prior === intent.value) return { ...current, intentCommitted: false };
        const settings = intent.path === "globalOn" ? { ...current.settings, globalOn: intent.value, updatedAt: intent.updatedAt }
          : { ...current.settings, services: { ...current.settings.services, [intent.path.slice(9)]: intent.value }, updatedAt: intent.updatedAt };
        const next = { ...current, settings };
        await this.adapter.set(structuredClone(next));
        return { ...next, intentCommitted: true };
      }
      const state = current.atomic;
      if (state.sequence === Number.MAX_SAFE_INTEGER) throw new SettingsStorageRecovery("sequence-saturated");
      let settings = requireModernSettings(current);
      const priorValue = settingsFieldValue(settings, intent.path);
      if ((state.held[intent.path] ?? priorValue) === intent.value) return { ...current, intentCommitted: false };
      const edit = allocateSettingsFieldEdit({ value: priorValue, stamp: settings.clocks[intent.path] }, state.anchor?.revision ?? 0, intent.value);
      let atomic: AtomicSettingsState;
      if (edit.status === "edited" && state.pending.length < 64 && (state.scope.accountId === null || state.anchor !== null)) {
        settings = withField(settings, intent.path, intent.value);
        settings = { ...settings, clocks: { ...settings.clocks, [intent.path]: edit.field.stamp }, updatedAt: intent.updatedAt };
        const held = { ...state.held };
        delete held[intent.path];
        const writeId = this.uuid();
        if (state.pending.some(p => p.writeId === writeId)) throw new SettingsStorageRecovery("write-id-conflict");
        atomic = { ...state, sequence: state.sequence + 1, held, paused: resolvedPause(state, held), pending: [...state.pending, {
          writeId, scope: state.scope, receipt: state.anchor,
          operations: [{ path: intent.path, value: intent.value, baseRevision: edit.field.stamp.baseRevision, localStep: edit.field.stamp.localStep }],
        }] };
      } else if (edit.status === "unchanged") {
        const held = { ...state.held }; delete held[intent.path];
        atomic = { ...state, sequence: state.sequence + 1, held, paused: resolvedPause(state, held) };
      } else {
        let paused: string;
        if (state.paused === "ownership-unconfirmed") paused = state.paused;
        else if (state.pending.length >= 64) paused = "pending-limit";
        else if (state.scope.accountId !== null && state.anchor === null) paused = "awaiting-anchor";
        else paused = "ordering-hold";
        atomic = { ...state, sequence: state.sequence + 1, held: { ...state.held, [intent.path]: intent.value }, paused };
      }
      const next = { ...current, settings: projection(settings), atomic };
      await this.adapter.set(structuredClone(next));
      return { ...next, intentCommitted: true };
    });
  }
  enterScope(accountId: string | null): Promise<StoredSettingsRecord> {
    return this.transaction(async () => {
      const current = await this.adapter.get();
      if (!current?.atomic || !(accountId === null || UUID.test(accountId))) throw new SettingsStorageRecovery("missing-provenance");
      const state = current.atomic;
      if (state.scope.generation === Number.MAX_SAFE_INTEGER || state.sequence === Number.MAX_SAFE_INTEGER || current.syncEpoch === Number.MAX_SAFE_INTEGER) throw new SettingsStorageRecovery("epoch-saturated");
      const next = { ...current, syncEpoch: (current.syncEpoch ?? 0) + 1, atomic: { ...state, sequence: state.sequence + 1,
        ownership: state.scope.accountId !== null || accountId !== null ? "previous-account" as const : state.ownership,
        scope: { accountId, generation: state.scope.generation + 1 }, anchor: null,
        // Prior operations remain durable provenance but cannot upload into a replacement scope.
        pending: state.ownership === "never-linked" && state.scope.accountId === null && accountId !== null
          ? state.pending.map(p => ({ ...p, originScope: p.scope, scope: { accountId, generation: state.scope.generation + 1 } }))
          : state.pending, paused: accountId !== null && state.ownership !== "never-linked" ? "ownership-unconfirmed" : state.paused,
      } };
      await this.adapter.set(structuredClone(next));
      return next;
    });
  }
  acknowledge(envelope: CanonicalSettingsEnvelope, captured: SettingsScope): Promise<StoredSettingsRecord> {
    return this.transaction(async () => {
      const current = await this.adapter.get();
      if (!current?.atomic) throw new SettingsStorageRecovery("missing-provenance");
      const state = current.atomic;
      if (!sameSettingsScope(captured, state.scope)) return current;
      if (state.sequence === Number.MAX_SAFE_INTEGER) throw new SettingsStorageRecovery("sequence-saturated");
      const receipt = readSettingsReceipt(envelope.receipt);
      if (!receipt || receipt.lineage !== envelope.lineage || receipt.revision !== envelope.version ||
        (state.anchor && (state.anchor.lineage !== envelope.lineage || receipt.revision < state.anchor.revision))) throw new SettingsStorageRecovery("invalid-anchor");
      const migrated = migrateSettingsV2(envelope.settings, { kind: "acknowledged-account", revision: receipt.revision, provenInitialization: envelope.empty });
      if (migrated.status !== "ready" || SETTINGS_FIELDS.some(path => migrated.settings.clocks[path].baseRevision > receipt.revision))
        throw new SettingsStorageRecovery("invalid-canonical-settings");
      const canonical = migrated.settings;
      let settings = requireModernSettings(current);
      settings = { ...settings, ...canonical, services: { ...settings.services, ...canonical.services },
        sites: { ...settings.sites, ...canonical.sites }, clocks: { ...settings.clocks, ...canonical.clocks } };
      const clocks = { ...settings.clocks };
      const original = requireModernSettings(current);
      for (const path of SETTINGS_FIELDS) clocks[path] = { ...original.clocks[path], ...canonical.clocks[path] };
      for (const p of state.pending) {
        if (!sameSettingsScope(p.scope, captured)) continue;
        for (const op of p.operations) {
          const winner = mergeSettingsField({ value: settingsFieldValue(settings, op.path), stamp: clocks[op.path] },
            { value: op.value, stamp: { ...clocks[op.path], baseRevision: op.baseRevision, localStep: op.localStep } });
          settings = withField(settings, op.path, winner.value);
          clocks[op.path] = winner.stamp;
        }
      }
      settings = { ...settings, clocks };
      const pending = state.pending.filter((p) => !sameSettingsScope(p.scope, captured) || p.operations.some((op) => {
        const remote = { value: settingsFieldValue(canonical, op.path), stamp: canonical.clocks[op.path] };
        const local = { value: op.value, stamp: { baseRevision: op.baseRevision, localStep: op.localStep } };
        return pendingSettingsFieldAfterAck(local, remote) !== null;
      }));
      const bound = pending.map(p => sameSettingsScope(p.scope, captured) && p.receipt === null && p.originScope?.accountId === null
        ? { ...p, receipt } : p);
      const held = { ...state.held };
      let paused = state.paused;
      if (paused === "ownership-unconfirmed") {
        // Empty-account defaults are account authority, not permission to discard unowned local
        // choices or rebase their immutable operations into this account.
        if (envelope.empty) for (const path of SETTINGS_FIELDS) {
          const local = held[path] ?? settingsFieldValue(original, path);
          if (local !== settingsFieldValue(settings, path)) held[path] = local;
          else delete held[path];
        }
        else for (const path of SETTINGS_FIELDS) delete held[path];
        paused = Object.keys(held).length > 0 ? "ownership-hold" : null;
      } else if (["awaiting-anchor", "pending-limit", "ownership-hold"].includes(paused ?? "")) {
        for (const path of SETTINGS_FIELDS) if (held[path] === settingsFieldValue(settings, path)) delete held[path];
        paused = resolvedPause({ ...state, anchor: receipt }, held);
      }
      const next: StoredSettingsRecord = { ...current, settings: projection(settings), syncMetadata: envelope.serverUpdatedAt === null ? null : {
        version: envelope.version, serverUpdatedAt: envelope.serverUpdatedAt, lastWriteId: envelope.lastWriteId,
      }, atomic: { ...state, sequence: state.sequence + 1, anchor: receipt, pending: bound, held, paused } };
      await this.adapter.set(structuredClone(next));
      return next;
    });
  }
  mirror(record: StoredSettingsRecord): Promise<StoredSettingsRecord> {
    return this.transaction(async () => {
      const current = await this.adapter.get();
      if (current?.atomic) {
        if (!record.atomic || record.atomic.scope.generation < current.atomic.scope.generation ||
          record.atomic.scope.generation === current.atomic.scope.generation && record.atomic.sequence < current.atomic.sequence) return current;
      }
      await this.adapter.set(structuredClone(record));
      return record;
    });
  }
  replace(record: StoredSettingsRecord): Promise<StoredSettingsRecord> {
    return this.transaction(async () => {
      const current = await this.adapter.get();
      if (current?.atomic || current && "schemaVersion" in current.settings && current.settings.schemaVersion !== 1) return current; // full snapshots never stamp or drop modern intent
      if (current && (record.syncEpoch ?? 0) < (current.syncEpoch ?? 0)) return current;
      if (current && (record.syncEpoch ?? 0) === (current.syncEpoch ?? 0)) {
        if (current.syncMetadata && !record.syncMetadata) return current;
        if (current.syncMetadata && record.syncMetadata && record.syncMetadata.version < current.syncMetadata.version) return current;
        if ((record.syncMetadata?.version ?? 0) === (current.syncMetadata?.version ?? 0) && record.settings.updatedAt < current.settings.updatedAt) return current;
      }
      const next = { ...current, ...record, settings: { ...current?.settings, ...record.settings, services: { ...current?.settings.services, ...record.settings.services } } };
      await this.adapter.set(structuredClone(next));
      return next;
    });
  }
}

/** Retry constructs exactly the saved body. Receipt/rank is never rebased on receiving time. */
export function pendingSettingsRequest(pending: PendingSettingsIntent, state: AtomicSettingsState): UntrustedSettingsOperationRequest | null {
  if (!sameSettingsScope(pending.scope, state.scope) || !pending.receipt) return null;
  const parsed = readSettingsOperationRequest({ protocol: 2, writeId: pending.writeId, expectedLineage: pending.receipt.lineage,
    receipt: pending.receipt, operations: pending.operations });
  return parsed.status === "parsed" ? parsed.request : null;
}
