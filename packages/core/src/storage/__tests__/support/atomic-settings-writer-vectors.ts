// Shared TS/Swift atomic settings writer vectors (U3-W4 P1). The reviewed TypeScript
// AtomicSettingsWriter is the reference: every case below is replayed through it to produce the
// checked-in fixture, and StillKit replays the same fixture (AtomicSettingsWriterVectorTests.swift
// and the compiled-host test in atomic-settings.test.ts) and must reach the same records.
import { createHash } from "node:crypto";
import { DEFAULT_SETTINGS, MAX_SETTINGS_LOCAL_STEP, type SettingsField, type SettingsV2 } from "@still/shared-types";
import { AtomicSettingsWriter, type CanonicalSettingsEnvelope, type PendingSettingsIntent, type SettingsScope } from "../../atomic-settings.js";
import { InMemoryStorageAdapter, type StoredSettingsRecord } from "../../adapter.js";
import { A, B, LINEAGE, SESSION, canonical } from "../atomic-settings-test-fixtures.js";

export const VECTORS_FILE = "packages/shared-types/fixtures/atomic-settings-writer-vectors.json";

export type ParityRule = "compaction" | "queued-updatedAt" | "pauses-projection" | "scope-members" | "saturation-order" | "legacy-commit" | "baseline";
export type AtomicCommand =
  | { readonly action: "initialize"; readonly ownership: "never-linked" | "previous-account" | "unknown" }
  | { readonly action: "scope"; readonly accountId: string | null; readonly sessionId?: string }
  | { readonly action: "acknowledge"; readonly envelope: CanonicalSettingsEnvelope; readonly scope: SettingsScope };
export type ParityCommand =
  | { readonly kind: "commit"; readonly path: SettingsField; readonly value: boolean; readonly updatedAt: number }
  | { readonly kind: "atomic"; readonly command: AtomicCommand };
/** Diagnostic only; `digest` is the exact comparison. */
export interface ParitySummary {
  readonly syncEpoch: number | null; readonly updatedAt: number; readonly sequence: number | null;
  readonly paused: string | null; readonly held: Record<string, boolean> | null;
  readonly pendingCount: number | null; readonly newestPending: string | null;
}
export interface ParityStep {
  readonly command: ParityCommand;
  readonly outcome: "applied" | "refused";
  /** Commit steps only: the reference writer's `intentCommitted`. */
  readonly changed?: boolean;
  readonly summary: ParitySummary | null;
  /** SHA-256 (hex) of canonicalJson(complete stored record) after the step; "null" hashes absence. */
  readonly digest: string;
  /** The complete stored record, kept for the final step of each case. */
  readonly record?: StoredSettingsRecord | null;
}
export interface ParityCase {
  readonly name: string; readonly rule: ParityRule; readonly about: string;
  readonly initial: StoredSettingsRecord | null;
  /** Identities the reference writer allocated, in order; replay hosts hand out the same ones. */
  readonly writeIds: readonly string[];
  readonly steps: readonly ParityStep[];
}
export interface ParityVectors { readonly about: readonly string[]; readonly cases: readonly ParityCase[] }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const setupId = (i: number) => `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`;
const caseId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const T = "2026-10-02T00:00:00Z";

