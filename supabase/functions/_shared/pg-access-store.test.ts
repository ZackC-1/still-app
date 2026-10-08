import postgres from "postgres";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { PgAccessRightStore } from "./pg-access-store.ts";
type Sql = ConstructorParameters<typeof PgAccessRightStore>[0];
const A = "11111111-1111-1111-1111-111111111111";
const TOKEN = "33333333-3333-3333-3333-333333333333";
const driver = postgres({ max: 1 });
const sql = (rows: unknown[]) => Object.assign(() => Promise.resolve(rows), { json: driver.json }) as unknown as Sql;

Deno.test("missing/malformed observation receipt cannot authorize a provider lookup", async () => {
  for (const rows of [[], [{ token: null }], [{ token: "anything" }]]) {
    await assertRejects(() => new PgAccessRightStore(sql(rows)).begin(A, "sandbox"));
  }
  assertEquals(await new PgAccessRightStore(sql([{ token: TOKEN }])).begin(A, "sandbox"), TOKEN);
});
Deno.test("malformed commit receipt and wrong holder cannot escape the server adapter", async () => {
  for (const result of [null, { status: "success" }, { status: "committed", rights: [], issuer_time: -1, revocations: [] },
    { status: "committed", rights: [{ holder: TOKEN }], issuer_time: 1000, revocations: [] }]) {
    await assertRejects(() => new PgAccessRightStore(sql([{ result }])).commit(A, "sandbox", TOKEN, []));
  }
});
Deno.test("confirmation must be an actual Boolean, never missing/truthy data", async () => {
  for (const rows of [[], [{ confirmed: "true" }]]) {
    await assertRejects(() => new PgAccessRightStore(sql(rows)).confirm(A, "sandbox", TOKEN));
  }
  assertEquals(await new PgAccessRightStore(sql([{ confirmed: false }])).confirm(A, "sandbox", TOKEN), false);
});
Deno.test("current provider receipts must be an exact subset of committed account/revision/time rows", async () => {
  const right = { right: TOKEN, holder: A, revision: 1, verified_at: 1000 };
  for (const observed of [{ ...right, holder: TOKEN }, { ...right, revision: 0 }, { ...right, verified_at: 999 }]) {
    const result = { status: "committed", rights: [right], observed_rights: [observed], issuer_time: 1000, revocations: [] };
    await assertRejects(() => new PgAccessRightStore(sql([{ result }])).commit(A, "sandbox", TOKEN, []));
  }
  const result = { status: "committed" as const, rights: [right], observed_rights: [right], issuer_time: 1000, revocations: [] };
  assertEquals(await new PgAccessRightStore(sql([{ result }])).commit(A, "sandbox", TOKEN, []), result);
});

Deno.test("removal-only RPC validates account/environment, exact closed metadata and current-token null outcome", async () => {
  const valid = { holder: A, environment: "sandbox" as const, issuer_time: 1000, revocations: [{ right: TOKEN, revision: 2 }] };
  assertEquals(await new PgAccessRightStore(sql([{ result: valid }])).removals(A, "sandbox", TOKEN), valid);
  assertEquals(await new PgAccessRightStore(sql([{ result: null }])).removals(A, "sandbox", TOKEN), null);
  for (const result of [undefined, { ...valid, holder: TOKEN }, { ...valid, environment: "production" },
    { ...valid, issuer_time: -1 }, { ...valid, proofs: [] }, { ...valid, revocations: [] },
    { ...valid, revocations: [{ right: TOKEN, revision: -1 }] },
    { ...valid, revocations: [valid.revocations[0], valid.revocations[0]] },
    { ...valid, revocations: [{ right: TOKEN, revision: 2, extra: true }] }]) {
    await assertRejects(() => new PgAccessRightStore(sql([{ result }])).removals(A, "sandbox", TOKEN));
  }
});

Deno.test("provider snapshot reaches the pinned driver as a JSON array, without double encoding", async () => {
  for (
    const rights of [
      [],
      [{ key: "a".repeat(64), product: "still_pro_v3" as const }],
      [{ key: "a".repeat(64), product: "still_pro_v3" as const, state: "revoked" as const }],
      [{ key: "a".repeat(64), product: "still_pro_v3" as const },
        { key: "b".repeat(64), product: "still_pro_v3" as const, state: "revoked" as const }],
    ]
  ) {
    let bound: unknown;
    const session = Object.assign(
      (_strings: TemplateStringsArray, ...values: unknown[]) => {
        bound = values[3];
        return Promise.resolve([{
          result: {
            status: "committed",
            rights: [],
            revocations: [],
            issuer_time: 1000,
          },
        }]);
      },
      { json: driver.json },
    ) as unknown as Sql;
    await new PgAccessRightStore(session).commit(A, "sandbox", TOKEN, rights);
    const parameter = bound as { type?: number; value?: unknown };
    // Use the actual pinned driver's JSONB serializer, as Bind does after ParameterDescription.
    const actualValue =
      typeof bound === "object" && bound !== null && "value" in bound
        ? parameter.value
        : bound;
    const serialize = driver.options.serializers[3802]!;
    const wire = serialize(actualValue);
    assert(typeof wire === "string");
    const decoded: unknown = JSON.parse(wire);
    assert(Array.isArray(decoded), "snapshot JSONB must be an array");
    assertEquals(decoded, rights);
    assertEquals(parameter.type, 3802);
    // Negative control: a pre-serialized string is serialized again by this same driver.
    const wrongWire = serialize(JSON.stringify(rights));
    assert(typeof wrongWire === "string");
    assertEquals(typeof JSON.parse(wrongWire), "string");
  }
});
