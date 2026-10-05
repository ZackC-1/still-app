/**
 * Shared settings field-order reference vectors, server runner.
 * The same fixture drives the core vitest runner and the StillKit XCTest runner.
 * Merges execute through the actual sync-server admission/merge/receipt path
 * (syncSettings with an in-memory locked row) whenever the incoming side is a
 * wire-representable operation (localStep >= 1); a step-0 baseline can only be
 * stored, never sent, so those merges use the same shared merge the server imports.
 */
import { assert, assertEquals } from "@std/assert";
import reference from "../../../packages/shared-types/fixtures/sync-reference-vectors.json" with {
  type: "json",
};
import { migrateSettingsV2 } from "../../../packages/core/src/storage/settings-v2.ts";
import {
  mergeSettingsField,
  readSettingsOrderedField,
  type SettingsOrderedField,
} from "../../../packages/core/src/sync/field-order.ts";
import {
  readSettingsOperationRequest,
  type UntrustedSettingsOperationRequest,
} from "../../../packages/shared-types/src/settings-operation.ts";
import type { SettingsField, SettingsV2 } from "@still/shared-types";
import {
  issueSettingsAnchorReceipt,
  type SettingsAnchorState,
  verifySettingsAnchorReceipt,
} from "./settings-anchor.ts";
import {
  type LockedSettingsRow,
  type SettingsStore,
  type SettingsSyncResult,
  syncSettings,
} from "./settings-store.ts";

type Field = SettingsOrderedField;
type Case = {
  id: string;
  kind: string;
  runners: string[];
} & Record<string, unknown>;
const vectors = reference as unknown as {
  counts: Record<string, number>;
  syntheticAnchorKeyHex: string;
  domain: Field[];
  algebra: {
    runners: string[];
    commutativity: [number, number, number][];
    replayIdempotence: [number, number, number][];
    associativity: [number, number, number, number][];
    selfIdempotence: [number, number][];
    observedEdit: { prior: number; edited: Field; merged: Field }[];
    acknowledgementAdvance: {
      prior: number;
      edited: Field;
      mergedValue: boolean;
    }[];
  };
  cases: Case[];
};
const SUBJECT = "33333333-3333-4333-8333-333333333333";
const key = Uint8Array.from(
  vectors.syntheticAnchorKeyHex.match(/../g)!,
  (byte) => parseInt(byte, 16),
);
const LINEAGE = "44444444-4444-4444-8444-444444444444";

function fresh(): SettingsV2 {
  const result = migrateSettingsV2(null, { kind: "proven-fresh" });
  if (result.status !== "ready") throw new Error("fresh settings");
  return structuredClone({ ...result.settings, updatedAt: 1 });
}
function place(settings: SettingsV2, path: string, field: unknown): void {
  const { value, stamp } = field as { value: unknown; stamp: unknown };
  const [group, ...rest] = path.split(".");
  if (path === "globalOn") {
    (settings as Record<string, unknown>).globalOn = value;
  } else (settings[group!] as Record<string, unknown>)[rest.join(".")] = value;
  (settings.clocks as Record<string, unknown>)[path] = stamp;
}
function read(settings: SettingsV2, path: SettingsField): Field {
  const [group, ...rest] = path.split(".");
  const value = path === "globalOn"
    ? settings.globalOn
    : (settings[group!] as Record<string, boolean>)[rest.join(".")]!;
  const { baseRevision, localStep } = settings.clocks[path];
  return { value, stamp: { baseRevision, localStep } };
}

/** Stateful in-memory account row: claims retain write identity, commits advance revision. */
class MemoryRow implements SettingsStore {
  claims = new Map<string, string>();
  commits = 0;
  lastClaim: string | null = null;
  updatedAt: string | null = null;
  writeId: string | null = null;
  now = 1770000000000;
  constructor(public raw: unknown, public revision: number) {}
  state(revision = this.revision): SettingsAnchorState {
    return { subject: SUBJECT, key, lineage: LINEAGE, revision };
  }
  locked<T>(_: string, work: (row: LockedSettingsRow) => Promise<T>) {
    return work({
      anchor: this.state(),
      raw: structuredClone(this.raw),
      empty: false,
      updatedAt: this.updatedAt,
      writeId: this.writeId,
      now: this.now,
      claim: (writeId, body) => {
        const prior = this.claims.get(writeId);
        this.lastClaim = prior === undefined
          ? "new"
          : prior === body
          ? "duplicate"
          : "conflict";
        if (prior === undefined) this.claims.set(writeId, body);
        return Promise.resolve(this.lastClaim as "new");
      },
      commit: (settings, writeId) => {
        this.raw = structuredClone(settings);
        this.revision++;
        this.commits++;
        this.writeId = writeId;
        this.updatedAt = new Date(this.now).toISOString();
        return Promise.resolve();
      },
    });
  }
  static of(fields: Record<string, unknown>, revision: number): MemoryRow {
    const settings = fresh();
    for (const [path, field] of Object.entries(fields)) {
      place(settings, path, field);
    }
    return new MemoryRow(settings, revision);
  }
}

