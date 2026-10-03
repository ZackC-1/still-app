import { describe, expect, it } from "vitest";
import { SETTINGS_FIELDS, MAX_SETTINGS_LOCAL_STEP } from "@still/shared-types";
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
  it("rejects nonfinite values and arrays without coercion", () => {
    for (const n of [NaN, Infinity, -Infinity]) {
      expect(readSettingsOrderedField(field(n, 1, true))).toBeNull();
      expect(readSettingsOrderedField(field(1, n, true))).toBeNull();
      expect(
        allocateSettingsFieldEdit(field(1, 1, true), n, false).status,
      ).toBe("recovery");
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
    expect(() =>
      mergeSettingsFields(baseline, {
        "sites.tiktok.all": field(2, 1, true),
      } as never),
    ).toThrow(TypeError);
  });
  it("executes 6,534 applicable reference algebra assertions", () => {
    const domain = [0, 1, 2].flatMap((base) =>
      [0, 1, 2].flatMap((step) =>
        [false, true].map((value) => field(base, step, value)),
      ),
    );
    let assertions = 0;
    const check = (a: unknown, b: unknown) => {
      expect(a).toEqual(b);
      assertions++;
    };
    for (const a of domain)
      for (const b of domain) {
        check(mergeSettingsField(a, b), mergeSettingsField(b, a));
        check(
          mergeSettingsField(mergeSettingsField(a, b), b),
          mergeSettingsField(a, b),
        );
        for (const c of domain)
          check(
            mergeSettingsField(mergeSettingsField(a, b), c),
            mergeSettingsField(a, mergeSettingsField(b, c)),
          );
      }
    for (const a of domain) {
      check(mergeSettingsField(a, a), a);
      const edit = allocateSettingsFieldEdit(a, a.stamp.baseRevision, !a.value);
      check(
        mergeSettingsField(a, edit.field),
        field(a.stamp.baseRevision, a.stamp.localStep + 1, !a.value),
      );
      const advanced = allocateSettingsFieldEdit(
        a,
        a.stamp.baseRevision + 1,
        !a.value,
      );
      check(advanced.field, field(a.stamp.baseRevision + 1, 1, !a.value));
    }
    expect(assertions).toBe(6534);
  });
});
