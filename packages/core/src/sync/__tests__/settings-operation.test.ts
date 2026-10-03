import { describe, expect, it } from "vitest";
import {
  MAX_SETTINGS_LOCAL_STEP,
  MAX_SETTINGS_REVISION,
  SETTINGS_FIELDS,
  readSettingsOperationRequest,
} from "@still/shared-types";

const lineage = "00000000-0000-0000-0000-000000000002";
const operation = (path: string = "globalOn", value = false) => ({
  path,
  value,
  baseRevision: 7,
  localStep: 1,
});
const request = () => ({
  protocol: 2,
  writeId: "00000000-0000-0000-0000-000000000001",
  expectedLineage: lineage,
  receipt: { version: 1, lineage, revision: 7, mac: "A".repeat(43) },
  operations: [operation()],
});
const reject = (input: unknown) =>
  expect(readSettingsOperationRequest(input)).toEqual({
    status: "invalid",
    reason: "request-shape",
  });

describe("closed untrusted settings operation request", () => {
  it("accepts one operation and every canonical field with all-Off intent intact", () => {
    expect(SETTINGS_FIELDS).toHaveLength(20);
    const single = request();
    expect(readSettingsOperationRequest(single)).toEqual({
      status: "parsed",
      request: single,
    });
    const all = {
      ...single,
      operations: SETTINGS_FIELDS.map((path) => operation(path)),
    };
    expect(readSettingsOperationRequest(all)).toEqual({
      status: "parsed",
      request: all,
    });
    for (const path of SETTINGS_FIELDS) {
      const raw = { ...single, operations: [operation(path, true)] };
      expect(readSettingsOperationRequest(raw)).toEqual({
        status: "parsed",
        request: raw,
      });
    }
  });

  it("does not authenticate syntactically valid receipt, lineage or reserved base 0", () => {
    const raw = request();
    raw.expectedLineage = "00000000-0000-0000-0000-000000000003";
    raw.operations[0]!.baseRevision = 0;
    expect(readSettingsOperationRequest(raw)).toEqual({
      status: "parsed",
      request: raw,
    });
    raw.operations[0]!.baseRevision = 10;
    expect(readSettingsOperationRequest(raw)).toEqual({
      status: "parsed",
      request: raw,
    });
  });

  it("returns independently frozen request, receipt, array and operations", () => {
    const raw = request();
    const expected = structuredClone(raw);
    const result = readSettingsOperationRequest(raw);
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") throw new Error("Expected parsed request");
    expect(result.request).not.toBe(raw);
    expect(result.request.receipt).not.toBe(raw.receipt);
    expect(result.request.operations).not.toBe(raw.operations);
    expect(result.request.operations[0]).not.toBe(raw.operations[0]);
    raw.protocol = 1;
    raw.writeId = "changed";
    raw.expectedLineage = "changed";
    raw.receipt.mac = "changed";
    raw.receipt.lineage = "changed";
    raw.receipt.revision = 99;
    raw.operations[0]!.value = true;
    raw.operations[0]!.baseRevision = 99;
    raw.operations[0]!.localStep = 99;
    raw.operations[0]!.path = "services.tiktok";
    raw.operations.push(operation());
    expect(result.request).toEqual(expected);
    for (const value of [
      result.request,
      result.request.receipt,
      result.request.operations,
      result.request.operations[0],
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Reflect.set(result.request.operations[0]!, "value", true)).toBe(
      false,
    );
    expect(Reflect.set(result.request.receipt, "revision", 99)).toBe(false);
    expect(result.request).toEqual(expected);
  });

  it.each([null, undefined, true, 2, "{}", [], new Date(), new Map()])(
    "rejects a non-request %s",
    (input) => reject(input),
  );

  it("requires all keys at each level and rejects every unknown own key atomically", () => {
    for (const level of ["request", "receipt", "operation"] as const) {
      const raw = request();
      const target =
        level === "request"
          ? raw
          : level === "receipt"
            ? raw.receipt
            : raw.operations[0]!;
      for (const key of Object.keys(target)) {
        const malformed = structuredClone(raw);
        const part =
          level === "request"
            ? malformed
            : level === "receipt"
              ? malformed.receipt
              : malformed.operations[0]!;
        Reflect.deleteProperty(part, key);
        reject(malformed);
      }
      for (const key of ["extra", "__proto__", Symbol("extra")]) {
        const malformed = structuredClone(raw);
        const part =
          level === "request"
            ? malformed
            : level === "receipt"
              ? malformed.receipt
              : malformed.operations[0]!;
        Object.defineProperty(part, key, { value: false });
        reject(malformed);
      }
    }
    const raw = request();
    raw.operations.push({
      ...operation("services.youtube"),
      extra: true,
    } as any);
    reject(raw);
  });

  it("rejects 0/21 operations, duplicate fields, sparse and decorated arrays", () => {
    reject({ ...request(), operations: [] });
    reject({
      ...request(),
      operations: [
        ...SETTINGS_FIELDS.map((path) => operation(path)),
        operation(),
      ],
    });
    reject({
      ...request(),
      operations: [operation(), operation("services.tiktok"), operation()],
    });
    reject({ ...request(), operations: new Array(1) });
    for (const key of ["extra", Symbol("extra")]) {
      const raw = request();
      Object.defineProperty(raw.operations, key, { value: operation() });
      reject(raw);
    }
    const raw = request();
    delete raw.operations[0];
    raw.operations.push(operation());
    reject(raw);
  });

  it.each([
    "sites.tiktok.all",
    "tiktok.all",
    "services.unknown",
    "sites.youtube.unknown",
    "globalOn.value",
    "globalOn ",
    "__proto__",
    "",
    null,
    1,
    ["globalOn"],
  ])("rejects unknown, alias or malformed path %s", (path) => {
    const raw = request();
    raw.operations.push({ ...operation(), path } as any);
    reject(raw);
  });

  it("rejects malformed protocol, receipt, operation and boolean types", () => {
    for (const value of ["2", 1, 3, true, null, NaN])
      reject({ ...request(), protocol: value });
    for (const value of ["1", 0, 2, true, null])
      reject({
        ...request(),
        receipt: { ...request().receipt, version: value },
      });
    for (const value of [null, [], "receipt", true])
      reject({ ...request(), receipt: value });
    for (const value of [null, {}, "operations", true])
      reject({ ...request(), operations: value });
    for (const value of [null, [], "operation", true])
      reject({ ...request(), operations: [value] });
    for (const value of [
      0,
      1,
      "false",
      "true",
      null,
      undefined,
      new Boolean(false),
    ]) {
      reject({ ...request(), operations: [{ ...operation(), value }] });
    }
  });

  it("accepts exact revision and positive step bounds without coercion", () => {
    for (const revision of [0, 1, MAX_SETTINGS_REVISION]) {
      for (const step of [1, MAX_SETTINGS_LOCAL_STEP]) {
        const raw = request();
        raw.receipt.revision = revision;
        raw.operations[0]!.baseRevision = revision;
        raw.operations[0]!.localStep = step;
        expect(readSettingsOperationRequest(raw)).toEqual({
          status: "parsed",
          request: raw,
        });
      }
    }
    for (const value of [
      NaN,
      Infinity,
      -Infinity,
      -1,
      -0,
      0.5,
      true,
      false,
      "1",
      null,
      MAX_SETTINGS_REVISION + 1,
    ]) {
      reject({
        ...request(),
        receipt: { ...request().receipt, revision: value },
      });
      reject({
        ...request(),
        operations: [{ ...operation(), baseRevision: value }],
      });
      reject({
        ...request(),
        operations: [{ ...operation(), localStep: value }],
      });
    }
    for (const localStep of [0, MAX_SETTINGS_LOCAL_STEP + 1])
      reject({ ...request(), operations: [{ ...operation(), localStep }] });
  });

  it("requires canonical lowercase UUID spelling in all identity fields", () => {
    const good = "abcdefab-cdef-abcd-efab-cdefabcdefab";
    expect(
      readSettingsOperationRequest({
        ...request(),
        writeId: good,
        expectedLineage: good,
        receipt: { ...request().receipt, lineage: good },
      }).status,
    ).toBe("parsed");
    for (const value of [
      good.toUpperCase(),
      good.replaceAll("-", ""),
      `{${good}}`,
      `${good}\n`,
      ` ${good}`,
      `${good} `,
      "g" + good.slice(1),
      "",
      1,
      null,
    ]) {
      reject({ ...request(), writeId: value });
      reject({ ...request(), expectedLineage: value });
      reject({
        ...request(),
        receipt: { ...request().receipt, lineage: value },
      });
    }
  });

  it("requires canonical 32-byte unpadded base64url MAC syntax and zero pad bits", () => {
    for (const last of "AEIMQUYcgkosw048") {
      const raw = request();
      raw.receipt.mac = "_-".repeat(21) + last;
      expect(readSettingsOperationRequest(raw)).toEqual({
        status: "parsed",
        request: raw,
      });
    }
    for (const mac of [
      "A".repeat(42),
      "A".repeat(44),
      "A".repeat(43) + "=",
      "A".repeat(43) + "\n",
      "+" + "A".repeat(42),
      "/" + "A".repeat(42),
      "A".repeat(42) + "B",
      "A".repeat(42) + "_",
      "",
      null,
      1,
    ]) {
      reject({ ...request(), receipt: { ...request().receipt, mac } });
    }
  });

  it("rejects inherited/custom prototypes at every level and accepts own null-prototype records", () => {
    for (const level of ["request", "receipt", "operation", "array"] as const) {
      const raw = request();
      const part =
        level === "request"
          ? raw
          : level === "receipt"
            ? raw.receipt
            : level === "array"
              ? raw.operations
              : raw.operations[0]!;
      Object.setPrototypeOf(part, { inherited: true });
      reject(raw);
    }
    reject(Object.create(request()));
    const raw = request();
    for (const part of [raw, raw.receipt, raw.operations[0]!])
      Object.setPrototypeOf(part, null);
    expect(readSettingsOperationRequest(raw)).toEqual({
      status: "parsed",
      request: raw,
    });
  });

  it("rejects accessors without invoking them, including array indexes and unknown keys", () => {
    let accesses = 0;
    for (const level of ["request", "receipt", "operation", "array"] as const) {
      const base = request();
      const keys =
        level === "request"
          ? Object.keys(base)
          : level === "receipt"
            ? Object.keys(base.receipt)
            : level === "operation"
              ? Object.keys(base.operations[0]!)
              : ["0"];
      for (const key of [...keys, "extra"]) {
        const raw = request();
        const part =
          level === "request"
            ? raw
            : level === "receipt"
              ? raw.receipt
              : level === "array"
                ? raw.operations
                : raw.operations[0]!;
        Object.defineProperty(part, key, {
          get() {
            accesses++;
            throw new Error("Input getter ran");
          },
          configurable: true,
        });
        reject(raw);
      }
    }
    expect(accesses).toBe(0);
    const proxy = new Proxy(request(), {
      getPrototypeOf() {
        throw new Error("Proxy trap");
      },
    });
    reject(proxy);
  });
});