/** Build a wire request exactly as the handler decodes it, then run the server path. */
async function send(
  row: MemoryRow,
  receiptRevision: number,
  operations: Record<string, Field>,
  writeId: string = crypto.randomUUID(),
): Promise<
  { request: UntrustedSettingsOperationRequest; result: SettingsSyncResult }
> {
  const parsed = readSettingsOperationRequest({
    protocol: 2,
    writeId,
    expectedLineage: LINEAGE,
    receipt: await issueSettingsAnchorReceipt(row.state(receiptRevision)),
    operations: Object.entries(operations).map(([path, field]) => ({
      path,
      value: field.value,
      baseRevision: field.stamp.baseRevision,
      localStep: field.stamp.localStep,
    })),
  });
  assertEquals(parsed.status, "parsed");
  if (parsed.status !== "parsed") throw new Error("request shape");
  return {
    request: parsed.request,
    result: await syncSettings(row, SUBJECT, parsed.request),
  };
}
function ready(result: SettingsSyncResult) {
  if (result.status !== "ready") {
    throw new Error(`expected ready, got ${JSON.stringify(result)}`);
  }
  return result;
}

const memo = new Map<string, Field>();
const stats = { server: 0, direct: 0 };
/** Stored canonical `stored` receives incoming `incoming` through the sync server. */
async function serverMerge(stored: Field, incoming: Field): Promise<Field> {
  const id = JSON.stringify([stored, incoming]);
  const known = memo.get(id);
  if (known) return known;
  let merged: Field;
  if (incoming.stamp.localStep >= 1) {
    const revision = Math.max(
      stored.stamp.baseRevision,
      incoming.stamp.baseRevision,
    );
    const row = MemoryRow.of({ globalOn: stored }, revision);
    const { result } = await send(row, incoming.stamp.baseRevision, {
      globalOn: incoming,
    });
    merged = read(ready(result).settings, "globalOn");
    stats.server++;
  } else {
    merged = mergeSettingsField(stored, incoming);
    stats.direct++;
  }
  memo.set(id, merged);
  return merged;
}

const d = vectors.domain;
const serverCases = vectors.cases.filter((c) => c.runners.includes("server"));
let executed = 0;

Deno.test("reference vectors: fixture accounts for exactly 6,558 assertions", () => {
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
  assertEquals(sections, vectors.counts);
  assertEquals(Object.values(sections).reduce((x, y) => x + y), 6558);
  assert(a.runners.includes("server"));
});

Deno.test("reference vectors: algebra through the sync server merge path", async () => {
  const a = vectors.algebra;
  for (const [x, y, e] of a.commutativity) {
    assertEquals(
      [await serverMerge(d[x]!, d[y]!), await serverMerge(d[y]!, d[x]!)],
      [d[e]!, d[e]!],
    );
    executed++;
  }
  for (const [x, y, e] of a.replayIdempotence) {
    const once = await serverMerge(d[x]!, d[y]!);
    assertEquals([await serverMerge(once, d[y]!), once], [d[e]!, d[e]!]);
    executed++;
  }
  for (const [x, y, z, e] of a.associativity) {
    assertEquals(
      await serverMerge(await serverMerge(d[x]!, d[y]!), d[z]!),
      d[e]!,
    );
    assertEquals(
      await serverMerge(d[x]!, await serverMerge(d[y]!, d[z]!)),
      d[e]!,
    );
    executed++;
  }
  for (const [x, e] of a.selfIdempotence) {
    assertEquals(await serverMerge(d[x]!, d[x]!), d[e]!);
    executed++;
  }
  // The server allocates no rank; it must order the client's allocated edit correctly.
  for (const v of a.observedEdit) {
    assertEquals(await serverMerge(d[v.prior]!, v.edited), v.merged);
    executed++;
  }
  for (const v of a.acknowledgementAdvance) {
    assertEquals(
      (await serverMerge(d[v.prior]!, v.edited)).value,
      v.mergedValue,
    );
    executed++;
  }
  assertEquals(executed, 6534);
});