export function summary(record: StoredSettingsRecord | null): ParitySummary | null {
  if (!record) return null;
  return { syncEpoch: record.syncEpoch ?? null, updatedAt: record.settings.updatedAt, sequence: record.atomic?.sequence ?? null,
    paused: record.atomic ? record.atomic.paused : null, held: record.atomic ? { ...record.atomic.held } as Record<string, boolean> : null,
    pendingCount: record.atomic ? record.atomic.pending.length : null, newestPending: record.atomic?.pending.at(-1)?.writeId ?? null };
}
/** Key-sorted (UTF-16 order), whitespace-free JSON. StillKit computes the same text independently. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
export const digest = (record: unknown) => createHash("sha256").update(canonicalJson(record)).digest("hex");

async function build(initial: StoredSettingsRecord | null, body: (writer: AtomicSettingsWriter) => Promise<unknown>): Promise<StoredSettingsRecord> {
  const storage = new InMemoryStorageAdapter(initial ? clone(initial) : null);
  let n = 0; const writer = new AtomicSettingsWriter(storage, () => setupId(++n));
  await body(writer);
  return clone((await storage.get())!);
}
const legacy = (updatedAt: number): StoredSettingsRecord => ({ settings: { ...DEFAULT_SETTINGS, updatedAt }, syncMetadata: null, syncEpoch: 0 });
const fresh = () => build(null, w => w.initializeFresh(async () => true));
const defaults = () => build(legacy(1), w => w.initialize("unknown"));
const anchored = () => build(legacy(1), async w => {
  await w.initialize("unknown"); const linked = await w.enterScope(A, SESSION);
  await w.acknowledge(canonical(linked, 1), linked.atomic!.scope);
});
const v2 = (record: StoredSettingsRecord) => record.settings as unknown as SettingsV2 & { pauses?: unknown };
const withSettings = (record: StoredSettingsRecord, settings: object): StoredSettingsRecord =>
  ({ ...record, settings: settings as StoredSettingsRecord["settings"] });

const commit = (path: SettingsField, value: boolean, updatedAt: number): ParityCommand => ({ kind: "commit", path, value, updatedAt });
const atomic = (command: AtomicCommand): ParityCommand => ({ kind: "atomic", command });
const scope = (accountId: string | null, sessionId?: string) => atomic({ action: "scope", accountId, ...(sessionId ? { sessionId } : {}) });
const ack = (envelope: CanonicalSettingsEnvelope, captured: SettingsScope) => atomic({ action: "acknowledge", envelope, scope: captured });
const emptyAccount = (baseline: StoredSettingsRecord): CanonicalSettingsEnvelope =>
  ({ ...canonical(baseline, 0), empty: true, serverUpdatedAt: null });
const OTHER_LINEAGE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
/** An account other than A: its own lineage, so nothing can be confused with A's receipt. */
const otherAccount = (envelope: CanonicalSettingsEnvelope): CanonicalSettingsEnvelope =>
  ({ ...envelope, lineage: OTHER_LINEAGE, receipt: { ...envelope.receipt, lineage: OTHER_LINEAGE } });
/** A step is either a fixed command or one derived from the reference record at that point. */
type StepSource = ParityCommand | ((current: StoredSettingsRecord | null, history: readonly (StoredSettingsRecord | null)[]) => ParityCommand);
interface CaseSource { name: string; rule: ParityRule; about: string; initial: StoredSettingsRecord | null; steps: StepSource[] }

const alternating = (count: number, start = 1_000): StepSource[] =>
  Array.from({ length: count }, (_, i) => commit("globalOn", i % 2 === 1, start + i));

/** A crafted full never-linked journal: 64 unsubmitted globalOn requests at increasing local steps. */
function fullJournal(base: StoredSettingsRecord): StoredSettingsRecord {
  const pending: PendingSettingsIntent[] = Array.from({ length: 64 }, (_, i) => ({ writeId: setupId(100 + i), scope: base.atomic!.scope,
    receipt: null, operations: [{ path: "globalOn", value: i % 2 === 1, baseRevision: 0, localStep: i + 1 }] }));
  return { ...withSettings(base, { ...v2(base), globalOn: true, updatedAt: 64, clocks: { ...v2(base).clocks, globalOn: { baseRevision: 0, localStep: 64 } } }),
    atomic: { ...base.atomic!, sequence: 64, pending } };
}

