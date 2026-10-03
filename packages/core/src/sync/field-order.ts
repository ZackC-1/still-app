import {
  MAX_SETTINGS_LOCAL_STEP,
  MAX_SETTINGS_REVISION,
  SETTINGS_FIELDS,
  type SettingsField,
  type SettingsFieldStamp,
} from "@still/shared-types";

/** A field projection from an already validated adapter record; not receipt authentication. */
export interface SettingsOrderedField {
  readonly value: boolean;
  readonly stamp: SettingsFieldStamp;
}

export type SettingsFieldEditResult =
  | {
      readonly status: "unchanged" | "edited";
      readonly field: SettingsOrderedField;
    }
  | {
      readonly status: "hold";
      readonly reason: "step-saturated";
      readonly field: SettingsOrderedField;
      /** Keep this local choice separately; the old stamp cannot safely rank it. */
      readonly requestedValue: boolean;
    }
  | {
      readonly status: "recovery";
      readonly reason:
        "malformed-field" | "invalid-acknowledgement" | "stale-acknowledgement";
      readonly field: SettingsOrderedField;
      readonly requestedValue: boolean;
    };

function integer(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/** Strict ordering validation; opaque stamp members stay intact. Full JSON bounds belong to the existing parser. */
export function readSettingsOrderedField(
  input: unknown,
): SettingsOrderedField | null {
  if (
    !object(input) ||
    !Object.hasOwn(input, "value") ||
    typeof input.value !== "boolean" ||
    !Object.hasOwn(input, "stamp") ||
    !object(input.stamp) ||
    !Object.hasOwn(input.stamp, "baseRevision") ||
    !Object.hasOwn(input.stamp, "localStep") ||
    !integer(input.stamp.baseRevision, MAX_SETTINGS_REVISION) ||
    !integer(input.stamp.localStep, MAX_SETTINGS_LOCAL_STEP)
  )
    return null;
  return {
    value: input.value,
    stamp: { ...input.stamp } as SettingsFieldStamp,
  };
}

function requireField(field: SettingsOrderedField): void {
  if (!readSettingsOrderedField(field))
    throw new TypeError("Malformed settings field ordering");
}
function sameOrder(
  left: SettingsOrderedField,
  right: SettingsOrderedField,
): boolean {
  return (
    left.stamp.baseRevision === right.stamp.baseRevision &&
    left.stamp.localStep === right.stamp.localStep
  );
}

/** Lexicographic revision/step order; an exact order tie chooses Off. Never reads wall time. */
export function mergeSettingsField(
  left: SettingsOrderedField,
  right: SettingsOrderedField,
): SettingsOrderedField {
  requireField(left);
  requireField(right);
  if (sameOrder(left, right)) return left.value ? right : left;
  if (left.stamp.baseRevision !== right.stamp.baseRevision) {
    return left.stamp.baseRevision > right.stamp.baseRevision ? left : right;
  }
  return left.stamp.localStep > right.stamp.localStep ? left : right;
}

/** Only a deliberate changed choice allocates intent. The adapter must establish anchor trust. */
export function allocateSettingsFieldEdit(
  prior: SettingsOrderedField,
  acknowledgedRevision: number,
  requestedValue: boolean,
): SettingsFieldEditResult {
  const recovery = (
    reason: Extract<SettingsFieldEditResult, { status: "recovery" }>["reason"],
  ): SettingsFieldEditResult => ({
    status: "recovery",
    reason,
    field: prior,
    requestedValue,
  });
  if (!readSettingsOrderedField(prior) || typeof requestedValue !== "boolean")
    return recovery("malformed-field");
  if (requestedValue === prior.value)
    return { status: "unchanged", field: prior };
  if (!integer(acknowledgedRevision, MAX_SETTINGS_REVISION))
    return recovery("invalid-acknowledgement");
  if (acknowledgedRevision < prior.stamp.baseRevision)
    return recovery("stale-acknowledgement");
  if (
    acknowledgedRevision === prior.stamp.baseRevision &&
    prior.stamp.localStep === MAX_SETTINGS_LOCAL_STEP
  ) {
    return {
      status: "hold",
      reason: "step-saturated",
      field: prior,
      requestedValue,
    };
  }
  return {
    status: "edited",
    field: {
      value: requestedValue,
      stamp: {
        ...prior.stamp,
        baseRevision: acknowledgedRevision,
        localStep:
          acknowledgedRevision > prior.stamp.baseRevision
            ? 1
            : prior.stamp.localStep + 1,
      },
    },
  };
}

export type SettingsOrderedFields = Readonly<
  Partial<Record<SettingsField, SettingsOrderedField>>
>;

/** Independent known fields merge without interpreting absent fields as defaults or edits. */
export function mergeSettingsFields(
  left: SettingsOrderedFields,
  right: SettingsOrderedFields,
): SettingsOrderedFields {
  for (const fields of [left, right]) {
    if (!object(fields)) throw new TypeError("Malformed settings field map");
    for (const [key, value] of Object.entries(fields)) {
      if (!SETTINGS_FIELDS.includes(key as SettingsField))
        throw new TypeError("Unknown settings field");
      requireField(value);
    }
  }
  const merged: Partial<Record<SettingsField, SettingsOrderedField>> = {};
  for (const key of SETTINGS_FIELDS) {
    const a = left[key],
      b = right[key];
    if (a && b) merged[key] = mergeSettingsField(a, b);
    else if (a || b) merged[key] = a ?? b;
  }
  return merged;
}

/** A winning canonical acknowledgement clears pending; an older echo leaves later intent intact. */
export function pendingSettingsFieldAfterAck(
  pending: SettingsOrderedField | null,
  canonical: SettingsOrderedField,
): SettingsOrderedField | null {
  requireField(canonical);
  if (pending === null) return null;
  const winner = mergeSettingsField(pending, canonical);
  return winner === pending &&
    !(sameOrder(pending, canonical) && pending.value === canonical.value)
    ? pending
    : null;
}
