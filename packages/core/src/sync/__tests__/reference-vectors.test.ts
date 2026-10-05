import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allocateSettingsFieldEdit,
  mergeSettingsField,
  mergeSettingsFields,
  pendingSettingsFieldAfterAck,
  readSettingsOrderedField,
  type SettingsOrderedField,
  type SettingsOrderedFields,
} from "../field-order.js";

import reference from "../../../../shared-types/fixtures/sync-reference-vectors.json";

type Runner = "ts" | "swift" | "server";
type Case = { id: string; kind: string; runners: Runner[] } & Record<
  string,
  unknown
>;
const vectors = reference as unknown as {
  referenceAssertions: number;
  counts: Record<string, number>;
  domain: SettingsOrderedField[];
  algebra: {
    runners: Runner[];
    commutativity: [number, number, number][];
    replayIdempotence: [number, number, number][];
    associativity: [number, number, number, number][];
    selfIdempotence: [number, number][];
    observedEdit: {
      prior: number;
      acknowledgedRevision: number;
      requested: boolean;
      edited: SettingsOrderedField;
      merged: SettingsOrderedField;
    }[];
    acknowledgementAdvance: {
      prior: number;
      acknowledgedRevision: number;
      requested: boolean;
      edited: SettingsOrderedField;
      mergedValue: boolean;
    }[];
  };
  cases: Case[];
};
const d = vectors.domain;
const merge = mergeSettingsField;
const tsCases = vectors.cases.filter((c) => c.runners.includes("ts"));
const of = <K extends string>(kind: K) =>
  tsCases.filter((c) => c.kind === kind);

/** Each executed vector is one reference assertion; the total is checked at the end. */
let executed = 0;

describe("shared reference vectors (TypeScript field order)", () => {
  it("fixture accounts for exactly the 6,558 reference assertions", () => {
    const a = vectors.algebra;
    const sections = {
      commutativity: a.commutativity.length,
      replayIdempotence: a.replayIdempotence.length,
      associativity: a.associativity.length,
      selfIdempotence: a.selfIdempotence.length,
      observedEdit: a.observedEdit.length,
      acknowledgementAdvance: a.acknowledgementAdvance.length,
      cases: vectors.cases.length,
    };
    expect(sections).toEqual(vectors.counts);
    expect(Object.values(sections).reduce((x, y) => x + y)).toBe(6558);
    expect(vectors.referenceAssertions).toBe(6558);
    expect(new Set(vectors.cases.map((c) => c.id)).size).toBe(24);
    expect(vectors.algebra.runners).toContain("ts");
    for (const c of vectors.cases) expect(c.runners.length).toBeGreaterThan(0);
  });

  it("algebra: commutativity, replay and associativity", () => {
    const a = vectors.algebra;
    for (const [x, y, e] of a.commutativity) {
      expect([merge(d[x]!, d[y]!), merge(d[y]!, d[x]!)]).toEqual([d[e], d[e]]);
      executed++;
    }
    for (const [x, y, e] of a.replayIdempotence) {
      const once = merge(d[x]!, d[y]!);
      expect([merge(once, d[y]!), once]).toEqual([d[e], d[e]]);
      executed++;
    }
    for (const [x, y, z, e] of a.associativity) {
      expect(merge(merge(d[x]!, d[y]!), d[z]!)).toEqual(d[e]);
      expect(merge(d[x]!, merge(d[y]!, d[z]!))).toEqual(d[e]);
      executed++;
    }
  });

  it("algebra: self idempotence and causal edits without wall time", () => {
    const a = vectors.algebra;
    for (const [x, e] of a.selfIdempotence) {
      expect(merge(d[x]!, d[x]!)).toEqual(d[e]);
      executed++;
    }
    for (const v of a.observedEdit) {
      const edit = allocateSettingsFieldEdit(
        d[v.prior]!,
        v.acknowledgedRevision,
        v.requested,
      );
      expect(edit).toEqual({ status: "edited", field: v.edited });
      expect(merge(d[v.prior]!, edit.field)).toEqual(v.merged);
      executed++;
    }
    for (const v of a.acknowledgementAdvance) {
      const edit = allocateSettingsFieldEdit(
        d[v.prior]!,
        v.acknowledgedRevision,
        v.requested,
      );
      expect(edit).toEqual({ status: "edited", field: v.edited });
      expect(merge(d[v.prior]!, edit.field).value).toBe(v.mergedValue);
      executed++;
    }
  });

  it.each(of("merge"))("case merge: $id", (c) => {
    const { left, right, expected } = c as unknown as Record<
      string,
      SettingsOrderedField
    >;
    expect(merge(left!, right!)).toEqual(expected);
    expect(merge(right!, left!)).toEqual(expected);
    executed++;
  });

  it.each(of("fields"))("case independent fields: $id", (c) => {
    const { initial, changes, expected } = c as unknown as {
      initial: SettingsOrderedFields;
      changes: SettingsOrderedFields[];
      expected: SettingsOrderedFields;
    };
    expect(changes.reduce(mergeSettingsFields, initial)).toEqual(expected);
    executed++;
  });

  it.each(of("pending"))("case acknowledgement: $id", (c) => {
    const { pending, canonical, expected } = c as unknown as Record<
      string,
      SettingsOrderedField | null
    >;
    expect(pendingSettingsFieldAfterAck(pending!, canonical!)).toEqual(
      expected,
    );
    executed++;
  });

  it.each(of("invalid"))("case rejects malformed metadata: $id", (c) => {
    expect(c.expected).toBe("rejected");
    expect(readSettingsOrderedField(c.field)).toBeNull();
    executed++;
  });

  it.each(of("edit"))("case edit allocation: $id", (c) => {
    const { prior, acknowledgedRevision, requested, expected } =
      c as unknown as {
        prior: SettingsOrderedField;
        acknowledgedRevision: number;
        requested: boolean;
        expected: {
          status: string;
          field: SettingsOrderedField;
          requestedValue?: boolean;
        };
      };
    const result = allocateSettingsFieldEdit(
      prior,
      acknowledgedRevision,
      requested,
    );
    expect(result.status).toBe(expected.status);
    expect(result.field).toEqual(expected.field);
    if ("requestedValue" in expected)
      expect(
        "requestedValue" in result ? result.requestedValue : undefined,
      ).toBe(expected.requestedValue);
    executed++;
  });

  it("executed every vector assigned to this runner and no server-only vector", () => {
    const kinds = new Set(tsCases.map((c) => c.kind));
    expect([...kinds].sort()).toEqual([
      "edit",
      "fields",
      "invalid",
      "merge",
      "pending",
    ]);
    // Anchor MAC, receipt admission and receive-time replay need the server-only key and store.
    expect(
      vectors.cases
        .filter((c) => !c.runners.includes("ts"))
        .every((c) => ["admission", "anchor", "replay"].includes(c.kind)),
    ).toBe(true);
    expect(executed).toBe(6534 + tsCases.length);
    expect(executed).toBe(6548);
  });
});

// The fixture is generated from scripts/sync-vectors/reference.py and pins that model's hash.
// A hand-edited model or a model changed without regenerating fails here.
describe("shared reference vectors provenance", () => {
  it("pins the committed reference model", () => {
    // Core tests run from packages/core.
    const model = readFileSync(
      resolve(process.cwd(), "../../scripts/sync-vectors/reference.py"),
    );
    expect(createHash("sha256").update(model).digest("hex")).toBe(
      (reference as unknown as { referenceModelSha256: string })
        .referenceModelSha256,
    );
  });
});
