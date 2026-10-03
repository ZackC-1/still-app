import { SETTINGS_FIELDS, type SettingsField } from "./feature-registry.js";
import {
  MAX_SETTINGS_LOCAL_STEP,
  MAX_SETTINGS_REVISION,
} from "./settings-v2.js";

/** Wire syntax only: this receipt has not been authenticated. */
export interface UntrustedSettingsReceipt {
  readonly version: 1;
  readonly lineage: string;
  readonly revision: number;
  readonly mac: string;
}

export interface UntrustedSettingsFieldOperation {
  readonly path: SettingsField;
  readonly value: boolean;
  readonly baseRevision: number;
  readonly localStep: number;
}

/** Parsing does not establish account, lineage, MAC, or operation admission authority. */
export interface UntrustedSettingsOperationRequest {
  readonly protocol: 2;
  readonly writeId: string;
  readonly expectedLineage: string;
  readonly receipt: UntrustedSettingsReceipt;
  readonly operations: readonly UntrustedSettingsFieldOperation[];
}

export type SettingsOperationRequestResult =
  | {
      readonly status: "parsed";
      readonly request: UntrustedSettingsOperationRequest;
    }
  | { readonly status: "invalid"; readonly reason: "request-shape" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A 32-byte base64url value has 43 characters and two zero padding bits.
const MAC = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

function uuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && UUID.test(value);
}

function integer(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= 0 &&
    value <= maximum
  );
}

/** Inspect own data properties without executing input accessors. */
function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const actualKeys = Reflect.ownKeys(input);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return null;
  const descriptors: Record<string, PropertyDescriptor | undefined> =
    Object.create(null);
  for (const key of keys)
    descriptors[key] = Object.getOwnPropertyDescriptor(input, key);
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function operations(
  input: unknown,
): readonly UntrustedSettingsFieldOperation[] | null {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    return null;
  const length = Object.getOwnPropertyDescriptor(input, "length");
  const count: unknown = length?.value;
  if (
    !length ||
    !Object.hasOwn(length, "value") ||
    !integer(count, SETTINGS_FIELDS.length) ||
    count < 1
  )
    return null;
  const keys = [
    "length",
    ...Array.from({ length: count }, (_, i) => String(i)),
  ];
  const actualKeys = Reflect.ownKeys(input);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return null;
  const descriptors: Record<string, PropertyDescriptor | undefined> =
    Object.create(null);
  for (const key of keys)
    descriptors[key] = Object.getOwnPropertyDescriptor(input, key);
  if (descriptors.length?.value !== count) return null;
  const result: UntrustedSettingsFieldOperation[] = [];
  const seen = new Set<SettingsField>();
  for (let i = 0; i < count; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    const operation = record(descriptor.value, [
      "path",
      "value",
      "baseRevision",
      "localStep",
    ]);
    if (
      !operation ||
      typeof operation.path !== "string" ||
      !SETTINGS_FIELDS.includes(operation.path as SettingsField) ||
      typeof operation.value !== "boolean" ||
      !integer(operation.baseRevision, MAX_SETTINGS_REVISION) ||
      !integer(operation.localStep, MAX_SETTINGS_LOCAL_STEP) ||
      operation.localStep === 0
    )
      return null;
    const path = operation.path as SettingsField;
    if (seen.has(path)) return null;
    seen.add(path);
    result.push(
      Object.freeze({
        path,
        value: operation.value,
        baseRevision: operation.baseRevision,
        localStep: operation.localStep,
      }),
    );
  }
  return Object.freeze(result);
}

/**
 * Decode a closed, atomic protocol-2 request into an independent immutable snapshot.
 * Reserved base 0 remains syntax: only later authenticated admission can allow pristine intent.
 * No relation between claimed bases, receipt revision, or lineages is trusted here.
 */
export function readSettingsOperationRequest(
  input: unknown,
): SettingsOperationRequestResult {
  const invalid = { status: "invalid", reason: "request-shape" } as const;
  try {
    const request = record(input, [
      "protocol",
      "writeId",
      "expectedLineage",
      "receipt",
      "operations",
    ]);
    if (
      !request ||
      request.protocol !== 2 ||
      !uuid(request.writeId) ||
      !uuid(request.expectedLineage)
    )
      return invalid;
    const receipt = record(request.receipt, [
      "version",
      "lineage",
      "revision",
      "mac",
    ]);
    if (
      !receipt ||
      receipt.version !== 1 ||
      !uuid(receipt.lineage) ||
      !integer(receipt.revision, MAX_SETTINGS_REVISION) ||
      typeof receipt.mac !== "string" ||
      receipt.mac.length !== 43 ||
      !MAC.test(receipt.mac)
    )
      return invalid;
    const parsedOperations = operations(request.operations);
    if (!parsedOperations) return invalid;
    return {
      status: "parsed",
      request: Object.freeze({
        protocol: 2,
        writeId: request.writeId,
        expectedLineage: request.expectedLineage,
        receipt: Object.freeze({
          version: 1,
          lineage: receipt.lineage,
          revision: receipt.revision,
          mac: receipt.mac,
        }),
        operations: parsedOperations,
      }),
    };
  } catch {
    // Proxies can throw during descriptor/prototype inspection; no partial intent escapes.
    return invalid;
  }
}
