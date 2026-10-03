import { assert, assertEquals } from "@std/assert";
import { handleSyncSettings } from "./handler.ts";
import { signHs256 } from "../_shared/jwt.ts";
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
  let calls = 0;
  const subjects: string[] = [];
  const store: SettingsStore = {
    locked: (subject, work) => {
      calls++;
      subjects.push(subject);
      return work(row);
    },
  };
  const deps = {
    jwtSecret: SECRET,
    store,
    limiter: { consume: () => Promise.resolve(0) },
  };
  return { row, deps, subjects, calls: () => calls };
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
