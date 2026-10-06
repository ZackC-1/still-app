import { beforeAll, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SettingsV2 } from "@still/shared-types";
import { A, LINEAGE, SESSION } from "./atomic-settings-test-fixtures.js";
import { digest, formatVectors, generateVectors, VECTORS_FILE, type ParityCase, type ParityRule, type ParityVectors } from "./support/atomic-settings-writer-vectors.js";

// The fixture is shared with StillKit (AtomicSettingsWriterVectorTests.swift) and the compiled-host
// replay in atomic-settings.test.ts. This file pins it to the reference TypeScript writer and
// checks each case against independent expectations of the rule it is named for, so a
// regeneration cannot silently bless a writer regression.
const file = resolve(import.meta.dirname, "../../../../..", VECTORS_FILE);

describe("shared atomic settings writer vectors", () => {
  let vectors: ParityVectors;
  let generated: ParityVectors;
  const byName = (name: string): ParityCase => {
    const found = vectors.cases.find(c => c.name === name);
    if (!found) throw new Error(`missing case ${name}`);
    return found;
  };
  // Every assertion block reads the checked-in fixture loaded here, never state from another test.
  beforeAll(async () => {
    generated = JSON.parse(JSON.stringify(await generateVectors())) as ParityVectors;
    if (process.env.STILL_UPDATE_ATOMIC_VECTORS === "1") await writeFile(file, formatVectors(generated));
    vectors = JSON.parse(await readFile(file, "utf8")) as ParityVectors;
  });

  it("the checked-in fixture is exactly what the reference TypeScript writer produces", () => {
    expect(vectors).toStrictEqual(generated);
  });

  it("covers every parity rule and ends every case with a complete record", () => {
    const rules: ParityRule[] = ["compaction", "queued-updatedAt", "pauses-projection", "scope-members", "saturation-order", "legacy-commit", "baseline"];
    for (const rule of rules) expect(vectors.cases.some(c => c.rule === rule), rule).toBe(true);
    for (const c of vectors.cases) {
      expect(c.steps.at(-1), c.name).toHaveProperty("record");
      expect(digest(c.steps.at(-1)!.record), c.name).toBe(c.steps.at(-1)!.digest);
    }
    expect(new Set(vectors.cases.map(c => c.name)).size).toBe(vectors.cases.length);
  });

  it("compaction: an eligible never-linked journal never pauses; an ineligible one is immutable and holds", () => {
    const pendingIds = (c: ParityCase) => c.steps.at(-1)!.record!.atomic!.pending.map(p => p.writeId);
    const bounded = byName("compaction/never-linked-journal-stays-bounded");
    expect(bounded.steps).toHaveLength(72);
    for (const step of bounded.steps) {
      expect(step).toMatchObject({ outcome: "applied", changed: true, summary: { paused: null, held: {} } });
      expect(step.summary!.pendingCount).toBeLessThanOrEqual(4); // newest per edited field + the new request
    }
    const full = byName("compaction/full-journal-admits-the-next-edit");
    expect(full.steps.map(s => s.summary!.paused)).toEqual([null, null, null]);
    expect(pendingIds(full)).toEqual(full.writeIds);
    const ranked = byName("compaction/rank-ties-and-multi-field-bodies-survive");
    expect(pendingIds(ranked)).toEqual([...ranked.initial!.atomic!.pending.slice(0, 2).map(p => p.writeId), ranked.writeIds[0]]);
    const immutable = byName("compaction/epoch-absent-journal-stays-immutable");
    expect(immutable.steps[63]!.summary).toMatchObject({ paused: null, pendingCount: 64 });
    expect(immutable.steps[64]!.summary).toMatchObject({ paused: "pending-limit", held: { globalOn: false }, pendingCount: 64,
      newestPending: immutable.steps[63]!.summary!.newestPending });
  });

  it("queued-updatedAt: only an allocated request restamps settings.updatedAt", () => {
    for (const c of vectors.cases.filter(v => v.rule === "queued-updatedAt")) {
      let previous = c.initial!.settings.updatedAt; const seen = new Set(c.initial!.atomic?.pending.map(p => p.writeId) ?? []);
      for (const [i, step] of c.steps.entries()) {
        const newest = step.summary!.newestPending; const fresh = newest !== null && !seen.has(newest);
        const unknownLocal = c.name.includes("ownership-pause") && i === 0;
        if (step.command.kind === "commit" && !fresh && !unknownLocal) expect(step.summary!.updatedAt, `${c.name} step ${i}`).toBe(previous);
        if (fresh) expect(step.summary!.updatedAt, `${c.name} step ${i}`).toBe(step.command.kind === "commit" ? step.command.updatedAt : previous);
        previous = step.summary!.updatedAt; if (newest) seen.add(newest);
      }
    }
    const holds = byName("queued-updatedAt/ordering-hold-and-unchanged-keep-the-stamp");
    expect(holds.steps.map(s => s.summary!.paused)).toEqual(["ordering-hold", null, null, null]);
    expect(byName("queued-updatedAt/pending-limit-keeps-the-stamp").steps[64]!.summary).toMatchObject({ paused: "pending-limit" });
  });

  it("VD-15 ownership: an empty account seeds defaults, and every stored ownership hold has a way out", () => {
    const last = (c: ParityCase) => c.steps.at(-1)!.record!;
    const seeded = byName("baseline/previous-account-into-empty-account-seeds-defaults");
    expect(seeded.steps[4]!.summary).toMatchObject({ paused: null, held: {}, pendingCount: 0 });
    const b = last(seeded) as unknown as { settings: SettingsV2; atomic: { ownership: string; pending: { receipt: { lineage: string }; operations: { path: string }[] }[] } };
    expect(b.settings).toMatchObject({ globalOn: true, services: { youtube: false, instagram: true, facebook: true, tiktok: true } });
    expect(b.atomic.ownership).toBe("previous-account");
    expect(b.atomic.pending).toHaveLength(1);
    expect(b.atomic.pending[0]!.receipt.lineage).not.toBe(LINEAGE);
    expect(b.atomic.pending[0]!.operations.map(o => o.path)).toEqual(["services.youtube"]);
    const aba = last(byName("baseline/a-b-a-returns-to-the-account"));
    expect(aba.atomic).toMatchObject({ paused: null, held: {}, pending: [] });
    expect(aba.settings).toMatchObject({ services: { youtube: true, instagram: false } });
    for (const name of ["baseline/stored-ownership-hold-resolves-on-the-next-read", "baseline/sign-out-releases-an-ownership-hold",
      "baseline/wake-releases-a-signed-out-ownership-hold"]) {
      const c = byName(name);
      expect(c.initial!.atomic).toMatchObject({ paused: "ownership-hold", held: { "services.instagram": false } });
      expect(c.steps.at(-2)!.summary, name).toMatchObject({ paused: null, held: {} });
      expect(c.steps.at(-1)!.changed, name).toBe(true); // the switch commits again
      expect(last(c).settings.services.instagram, name).toBe(false);
    }
    const wake = byName("baseline/wake-releases-a-signed-out-ownership-hold");
    expect(wake.steps[1]!.digest).toBe(wake.steps[0]!.digest);
  });

  it("pauses-projection: every write stores the empty retired pauses list", () => {
    for (const c of vectors.cases.filter(v => v.rule === "pauses-projection"))
      expect((c.steps.at(-1)!.record!.settings as { pauses?: unknown }).pauses, c.name).toEqual([]);
  });

  it("scope-members: scope identity ignores unknown members", () => {
    const pending = byName("scope-members/pending-scope-identity-is-member-wise");
    expect(pending.steps[0]!.record!.atomic!.pending.map(p => p.writeId)).toEqual([pending.initial!.atomic!.pending[0]!.writeId, pending.writeIds[0]]);
    const acknowledged = byName("scope-members/acknowledged-scope-identity-is-member-wise");
    expect(acknowledged.steps[0]!.record!.atomic!.anchor).toMatchObject({ revision: 2 });
  });

  it("saturation-order: no-op answers precede saturation refusals and refusals never write", () => {
    const sequence = byName("saturation-order/no-op-answers-precede-the-sequence-bound");
    expect(sequence.steps.map(s => s.outcome)).toEqual(["applied", "applied", "refused", "refused", "refused"]);
    for (const step of sequence.steps) expect(step.digest).toBe(digest(sequence.initial));
    const generation = byName("saturation-order/same-session-precedes-the-generation-bound");
    expect(generation.steps.map(s => s.outcome)).toEqual(["applied", "refused", "refused"]);
    for (const step of generation.steps) expect(step.digest).toBe(digest(generation.initial));
  });

  it("legacy-commit: a no-op on an absent record writes nothing; the first real change does", () => {
    const noop = byName("legacy-commit/no-op-on-absent-record-writes-nothing");
    expect(noop.steps.map(s => s.outcome)).toEqual(["applied", "applied", "refused", "applied"]);
    for (const step of noop.steps.slice(0, 3)) {
      expect(step.digest).toBe(digest(null)); expect(step.summary).toBeNull();
    }
    expect(noop.steps.slice(0, 2).map(s => s.changed)).toEqual([false, false]);
    expect(noop.steps[3]).toMatchObject({ changed: true, record: { syncMetadata: null, syncEpoch: 0, settings: { globalOn: false, updatedAt: 13 } } });
  });

  it("legacy-commit: absent records are never repointed and stamps never move backward", () => {
    const absent = byName("legacy-commit/absent-record-saves-a-never-repointed-record");
    expect(absent.steps[0]!.summary).toMatchObject({ syncEpoch: 0, updatedAt: 10, sequence: null });
    expect(absent.steps.at(-1)!.record).toMatchObject({ syncMetadata: null, syncEpoch: 0, atomic: { ownership: "unknown" } });
    expect(absent.steps.map(s => s.outcome)).toEqual(["applied", "applied", "refused", "applied", "applied"]);
    const backward = byName("legacy-commit/stamps-never-move-backward");
    expect(backward.steps.map(s => s.summary!.updatedAt)).toEqual([5_001, 5_002, 9_000, 9_000, 9_000]);
  });

  it("compaction first link: the compacted journal transfers with original identities and clears once acknowledged", () => {
    const c = byName("compaction/first-link-transfers-the-compacted-journal");
    const [w1, w2, w3, w4, w5, w6, w7] = c.writeIds as string[];
    expect(c.writeIds).toHaveLength(7);
    // Six alternating globalOn edits then one YouTube edit: only the newest globalOn request survives.
    expect(c.steps.slice(0, 7).map(s => s.summary!.newestPending)).toEqual([w1, w2, w3, w4, w5, w6, w7]);
    expect(c.steps[6]!.summary).toMatchObject({ pendingCount: 2, paused: null, held: {}, syncEpoch: 0 });
    // First link from never-linked: one repoint, both requests carried, no ownership pause.
    expect(c.steps[7]!.summary).toMatchObject({ pendingCount: 2, newestPending: w7, paused: null, held: {}, syncEpoch: 1,
      sequence: c.steps[6]!.summary!.sequence! + 1 });
    // A baseline account answer at revision 0 cannot outrank local intent: both requests remain.
    expect(c.steps[8]!.summary).toMatchObject({ pendingCount: 2, paused: null, held: {} });
    const final = c.steps[9]!.record!;
    expect(final.atomic).toMatchObject({ ownership: "previous-account", scope: { accountId: A, sessionId: SESSION, generation: 1 },
      anchor: { lineage: LINEAGE, revision: 1 }, pending: [], held: {}, paused: null });
    expect(final.settings).toMatchObject({ globalOn: true, services: { youtube: false } });
  });

  it("baseline: an older acknowledgement keeps newer queued intent; a stale-scope answer is ignored", () => {
    const c = byName("baseline/acknowledgement-keeps-newer-local-intent");
    const [sent, newer, youtube] = c.writeIds;
    expect(c.writeIds).toHaveLength(3);
    expect(c.steps[1]!.summary).toMatchObject({ pendingCount: 2, newestPending: newer });
    expect(c.steps[2]!.summary).toMatchObject({ pendingCount: 1, newestPending: newer, paused: null });
    expect(sent).not.toBe(newer);
    expect(c.steps[3]!.summary).toMatchObject({ pendingCount: 2, newestPending: youtube });
    // Signing in to another account retires queued requests and waits for its first answer.
    expect(c.steps[4]!.summary).toMatchObject({ pendingCount: 0, paused: "ownership-unconfirmed", syncEpoch: c.steps[3]!.summary!.syncEpoch! + 1 });
    expect(c.steps[5]!.summary).toMatchObject({ pendingCount: 0, paused: "ownership-unconfirmed" });
    expect(c.steps[6]!.digest).toBe(c.steps[5]!.digest);
    expect(c.steps[6]!.record!.settings).toMatchObject({ globalOn: true, services: { youtube: false } });
    expect(c.steps[6]!.record!.atomic).toMatchObject({ scope: { accountId: A, sessionId: SESSION }, anchor: null });
  });

  it("baseline: an account switch retires queued intent and adopts the non-empty account", () => {
    const c = byName("baseline/account-switch-retires-pending-and-adopts-the-account");
    expect(c.steps[1]!.summary).toMatchObject({ pendingCount: 2 });
    expect(c.steps[2]!.summary).toMatchObject({ pendingCount: 0, paused: "ownership-unconfirmed" });
    expect(c.steps[3]!.summary).toMatchObject({ pendingCount: 0, paused: null, held: {} });
    expect(c.steps[4]!.summary).toMatchObject({ pendingCount: 1, newestPending: c.writeIds[2], paused: null });
    const final = c.steps[5]!.record!;
    // The account's On replaced the local Off for globalOn; the later Facebook Off stays on the device.
    expect(final.settings).toMatchObject({ globalOn: true, services: { facebook: false } });
    expect(final.atomic).toMatchObject({ ownership: "previous-account", scope: { accountId: null }, anchor: null, pending: [], held: {} });
  });

  it("baseline: a never-linked first link into an empty account keeps local choices as bound requests", () => {
    const c = byName("baseline/never-linked-empty-account-first-link");
    expect(c.steps[2]!.summary).toMatchObject({ pendingCount: 2, paused: null });
    expect(c.steps[3]!.summary).toMatchObject({ pendingCount: 2, paused: null, held: {} });
    const final = c.steps[4]!.record!;
    expect(final.settings).toMatchObject({ globalOn: false, services: { instagram: false }, sites: { "youtube.shorts": false } });
    expect(final.syncMetadata).toBeNull();
    expect(final.atomic!.pending.map(p => p.writeId)).toEqual(c.writeIds);
    for (const request of final.atomic!.pending) expect(request.receipt).toMatchObject({ lineage: LINEAGE, revision: 0 });
    expect(final.atomic!.pending.slice(0, 2).map(p => p.originScope)).toEqual([{ accountId: null, generation: 0 }, { accountId: null, generation: 0 }]);
    expect(final.atomic!.pending[2]!.originScope).toBeUndefined();
  });
});
