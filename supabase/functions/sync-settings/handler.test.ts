import { assert, assertEquals } from "@std/assert";
import { handleSyncSettings } from "./handler.ts";
import { signHs256 } from "../_shared/jwt.ts";
import type postgres from "postgres";
import { PgSettingsStore } from "../_shared/pg-settings-store.ts";
import { MAX_SETTINGS_REVISION } from "@still/shared-types";
import { migrateSettingsV2 } from "../../../packages/core/src/storage/settings-v2.ts";
import {
  createSettingsAnchorIdentity,
  issueSettingsAnchorReceipt,
} from "../_shared/settings-anchor.ts";
import type {
  LockedSettingsRow,
  SettingsStore,
} from "../_shared/settings-store.ts";
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const SECRET = "synthetic-settings-jwt-secret-32-characters";
function fixture(raw: unknown = null, revision = 0) {
  const identity = createSettingsAnchorIdentity();
  const row: LockedSettingsRow = {
    anchor: { ...identity, subject: A, revision },
    raw,
    empty: raw === null,
    updatedAt: null,
    writeId: null,
    now: 1770000000000,
    claim: () => Promise.resolve("new"),
    commit: () => Promise.resolve(),
  };
  const subjects: string[] = [];
  const store: SettingsStore = {
    locked: (subject, work) => {
      subjects.push(subject);
      return work(row);
    },
  };
  const deps = {
    jwtSecret: SECRET,
    store,
    limiter: { consume: () => Promise.resolve(0) },
  };
  return { row, deps, subjects, calls: () => subjects.length };
}
async function send(
  body: unknown,
  deps: Parameters<typeof handleSyncSettings>[1],
  subject = A,
) {
  return handleSyncSettings(
    new Request("https://example.test", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await signHs256({ sub: subject }, SECRET)}`,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    deps,
  );
}
async function operation(
  row: LockedSettingsRow,
  override: Record<string, unknown> = {},
) {
  return {
    protocol: 2,
    writeId: crypto.randomUUID(),
    expectedLineage: row.anchor.lineage,
    receipt: await issueSettingsAnchorReceipt(row.anchor),
    operations: [{
      path: "globalOn",
      value: false,
      baseRevision: row.anchor.revision,
      localStep: 1,
    }],
    ...override,
  };
}
Deno.test("authenticated closed read derives subject and exposes receipt, never key", async () => {
  const fx = fixture();
  const response = await send({ protocol: 2, action: "read" }, fx.deps);
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.empty, true);
  assertEquals(result.receipt.revision, 0);
  assertEquals(fx.subjects, [A]);
  assert(!JSON.stringify(result).includes('"key"'));
  assertEquals(
    (await send({ protocol: 2, action: "read", subject: B }, fx.deps)).status,
    400,
  );
});
Deno.test("auth rejects before touching storage", async () => {
  const fx = fixture();
  assertEquals(
    (await handleSyncSettings(
      new Request("https://example.test", { method: "POST", body: "{}" }),
      fx.deps,
    )).status,
    401,
  );
  assertEquals(fx.calls(), 0);
});

Deno.test("aborted stalled authenticated body cancels and releases reader without storage", async () => {
  const fx = fixture();
  const abort = new AbortController();
  let cancelled = false;
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      producer = controller;
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request("https://example.test", {
    method: "POST",
    body: stream,
    signal: abort.signal,
    headers: { authorization: `Bearer ${await signHs256({ sub: A }, SECRET)}` },
  });
  const pending = handleSyncSettings(req, fx.deps);
  const timer = setTimeout(() => abort.abort(), 20);
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    const response = await Promise.race([
      pending,
      new Promise<null>((r) => timeout = setTimeout(() => r(null), 300)),
    ]);
    assert(response, "abort must settle a stalled body");
    assertEquals(response.status, 400);
    assert(cancelled);
    assertEquals(stream.locked, false);
    assertEquals(fx.calls(), 0);
  } finally {
    clearTimeout(timer);
    clearTimeout(timeout);
    if (!cancelled) producer.close();
    await pending;
  }
});
Deno.test("closed body rejection and bounded streaming bytes never reach storage", async () => {
  const fx = fixture();
  for (
    const body of [
      "{",
      " ".repeat(16385),
      { protocol: 2, action: "read", extra: 1 },
      { protocol: 2 },
      { protocol: 2, action: "write" },
    ]
  ) {
    assertEquals((await send(body, fx.deps)).status, 400);
  }
  assertEquals(fx.calls(), 0);
});
Deno.test("real MAC wrong subject, lineage, revision and immutable base fail closed", async () => {
  const fx = fixture();
  const good = await operation(fx.row);
  for (
    const request of [
      { ...good, expectedLineage: crypto.randomUUID() },
      {
        ...good,
        receipt: await issueSettingsAnchorReceipt({
          ...fx.row.anchor,
          subject: B,
        }),
      },
      {
        ...good,
        receipt: await issueSettingsAnchorReceipt({
          ...fx.row.anchor,
          revision: 1,
        }),
      },
      {
        ...good,
        operations: [{
          path: "globalOn",
          value: false,
          baseRevision: 1,
          localStep: 1,
        }],
      },
    ]
  ) assertEquals((await send(request, fx.deps)).status, 409);
  assertEquals((await send(good, fx.deps)).status, 200);
});
Deno.test("atomic operation uses original stamps, exact retry and changed-body conflict", async () => {
  const fx = fixture();
  let commits = 0;
  let body: string | null = null;
  const retained = new Map<string, string>();
  fx.row.claim = (_id, b) => {
    if (retained.has(_id)) {
      return Promise.resolve(
        retained.get(_id) === b ? "duplicate" : "conflict",
      );
    }
    retained.set(_id, b);
    body = b;
    return Promise.resolve("new");
  };
  fx.row.commit = (settings) => {
    commits++;
    assertEquals(settings.clocks.globalOn, { baseRevision: 0, localStep: 1 });
    return Promise.resolve();
  };
  const request = await operation(fx.row);
  assertEquals((await send(request, fx.deps)).status, 200);
  assertEquals((await send(request, fx.deps)).status, 200);
  assertEquals(commits, 1);
  assert(body);
  assertEquals(
    (await send({
      ...request,
      operations: [{ ...request.operations[0], value: true }],
    }, fx.deps)).status,
    409,
  );
});
Deno.test("future/malformed account remains typed hold; storage failures redact details", async () => {
  for (const raw of [{ schemaVersion: 3 }, {}, "broken"]) {
    const fx = fixture(raw, 1);
    const response = await send({ protocol: 2, action: "read" }, fx.deps);
    assertEquals(response.status, 409);
    assertEquals((await response.json()).status, "hold");
  }
  const fx = fixture();
  fx.deps.store.locked = () => {
    throw new Error("private-key SQL body");
  };
  const response = await send({ protocol: 2, action: "read" }, fx.deps);
  assertEquals(response.status, 503);
  assert(!await response.text().then((s) => s.includes("private-key")));
});

Deno.test("forged future revision never becomes valid when canonical revision catches up", async () => {
  const fx = fixture();
  const good = await operation(fx.row);
  const forged = {
    ...good,
    receipt: { ...good.receipt, revision: 1 },
    operations: [{
      path: "globalOn",
      value: false,
      baseRevision: 1,
      localStep: 1,
    }],
  };
  assertEquals((await send(forged, fx.deps)).status, 409);
  Object.assign(fx.row.anchor, { revision: 1 });
  assertEquals((await send(forged, fx.deps)).status, 409);
});

Deno.test("a winning operation preserves opaque supported-schema stamp members", async () => {
  const initial = fixture();
  const response = await send({ protocol: 2, action: "read" }, initial.deps);
  const settings = (await response.json()).settings;
  settings.updatedAt = 1;
  settings.clocks.globalOn.futureStamp = { keep: true };
  const fx = fixture(settings, 0);
  fx.row.commit = (next) => {
    assertEquals(next.clocks.globalOn.futureStamp, { keep: true });
    return Promise.resolve();
  };
  assertEquals((await send(await operation(fx.row), fx.deps)).status, 200);
});

// Exercise the real adapter's transaction callback: returning commits, throwing rolls back.
function transactionalFixture(
  raw: unknown,
  revision: number,
  failCommit = false,
  rawText = JSON.stringify(raw),
  numericSupported = true,
) {
  const fx = fixture(raw, revision);
  let writes = new Map<string, string>();
  let canonical = raw;
  let commits = 0;
  let rollbacks = 0;
  let committedRaw: unknown;
  const sql = {
    async begin<T>(work: (tx: unknown) => Promise<T>) {
      const pending = new Map(writes);
      let next = canonical;
      const tx = (parts: TemplateStringsArray, ...args: unknown[]) => {
        const query = parts.join("?");
        if (query.includes("set_config")) return Promise.resolve([]);
        if (query.includes("lock_settings")) {
          return Promise.resolve([{
            state: {
              lineage: fx.row.anchor.lineage,
              key: Array.from(
                fx.row.anchor.key,
                (v) => v.toString(16).padStart(2, "0"),
              ).join(""),
              revision,
              settings: canonical,
              settings_text: rawText,
              numeric_supported: numericSupported,
              empty: false,
              updated_at: null,
              write_id: null,
              now: fx.row.now,
            },
          }]);
        }
        if (query.includes("claim_settings_write")) {
          const id = args[1] as string;
          const body = args[2] as string;
          const prior = pending.get(id);
          if (prior !== undefined) {
            return Promise.resolve([{
              status: prior === body ? "duplicate" : "conflict",
            }]);
          }
          pending.set(id, body);
          return Promise.resolve([{ status: "new" }]);
        }
        if (query.includes("commit_settings")) {
          committedRaw = args[3];
          if (failCommit) {
            throw Object.assign(new Error("private key SQL parameters"), {
              reason: "bounds",
            });
          }
          next = JSON.parse(args[4] as string);
          commits++;
          return Promise.resolve([]);
        }
        throw new Error("Unexpected fake SQL");
      };
      try {
        const result = await work(tx);
        writes = pending;
        canonical = next;
        return result;
      } catch (error) {
        rollbacks++;
        throw error;
      }
    },
  };
  const store = new PgSettingsStore(
    sql as unknown as ReturnType<typeof postgres>,
  );
  fx.deps.store = store;
  return {
    ...fx,
    store,
    writes: () => writes.size,
    canonical: () => canonical,
    commits: () => commits,
    rollbacks: () => rollbacks,
    committedRaw: () => committedRaw,
  };
}

Deno.test("actual adapter binds original raw numeric JSON to canonical CAS", async () => {
  const rawText = JSON.stringify({ ...validSettings(), future: 0.1 }).replace(
    '"future":0.1',
    '"future":0.100000000000000000000000000001',
  );
  const fx = transactionalFixture(JSON.parse(rawText), 0, false, rawText);
  assertEquals((await send(await operation(fx.row), fx.deps)).status, 200);
  assertEquals(fx.committedRaw(), rawText);
});

Deno.test("database out-of-domain numeric signal remains a typed preserving hold", async () => {
  const rawText = JSON.stringify({ ...validSettings(), future: 0.1 }).replace(
    '"future":0.1',
    '"future":9007199254740991.00000000000000000000001',
  );
  const raw = JSON.parse(rawText);
  const fx = transactionalFixture(raw, 0, false, rawText, false);
  const response = await send({ protocol: 2, action: "read" }, fx.deps);
  assertEquals(response.status, 409);
  assertEquals(await response.json(), { status: "hold", reason: "bounds" });
  assertEquals(fx.canonical(), raw);
  assertEquals(fx.writes(), 0);
  assertEquals(fx.commits(), 0);
});

Deno.test("actual adapter cancels pending query and completes rollback on request abort", async () => {
  const abort = new AbortController();
  let entered!: () => void;
  const began = new Promise<void>((r) => entered = r);
  let rejectQuery!: (error: Error) => void;
  let cancelled = false;
  let rolledBack = false;
  const sql = {
    async begin<T>(work: (tx: unknown) => Promise<T>) {
      const tx = (parts: TemplateStringsArray) => {
        if (parts.join("").includes("set_config")) return Promise.resolve([]);
        const pending = new Promise<unknown[]>((_, reject) =>
          rejectQuery = reject
        );
        Object.assign(pending, {
          cancel() {
            cancelled = true;
            rejectQuery(new Error("private SQL parameters"));
          },
        });
        entered();
        return pending;
      };
      try {
        return await work(tx);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  };
  const store = new PgSettingsStore(
    sql as unknown as ReturnType<typeof postgres>,
  );
  const pending = store.locked(A, () => Promise.resolve(true), abort.signal);
  await began;
  abort.abort();
  let timer!: ReturnType<typeof setTimeout>;
  try {
    const response = await Promise.race([
      pending.catch((e) => e),
      new Promise<null>((r) => timer = setTimeout(() => r(null), 300)),
    ]);
    assert(response instanceof Error, "cancellation must settle the adapter");
    assertEquals(response.message, "Settings storage unavailable");
    assertEquals((response as { code?: unknown }).code, "settings_unavailable");
    assert(cancelled);
    assert(rolledBack);
  } finally {
    clearTimeout(timer);
    if (!cancelled) rejectQuery(new Error("test cleanup"));
    await pending.catch(() => {});
  }
});

Deno.test("body deadline rejects a stalled producer and releases even a never-settled cancel", async () => {
  const fx = fixture();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  const req = new Request("https://example.test", {
    method: "POST",
    body: stream,
    headers: { authorization: `Bearer ${await signHs256({ sub: A }, SECRET)}` },
  });
  assertEquals((await handleSyncSettings(req, fx.deps)).status, 400);
  assert(cancelled);
  assertEquals(stream.locked, false);
  assertEquals(fx.calls(), 0);
});

Deno.test("split chunks enforce bytes and release after producer read/cancel failures", async () => {
  const fx = fixture();
  for (const failRead of [false, true]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        if (failRead) c.error(new Error("private producer error"));
        else {
          c.enqueue(new Uint8Array(8192));
          c.enqueue(new Uint8Array(8193));
        }
      },
      cancel() {
        cancelled = true;
        throw new Error("private cancel error");
      },
    });
    const response = await handleSyncSettings(
      new Request("https://example.test", {
        method: "POST",
        body: stream,
        headers: {
          authorization: `Bearer ${await signHs256({ sub: A }, SECRET)}`,
        },
      }),
      fx.deps,
    );
    assertEquals(response.status, 400);
    assertEquals(stream.locked, false);
    assertEquals(fx.calls(), 0);
    if (!failRead) assert(cancelled);
  }
});

function validSettings() {
  const fresh = migrateSettingsV2(null, { kind: "proven-fresh" });
  if (fresh.status !== "ready") throw new Error("fresh settings");
  return { ...fresh.settings, updatedAt: 1 };
}

Deno.test("postclaim revision hold rolls back identity and exact retries stay held", async () => {
  const raw = validSettings();
  const fx = transactionalFixture(raw, MAX_SETTINGS_REVISION);
  const request = await operation(fx.row);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await send(request, fx.deps);
    assertEquals(response.status, 409);
    assertEquals(await response.json(), {
      status: "hold",
      reason: "revision-saturated",
    });
    assertEquals(fx.writes(), 0);
    assertEquals(fx.canonical(), raw);
  }
  assertEquals(fx.commits(), 0);
  assertEquals(fx.rollbacks(), 2);
});

Deno.test("postclaim merged byte hold rolls back identity and exact retries stay held", async () => {
  const padding: string[] = [];
  const raw = { ...validSettings(), futurePadding: padding };
  while (JSON.stringify(raw).length < 65530) {
    padding.push("");
    padding[padding.length - 1] = "x".repeat(
      Math.min(8192, 65530 - JSON.stringify(raw).length),
    );
  }
  assertEquals(
    migrateSettingsV2(raw, { kind: "readable-local" }).status,
    "ready",
  );
  const fx = transactionalFixture(raw, 0);
  const request = await operation(fx.row);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await send(request, fx.deps);
    assertEquals(response.status, 409);
    assertEquals(await response.json(), { status: "hold", reason: "bounds" });
    assertEquals(fx.writes(), 0);
    assertEquals(fx.canonical(), raw);
  }
  assertEquals(fx.commits(), 0);
  assertEquals(fx.rollbacks(), 2);
});

Deno.test("accepted no-op retains identity at saturation, changed body still conflicts", async () => {
  const raw = validSettings();
  const fx = transactionalFixture(raw, MAX_SETTINGS_REVISION);
  const request = await operation(fx.row, {
    operations: [{
      path: "globalOn",
      value: true,
      baseRevision: 0,
      localStep: 1,
    }],
  });
  // Match an already accepted canonical stamp.
  (raw.clocks as Record<string, unknown>).globalOn = {
    baseRevision: 0,
    localStep: 1,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    assertEquals((await send(request, fx.deps)).status, 200);
    assertEquals(fx.writes(), 1);
    assertEquals(fx.canonical(), raw);
  }
  assertEquals(
    (await send({
      ...request,
      operations: [{ ...request.operations[0], value: false }],
    }, fx.deps)).status,
    409,
  );
  assertEquals(fx.commits(), 0);
  assertEquals(fx.rollbacks(), 0);
  const inferred = await fx.store.locked(
    A,
    () => Promise.resolve(42),
  );
  const checked: number = inferred;
  assertEquals(checked, 42);
});

Deno.test("arbitrary adapter errors roll back and redact even with a hold-like reason", async () => {
  const raw = validSettings();
  const fx = transactionalFixture(raw, 0, true);
  const response = await send(await operation(fx.row), fx.deps);
  assertEquals(response.status, 503);
  assert(!await response.text().then((body) => body.includes("private key")));
  assertEquals(fx.writes(), 0);
  assertEquals(fx.canonical(), raw);
  assertEquals(fx.rollbacks(), 1);
});