Deno.test("reference vectors: server cases", async (t) => {
  for (const c of serverCases) {
    await t.step(`${c.kind}: ${c.id}`, async () => {
      switch (c.kind) {
        case "merge": {
          const [left, right, expected] = [
            c.left,
            c.right,
            c.expected,
          ] as Field[];
          assertEquals(await serverMerge(left!, right!), expected);
          assertEquals(await serverMerge(right!, left!), expected);
          break;
        }
        case "fields": {
          // Offline edits to different keys from one shared anchor, sent one after another.
          const initial = c.initial as Record<string, Field>;
          const anchor = Math.max(
            ...Object.values(initial).map((f) => f.stamp.baseRevision),
          );
          const row = MemoryRow.of(initial, anchor);
          let last: SettingsSyncResult | null = null;
          for (const change of c.changes as Record<string, Field>[]) {
            last = (await send(row, anchor, change)).result;
          }
          const settings = ready(last!).settings;
          const expected = c.expected as Record<string, Field>;
          for (const [path, field] of Object.entries(expected)) {
            assertEquals(read(settings, path as SettingsField), field, path);
          }
          break;
        }
        case "invalid": {
          assertEquals(c.expected, "rejected");
          const field = c.field as {
            value: unknown;
            stamp: Record<string, unknown>;
          };
          assertEquals(readSettingsOrderedField(field), null);
          // Rejected on the wire: the closed request parser refuses the operation.
          const request = {
            protocol: 2,
            writeId: crypto.randomUUID(),
            expectedLineage: LINEAGE,
            receipt: await issueSettingsAnchorReceipt({
              subject: SUBJECT,
              key,
              lineage: LINEAGE,
              revision: 1,
            }),
            operations: [{
              path: "globalOn",
              value: field.value,
              baseRevision: field.stamp.baseRevision,
              localStep: field.stamp.localStep,
            }],
          };
          assertEquals(readSettingsOperationRequest(request).status, "invalid");
          // Rejected at rest: stored canonical metadata holds instead of merging.
          const row = MemoryRow.of({ globalOn: field }, 1);
          const held = await syncSettings(row, SUBJECT, null);
          assertEquals(held.status, "hold");
          assertEquals(row.commits, 0);
          break;
        }
        case "admission": {
          const operation = c.operation as Field;
          const revisions = c.serverRevisions as number[];
          const expected = c.expected as unknown[];
          assertEquals(revisions.length, expected.length);
          for (const [i, revision] of revisions.entries()) {
            const row = MemoryRow.of({}, revision);
            const { result } = await send(row, c.receiptRevision as number, {
              globalOn: operation,
            });
            assertEquals(result, expected[i], `server revision ${revision}`);
            assertEquals(row.commits, 0);
            assertEquals(row.claims.size, 0);
          }
          break;
        }
        case "replay": {
          const [first, later] = c.receivedAt as number[];
          const row = MemoryRow.of(
            { globalOn: c.stored },
            c.serverRevision as number,
          );
          const writeId = crypto.randomUUID();
          const operation = { globalOn: c.operation as Field };
          const receipt = (c.operation as Field).stamp.baseRevision;
          row.now = first!;
          const initial = ready(
            (await send(row, receipt, operation, writeId)).result,
          );
          row.now = later!;
          const retried = ready(
            (await send(row, receipt, operation, writeId)).result,
          );
          assertEquals(row.lastClaim, "duplicate");
          assertEquals(row.commits, 1);
          const expected = c.expected as {
            field: Field;
            settingsVersion: number;
          };
          for (const result of [initial, retried]) {
            assertEquals(read(result.settings, "globalOn"), expected.field);
            assertEquals(result.settingsVersion, expected.settingsVersion);
          }
          assertEquals(
            retried.settingsServerUpdatedAt,
            initial.settingsServerUpdatedAt,
          );
          break;
        }
        case "anchor": {
          const state = {
            ...(c.state as Omit<SettingsAnchorState, "key">),
            key,
          };
          const receipt = c.receipt as { mac: string };
          const verified = await verifySettingsAnchorReceipt(receipt, state);
          assertEquals(verified ? "accepted" : "rejected", c.expected);
          if (c.expected === "accepted") {
            // Byte-identical to the reference model's HMAC-SHA256 receipt.
            assertEquals(await issueSettingsAnchorReceipt(state), receipt);
          }
          break;
        }
        default:
          throw new Error(`Unhandled server vector kind ${c.kind}`);
      }
      executed++;
    });
  }
  assertEquals(
    [...new Set(serverCases.map((c) => c.kind))].sort(),
    ["admission", "anchor", "fields", "invalid", "merge", "replay"],
  );
  // Pending acknowledgement and rank allocation are client-local; the server allocates no rank.
  assert(
    vectors.cases.filter((c) => !c.runners.includes("server")).every((c) =>
      ["pending", "edit"].includes(c.kind)
    ),
  );
  assertEquals(executed, 6534 + serverCases.length);
  assertEquals(executed, 6554);
  // Most binary merges run through syncSettings; step-0 incoming baselines cannot be sent.
  assert(stats.server > stats.direct, JSON.stringify(stats));
  console.log(
    `server-path merges ${stats.server}, direct baseline merges ${stats.direct}`,
  );
});
