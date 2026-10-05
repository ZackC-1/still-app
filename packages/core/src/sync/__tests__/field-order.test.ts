import { describe, expect, it } from "vitest";
import {
  SETTINGS_FIELDS,
  MAX_SETTINGS_LOCAL_STEP,
  MAX_SETTINGS_REVISION,
} from "@still/shared-types";
import {
  allocateSettingsFieldEdit,
  mergeSettingsField,
  mergeSettingsFields,
  pendingSettingsFieldAfterAck,
  readSettingsOrderedField,
  type SettingsOrderedField,
} from "../field-order.js";

import sharedVectors from "../../../../shared-types/fixtures/field-order.json";

const vectors = sharedVectors as {
  merges: {
    name: string;
    left: SettingsOrderedField;
    right: SettingsOrderedField;
    expected: SettingsOrderedField;
  }[];
  edits: {
    name: string;
    prior: SettingsOrderedField;
    revision: number;
    requested: boolean;
    status: string;
    expected: SettingsOrderedField;
  }[];
  pending: {
    name: string;
    pending: SettingsOrderedField | null;
    canonical: SettingsOrderedField;
    expected: SettingsOrderedField | null;
  }[];
  invalid: unknown[];
};
const field = (
  baseRevision: number,
  localStep: number,
  value: boolean,
): SettingsOrderedField => ({ value, stamp: { baseRevision, localStep } });

describe("pure settings field order", () => {
  it.each(vectors.merges)(
    "shared merge: $name",
    ({ left, right, expected }) => {
      expect(mergeSettingsField(left, right)).toEqual(expected);
    },
  );
  it.each(vectors.edits)(
    "shared edit: $name",
    ({ prior, revision, requested, status, expected }) => {
      const result = allocateSettingsFieldEdit(prior, revision, requested);
      expect(result.status).toBe(status);
      expect(result.field).toEqual(expected);
      if (result.status === "hold" || result.status === "recovery")
        expect(result.requestedValue).toBe(requested);
    },
  );
  it.each(vectors.pending)(
    "shared acknowledgement: $name",
    ({ pending, canonical, expected }) => {
      expect(pendingSettingsFieldAfterAck(pending, canonical)).toEqual(
        expected,
      );
    },
  );
  it.each(vectors.invalid)("rejects malformed pair: %j", (input) => {
    expect(readSettingsOrderedField(input)).toBeNull();
  });
  it("rejects invalid numeric values and arrays without coercion", () => {
    const prior = field(1, 1, true);
    const copy = structuredClone(prior);
    for (const n of [
      NaN,
      Infinity,
      -Infinity,
      -1,
      1.5,
      MAX_SETTINGS_REVISION + 1,
    ]) {
      expect(readSettingsOrderedField(field(n, 1, true))).toBeNull();
      expect(readSettingsOrderedField(field(1, n, true))).toBeNull();
      expect(allocateSettingsFieldEdit(prior, n, false)).toEqual({
        status: "recovery",
        reason: "invalid-acknowledgement",
        field: prior,
        requestedValue: false,
      });
      expect(prior).toEqual(copy);
    }
    expect(readSettingsOrderedField([])).toBeNull();
    expect(readSettingsOrderedField({ value: true, stamp: [] })).toBeNull();
  });
  it("no-op returns the same pair and preserves opaque stamp metadata even at saturation", () => {
    const prior = {
      value: false,
      stamp: {
        baseRevision: 4,
        localStep: MAX_SETTINGS_LOCAL_STEP,
        future: "kept",
      },
    };
    expect(allocateSettingsFieldEdit(prior, 5, false)).toEqual({
      status: "unchanged",
      field: prior,
    });
    expect(allocateSettingsFieldEdit(prior, 5, false).field).toBe(prior);
    expect(readSettingsOrderedField(prior)).toEqual(prior);
    expect(allocateSettingsFieldEdit(prior, 5, true).field.stamp).toEqual({
      baseRevision: 5,
      localStep: 1,
      future: "kept",
    });
  });
  it("refuses malformed typed input without defaulting or allocating", () => {
    const prior = field(-1, 1, false);
    expect(allocateSettingsFieldEdit(prior, 5, true)).toEqual({
      status: "recovery",
      reason: "malformed-field",
      field: prior,
      requestedValue: true,
    });
    expect(() => mergeSettingsField(prior, field(1, 1, true))).toThrow(
      TypeError,
    );
  });
  it("merges independent registry fields, preserves all-Off and leaves inputs unchanged", () => {
    const baseline = Object.fromEntries(
      SETTINGS_FIELDS.map((key) => [key, field(2, 0, false)]),
    );
    const copy = structuredClone(baseline);
    const a = mergeSettingsFields(baseline, { globalOn: field(2, 1, true) });
    const b = mergeSettingsFields(a, { "services.youtube": field(2, 1, true) });
    expect(b.globalOn?.value).toBe(true);
    expect(b["services.youtube"]?.value).toBe(true);
    expect(b["services.tiktok"]?.value).toBe(false);
    expect(mergeSettingsFields(baseline, baseline)).toEqual(copy);
    expect(baseline).toEqual(copy);
    const global = {
      value: true,
      stamp: { baseRevision: 3, localStep: 1, future: { retained: true } },
    };
    const youtube = field(4, 2, false);
    type Fields = Parameters<typeof mergeSettingsFields>[0];
    const cases: [Fields, Fields, Fields][] = [
      [{}, {}, {}],
      [{}, { globalOn: global }, { globalOn: global }],
      [{ globalOn: global }, {}, { globalOn: global }],
      [
        { globalOn: global },
        { "services.youtube": youtube },
        { globalOn: global, "services.youtube": youtube },
      ],
    ];
    for (const [left, right, expected] of cases) {
      const leftCopy = structuredClone(left);
      const rightCopy = structuredClone(right);
      const merged = mergeSettingsFields(left, right);
      expect(merged).toEqual(expected);
      expect(Object.keys(merged).sort()).toEqual(Object.keys(expected).sort());
      expect(left).toEqual(leftCopy);
      expect(right).toEqual(rightCopy);
    }
    expect(() =>
      mergeSettingsFields(baseline, {
        "sites.tiktok.all": field(2, 1, true),
      } as never),
    ).toThrow(TypeError);
  });
});
