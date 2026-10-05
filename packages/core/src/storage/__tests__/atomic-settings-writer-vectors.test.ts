import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digest, formatVectors, generateVectors, VECTORS_FILE, type ParityCase, type ParityRule, type ParityVectors } from "./support/atomic-settings-writer-vectors.js";

// The fixture is shared with StillKit (AtomicSettingsWriterVectorTests.swift) and the compiled-host
// replay in atomic-settings.test.ts. This file pins it to the reference TypeScript writer and
// checks that each case still demonstrates the rule it is named for.
const file = resolve(import.meta.dirname, "../../../../..", VECTORS_FILE);

describe("shared atomic settings writer vectors", () => {
  let vectors: ParityVectors;
  const byName = (name: string): ParityCase => {
    const found = vectors.cases.find(c => c.name === name);
    if (!found) throw new Error(`missing case ${name}`);
    return found;
  };

  it("the checked-in fixture is exactly what the reference TypeScript writer produces", async () => {
    const generated = await generateVectors();
    if (process.env.STILL_UPDATE_ATOMIC_VECTORS === "1") await writeFile(file, formatVectors(generated));
    vectors = JSON.parse(await readFile(file, "utf8")) as ParityVectors;
    expect(vectors).toStrictEqual(JSON.parse(JSON.stringify(generated)));
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
        const unknownLocal = c.name.includes("ownership-hold") && i === 0;
        if (step.command.kind === "commit" && !fresh && !unknownLocal) expect(step.summary!.updatedAt, `${c.name} step ${i}`).toBe(previous);
        if (fresh) expect(step.summary!.updatedAt, `${c.name} step ${i}`).toBe(step.command.kind === "commit" ? step.command.updatedAt : previous);
        previous = step.summary!.updatedAt; if (newest) seen.add(newest);
      }
    }
    const holds = byName("queued-updatedAt/ordering-hold-and-unchanged-keep-the-stamp");
    expect(holds.steps.map(s => s.summary!.paused)).toEqual(["ordering-hold", null, null, null]);
    expect(byName("queued-updatedAt/pending-limit-keeps-the-stamp").steps[64]!.summary).toMatchObject({ paused: "pending-limit" });
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

  it("legacy-commit: absent records are never repointed and stamps never move backward", () => {
    const absent = byName("legacy-commit/absent-record-saves-a-never-repointed-record");
    expect(absent.steps[0]!.summary).toMatchObject({ syncEpoch: 0, updatedAt: 10, sequence: null });
    expect(absent.steps.at(-1)!.record).toMatchObject({ syncMetadata: null, syncEpoch: 0, atomic: { ownership: "unknown" } });
    expect(absent.steps.map(s => s.outcome)).toEqual(["applied", "applied", "refused", "applied", "applied"]);
    const backward = byName("legacy-commit/stamps-never-move-backward");
    expect(backward.steps.map(s => s.summary!.updatedAt)).toEqual([5_001, 5_002, 9_000, 9_000, 9_000]);
  });
});
