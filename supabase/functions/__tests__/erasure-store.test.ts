// D8: the account pre-step's answer is parsed strictly. A fake driver, no database.
import { assertEquals, assertRejects } from "@std/assert";
import { ErasureStorageUnavailable, PgErasureStore } from "../_shared/erasure-store.ts";

const A = "11111111-1111-4111-8111-111111111111";

/** A tagged-template stand-in for the postgres driver that answers one fixed value. */
function answering(value: unknown, seen: unknown[][] = []) {
  const sql = (_strings: TemplateStringsArray, ...params: unknown[]) => {
    seen.push(params);
    return Promise.resolve([{ value }]);
  };
  return new PgErasureStore(sql as unknown as ConstructorParameters<typeof PgErasureStore>[0]);
}

Deno.test("D8: beginAccountErasure accepts only {captured, n >= 0} or {gone}", async () => {
  const seen: unknown[][] = [];
  assertEquals(await answering({ state: "captured", subjects: 2 }, seen).beginAccountErasure(A, "account_deleted"), {
    state: "captured",
    subjects: 2,
  });
  assertEquals(seen, [[A, "account_deleted"]]);
  assertEquals(await answering({ state: "captured", subjects: 0 }).beginAccountErasure(A, "account_erasure"), {
    state: "captured",
    subjects: 0,
  });
  assertEquals(await answering({ state: "gone" }).beginAccountErasure(A, "account_deleted"), { state: "gone" });
  // NEGATIVE CONTROLS: a capture without its count, a negative or fractional count, an extra or
  // unknown field, another state, or no object at all is a storage failure, never a capture.
  for (
    const bad of [
      { state: "captured" },
      { state: "captured", subjects: -1 },
      { state: "captured", subjects: 1.5 },
      { state: "captured", subjects: "2" },
      { state: "captured", subjects: 2, account: A },
      { state: "gone", subjects: 0 },
      { state: "stopped" },
      [],
      null,
      "captured",
    ]
  ) {
    await assertRejects(
      () => answering(bad).beginAccountErasure(A, "account_deleted"),
      ErasureStorageUnavailable,
      undefined,
      JSON.stringify(bad),
    );
  }
});

Deno.test("D8: accountErasureStatus accepts only a known stage or null", async () => {
  assertEquals(await answering({ stage: null }).accountErasureStatus(A), null);
  assertEquals(await answering({ stage: "provider_delete_accepted" }).accountErasureStatus(A), "provider_delete_accepted");
  for (const bad of [{ stage: "done" }, {}, { stage: null, job: A }, null]) {
    await assertRejects(() => answering(bad).accountErasureStatus(A), ErasureStorageUnavailable);
  }
});

Deno.test("D8: a driver failure carries no detail", async () => {
  const sql = () => Promise.reject(new Error(`connection to ${A} refused`));
  const store = new PgErasureStore(sql as unknown as ConstructorParameters<typeof PgErasureStore>[0]);
  const error = await assertRejects(() => store.beginAccountErasure(A, "account_deleted"), ErasureStorageUnavailable);
  assertEquals(error.message, "Analytics erasure storage unavailable");
});