async function sources(): Promise<CaseSource[]> {
  const freshRecord = await fresh(); const baseline = await defaults(); const linked = await anchored();
  const linkedScope = linked.atomic!.scope;
  const { syncEpoch: _epoch, ...epochAbsent } = freshRecord;
  const journal = fullJournal(freshRecord);
  const winner: PendingSettingsIntent = { ...journal.atomic!.pending[63]!, operations: [...journal.atomic!.pending[63]!.operations,
    { path: "services.youtube", value: false, baseRevision: 0, localStep: 1 }] };
  const tie: PendingSettingsIntent = { ...journal.atomic!.pending[62]!, operations: [{ ...journal.atomic!.pending[63]!.operations[0]!, value: false }] };
  const ranked: StoredSettingsRecord = { ...withSettings(journal, { ...v2(journal), services: { ...v2(journal).services, youtube: false },
    clocks: { ...v2(journal).clocks, "services.youtube": { baseRevision: 0, localStep: 1 } } }),
    atomic: { ...journal.atomic!, pending: [winner, tie, ...journal.atomic!.pending.slice(0, 62).reverse()] } };
  const saturated = withSettings(linked, { ...v2(linked), clocks: { ...v2(linked).clocks, globalOn: { baseRevision: 1, localStep: MAX_SETTINGS_LOCAL_STEP } } });
  const retiredPauses = withSettings(linked, { ...v2(linked), pauses: ["legacy-pause"] });
  const { pauses: _pauses, ...pauseless } = v2(linked);
  const memberScope = { ...linkedScope, region: "future-member" } as SettingsScope;
  const extraMember: StoredSettingsRecord = { ...withSettings(linked, { ...v2(linked), globalOn: false, clocks: { ...v2(linked).clocks, globalOn: { baseRevision: 1, localStep: 1 } } }),
    atomic: { ...linked.atomic!, sequence: linked.atomic!.sequence + 1, pending: [{ writeId: setupId(900), scope: memberScope, receipt: linked.atomic!.anchor,
      operations: [{ path: "globalOn", value: false, baseRevision: 1, localStep: 1 }] }] } };
  const sequenceBound: StoredSettingsRecord = { ...linked, atomic: { ...linked.atomic!, sequence: Number.MAX_SAFE_INTEGER } };
  const generationBound: StoredSettingsRecord = { ...linked, atomic: { ...linked.atomic!, scope: { ...linkedScope, generation: Number.MAX_SAFE_INTEGER } } };
  const pendingAt = (current: StoredSettingsRecord | null) => current!.atomic!.scope;
  // What an earlier build saved after VD-15: old choices held over the new account's defaults.
  const stuck: StoredSettingsRecord = { ...linked, atomic: { ...linked.atomic!, sequence: linked.atomic!.sequence + 1,
    ownership: "previous-account", paused: "ownership-hold", held: { "services.instagram": false } } };
  const stuckSignedOut: StoredSettingsRecord = { ...stuck, atomic: { ...stuck.atomic!, anchor: null,
    scope: { accountId: null, generation: linkedScope.generation + 1 } } };

  return [
    { name: "compaction/never-linked-journal-stays-bounded", rule: "compaction", initial: freshRecord,
      about: "A never-linked account-free journal keeps only the newest request per field, so 72 deliberate edits never reach the 64-request pause.",
      steps: Array.from({ length: 72 }, (_, i) => commit((["globalOn", "services.youtube", "sites.youtube.shorts"] as const)[i % 3]!, Math.floor(i / 3) % 2 === 1, 1_000 + i)) },
    { name: "compaction/full-journal-admits-the-next-edit", rule: "compaction", initial: journal,
      about: "A persisted full never-linked journal (64 requests) compacts on the next edit instead of pausing.",
      steps: [commit("services.instagram", false, 100), commit("globalOn", false, 101), commit("services.instagram", true, 102)] },
    { name: "compaction/rank-ties-and-multi-field-bodies-survive", rule: "compaction", initial: ranked,
      about: "Compaction ranks by (baseRevision, localStep), not array position, keeps every exact-rank tie and never rewrites a multi-field request.",
      steps: [commit("services.instagram", false, 100)] },
    { name: "compaction/epoch-absent-journal-stays-immutable", rule: "compaction", initial: epochAbsent as StoredSettingsRecord,
      about: "Without proof of a never-repointed record (syncEpoch absent) the journal is immutable and the 65th edit is held with pending-limit.",
      steps: alternating(65) },
    { name: "compaction/first-link-transfers-the-compacted-journal", rule: "compaction", initial: freshRecord,
      about: "The compacted never-linked journal transfers at first link with original identities and binds the first receipt.",
      steps: [...alternating(6), commit("services.youtube", false, 2_000), scope(A, SESSION),
        current => ack(canonical(baseline, 0), pendingAt(current)), current => ack(canonical(current!, 1), pendingAt(current))] },

    { name: "queued-updatedAt/ordering-hold-and-unchanged-keep-the-stamp", rule: "queued-updatedAt", initial: saturated,
      about: "A held choice (step-saturated ordering hold) and an unchanged answer that clears it never restamp settings.updatedAt; only an allocated edit does.",
      steps: [commit("globalOn", false, 500), commit("globalOn", true, 600), commit("services.youtube", false, 700), commit("services.youtube", false, 800)] },
    { name: "queued-updatedAt/awaiting-anchor-hold-keeps-the-stamp", rule: "queued-updatedAt", initial: freshRecord,
      about: "A first-linked record without an anchor holds new choices (awaiting-anchor) without restamping, then acknowledgement clears them.",
      steps: [scope(A, SESSION), commit("globalOn", false, 500), commit("sites.youtube.shorts", false, 501),
        current => ack(canonical(baseline, 1), pendingAt(current)), commit("globalOn", false, 700)] },
    { name: "queued-updatedAt/ownership-pause-keeps-the-stamp", rule: "queued-updatedAt", initial: baseline,
      about: "An unconfirmed previous-ownership record holds choices without restamping; an empty account then wins with its agreed defaults and nothing stays held.",
      steps: [commit("globalOn", false, 400), scope(A, SESSION), commit("services.youtube", false, 500),
        current => ack(emptyAccount(baseline), pendingAt(current)), commit("services.youtube", true, 600), commit("globalOn", true, 700)] },
    { name: "queued-updatedAt/pending-limit-keeps-the-stamp", rule: "queued-updatedAt", initial: linked,
      about: "At 64 account-bound requests the next choice is held with pending-limit and settings.updatedAt stays at the last allocated edit.",
      steps: [...alternating(66), current => ack(canonical(current!, 2), pendingAt(current))] },

    { name: "pauses-projection/queued-commit-normalizes-retired-pauses", rule: "pauses-projection", initial: retiredPauses,
      about: "Every write projects the retired legacy pauses list as empty, as the TypeScript writer's projection does.",
      steps: [commit("services.youtube", false, 500)] },
    { name: "pauses-projection/queued-commit-adds-the-empty-pauses-list", rule: "pauses-projection", initial: withSettings(linked, pauseless),
      about: "A modern record saved without a pauses member gains the empty legacy projection on the next write.",
      steps: [commit("globalOn", false, 500)] },
    { name: "pauses-projection/acknowledgement-normalizes-retired-pauses", rule: "pauses-projection", initial: retiredPauses,
      about: "Acknowledgement writes the same empty pauses projection.",
      steps: [ack(canonical(linked, 2), linkedScope)] },

    { name: "scope-members/pending-scope-identity-is-member-wise", rule: "scope-members", initial: extraMember,
      about: "Request scope identity is (accountId, generation, sessionId); an unknown extra member does not retire a current request.",
      steps: [commit("services.youtube", false, 500)] },
    { name: "scope-members/acknowledged-scope-identity-is-member-wise", rule: "scope-members", initial: extraMember,
      about: "An acknowledgement whose captured scope carries an unknown extra member still applies to the same scope.",
      steps: [ack(canonical(extraMember, 2), memberScope)] },

    { name: "saturation-order/no-op-answers-precede-the-sequence-bound", rule: "saturation-order", initial: sequenceBound,
      about: "At the sequence bound, the same verified session and a stale-scope acknowledgement are no-ops; real changes are refused untouched.",
      steps: [scope(A, SESSION), ack(canonical(linked, 2), { ...linkedScope, generation: linkedScope.generation - 1 }), scope(B),
        ack(canonical(linked, 2), linkedScope), commit("globalOn", false, 500)] },
    { name: "saturation-order/same-session-precedes-the-generation-bound", rule: "saturation-order", initial: generationBound,
      about: "At the generation bound the same verified session is a no-op, while entering another account is refused untouched.",
      steps: [scope(A, SESSION), scope(B), scope(null)] },

    { name: "legacy-commit/absent-record-saves-a-never-repointed-record", rule: "legacy-commit", initial: null,
      about: "A choice on an absent record saves the defaults with that choice, no sync metadata and syncEpoch 0, then converts identically.",
      steps: [commit("globalOn", false, 10), commit("services.youtube", false, 20), commit("sites.youtube.shorts", false, 30),
        atomic({ action: "initialize", ownership: "unknown" }), commit("globalOn", true, 40)] },
    { name: "legacy-commit/no-op-on-absent-record-writes-nothing", rule: "legacy-commit", initial: null,
      about: "Choices that match the startup defaults on an absent record write nothing, so defaults never become a saved record; the first real change does.",
      steps: [commit("globalOn", true, 10), commit("services.youtube", true, 11), commit("sites.youtube.shorts", true, 12), commit("globalOn", false, 13)] },
    { name: "legacy-commit/stamps-never-move-backward", rule: "legacy-commit", initial: legacy(5_000),
      about: "A legacy choice is stamped after the saved updatedAt even when the device clock is behind it.",
      steps: [commit("services.youtube", false, 10), commit("services.youtube", true, 10), commit("globalOn", false, 9_000),
        commit("globalOn", false, 1), atomic({ action: "initialize", ownership: "unknown" })] },

    { name: "baseline/acknowledgement-keeps-newer-local-intent", rule: "baseline", initial: linked,
      about: "An acknowledgement of an older request keeps the newer queued intent and its rank.",
      steps: [commit("globalOn", false, 10), commit("globalOn", true, 11), (_c, history) => ack(canonical(history[0]!, 2), linkedScope),
        commit("services.youtube", false, 12), scope(B), scope(A, SESSION), (_c, history) => ack(canonical(history[0]!, 99), linkedScope)] },
    { name: "baseline/account-switch-retires-pending-and-adopts-the-account", rule: "baseline", initial: linked,
      about: "Switching accounts retires queued requests, pauses ownership-unconfirmed and adopts a non-empty account.",
      steps: [commit("globalOn", false, 10), commit("services.facebook", false, 11), scope(B),
        current => ack({ ...canonical(baseline, 3), lineage: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          receipt: { version: 1, lineage: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", revision: 3, mac: "A".repeat(43) } }, pendingAt(current)),
        commit("services.facebook", false, 12), scope(null)] },
    { name: "baseline/previous-account-into-empty-account-seeds-defaults", rule: "baseline", initial: linked,
      about: "VD-15: A's choice, sign-out, a signed-out choice, then a new empty account B: B wins with its agreed defaults, nothing earlier is queued or held, and B's own next choice is bound to B's receipt.",
      steps: [commit("services.instagram", false, 10), scope(null), commit("services.facebook", false, 11), scope(B, SESSION),
        current => ack(otherAccount(emptyAccount(baseline)), pendingAt(current)), commit("services.youtube", false, 12)] },
    { name: "baseline/a-b-a-returns-to-the-account", rule: "baseline", initial: linked,
      about: "A to empty B to A: each account wins on entry; A's row is adopted on return and B's queued choice never follows into A.",
      steps: [commit("services.instagram", false, 10), scope(null), scope(B, SESSION),
        current => ack(otherAccount(emptyAccount(baseline)), pendingAt(current)), commit("services.youtube", false, 12),
        scope(null), scope(A, SESSION), current => ack(canonical(withSettings(baseline, { ...v2(baseline), services: { ...v2(baseline).services, instagram: false },
          clocks: { ...v2(baseline).clocks, "services.instagram": { baseRevision: 1, localStep: 1 } } }), 2), pendingAt(current))] },
    { name: "baseline/stored-ownership-hold-resolves-on-the-next-read", rule: "baseline", initial: stuck,
      about: "A stored ownership-hold (earlier build) resolves on the account's next read: the account wins, the overlay is gone, commands commit.",
      steps: [ack(canonical(linked, 1), linkedScope), commit("services.instagram", false, 20)] },
    { name: "baseline/sign-out-releases-an-ownership-hold", rule: "baseline", initial: stuck,
      about: "Sign-out releases an ownership hold back to local-only control: saved settings stay, the overlay and pause go.",
      steps: [scope(null), commit("services.instagram", false, 20)] },
    { name: "baseline/wake-releases-a-signed-out-ownership-hold", rule: "baseline", initial: stuckSignedOut,
      about: "A signed-out record an earlier build left paused is released by the next wake's initialize; a second wake writes nothing.",
      steps: [atomic({ action: "initialize", ownership: "unknown" }), atomic({ action: "initialize", ownership: "unknown" }), commit("services.instagram", false, 20)] },
    { name: "baseline/never-linked-empty-account-first-link", rule: "baseline", initial: freshRecord,
      about: "A never-linked first link into an empty account carries the local choices as bound requests.",
      steps: [commit("globalOn", false, 10), commit("services.instagram", false, 11), scope(A, SESSION),
        current => ack(emptyAccount(baseline), pendingAt(current)), commit("sites.youtube.shorts", false, 12)] },
  ];
}

/** Runs one case through the reference TypeScript writer. */
async function generate(source: CaseSource): Promise<ParityCase> {
  const storage = new InMemoryStorageAdapter(source.initial ? clone(source.initial) : null);
  const writeIds: string[] = [];
  const writer = new AtomicSettingsWriter(storage, () => { const id = caseId(writeIds.length + 1); writeIds.push(id); return id; });
  const history: (StoredSettingsRecord | null)[] = []; const steps: ParityStep[] = [];
  for (const [index, entry] of source.steps.entries()) {
    const before = clone(await storage.get());
    const command = clone(typeof entry === "function" ? entry(before, history) : entry);
    let outcome: ParityStep["outcome"] = "applied"; let changed: boolean | undefined;
    try {
      if (command.kind === "commit") changed = (await writer.commit(command)).intentCommitted;
      else if (command.command.action === "initialize") await writer.initialize(command.command.ownership);
      else if (command.command.action === "scope") await writer.enterScope(command.command.accountId, command.command.sessionId);
      else await writer.acknowledge(command.command.envelope, command.command.scope);
    } catch {
      outcome = "refused";
      if (JSON.stringify(clone(await storage.get())) !== JSON.stringify(before)) throw new Error(`${source.name}: refusal wrote`);
    }
    const after = clone(await storage.get()); history.push(after);
    steps.push({ command, outcome, ...(changed === undefined || outcome === "refused" ? {} : { changed }), summary: summary(after),
      digest: digest(after), ...(index === source.steps.length - 1 ? { record: after } : {}) });
  }
  return { name: source.name, rule: source.rule, about: source.about, initial: source.initial ? clone(source.initial) : null, writeIds, steps };
}

export async function generateVectors(): Promise<ParityVectors> {
  const cases: ParityCase[] = [];
  for (const source of await sources()) cases.push(await generate(source));
  return { about: [
    "Atomic settings writer parity vectors: the reviewed TypeScript AtomicSettingsWriter is the reference.",
    "Generated by packages/core/src/storage/__tests__/support/atomic-settings-writer-vectors.ts; regenerate with",
    "STILL_UPDATE_ATOMIC_VECTORS=1 pnpm --filter @still/core exec vitest run atomic-settings-writer-vectors. Do not edit by hand.",
    "Replayed by StillKit AtomicSettingsWriterVectorTests.swift and the compiled-host test in atomic-settings.test.ts.",
    "Each step: the command, whether the writer applied or refused it, the commit's intentCommitted, a diagnostic summary,",
    "and digest = SHA-256 hex of the key-sorted, whitespace-free JSON of the complete stored record after the step",
    "(UTF-16 key order; \"null\" when absent). The final step also keeps the record. A refusal never writes. All values are synthetic.",
    `Fixed identities: account A ${A}, account B ${B}, session ${SESSION}, lineage ${LINEAGE}, server time ${T}.`,
  ], cases };
}

/** One case per line block and one step per line: reviewable diffs at a fraction of pretty-printed size. */
export function formatVectors(vectors: ParityVectors): string {
  const cases = vectors.cases.map(c => {
    const { steps, ...head } = c;
    const fields = Object.entries(head).map(([key, value]) => `      ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
    return `    {\n${fields.join(",\n")},\n      "steps": [\n${steps.map(step => `        ${JSON.stringify(step)}`).join(",\n")}\n      ]\n    }`;
  });
  return `{\n  "about": ${JSON.stringify(vectors.about, null, 4).replace(/\n\]$/, "\n  ]")},\n  "cases": [\n${cases.join(",\n")}\n  ]\n}\n`;
}
