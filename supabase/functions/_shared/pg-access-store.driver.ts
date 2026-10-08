import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { PgAccessRightStore } from "./pg-access-store.ts";
type Sql = ConstructorParameters<typeof PgAccessRightStore>[0];
const A = "11111111-1111-1111-1111-111111111111";
const TOKEN = "33333333-3333-3333-3333-333333333333";
// Explicit synthetic options suppress every environment fallback in pinned3.4.9.
// Its maintained constructor still unconditionally reads PGAPPNAME. This fixture
// runs in a required isolated CI step granting ONLY that name, with no network.
const options = {
  host: "127.0.0.1", port: 1, username: "synthetic", password: "synthetic", database: "synthetic",
  max: 1, ssl: false, sslnegotiation: null, idle_timeout: 0, connect_timeout: 1,
  max_lifetime: 0, max_pipeline: 1, backoff: () => 0, keep_alive: 0,
  prepare: false, debug: false, fetch_types: false, publications: "alltables",
  target_session_attrs: "read-write" as const,
};
const driver = postgres(options);

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
