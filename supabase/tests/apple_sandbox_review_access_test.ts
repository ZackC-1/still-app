// Disposable hosted database only; skipped local execution is not database verification.
import { assertEquals, assertRejects } from "@std/assert";
import { connection } from "./synthetic_settings_helpers.ts";
import { PgAppleReviewAccessStore } from "../functions/_shared/apple-review-access-store.ts";
import type { VerifiedAppleTransaction } from "../functions/_shared/apple-access.ts";

const url = Deno.env.get("STILL_PRODUCTION_CHECKOUT_TEST_DATABASE_URL");
Deno.test({ name: "Apple review ledger: no account/revenue writes, role isolation, stale tokens and terminal refund", ignore: !url, fn: async () => {
  if (Deno.env.get("GITHUB_ACTIONS") !== "true" || Deno.env.get("RUNNER_ENVIRONMENT") !== "github-hosted") throw new Error("Disposable hosted runner required");
  const admin = connection(url!);
  let writer: ReturnType<typeof connection> | undefined, qa: ReturnType<typeof connection> | undefined;
  try {
    const gate = await Deno.readTextFile(new URL("../../scripts/backend/deploy/verify/0027_apple_sandbox_review_access.sql", import.meta.url));
    assertEquals((await admin.unsafe(gate))[0]!.issues, []);
    await admin`alter role still_entitlement_writer login password 'production-checkout-synthetic-only'`;
    await admin`alter role still_qa_sandbox_writer login password 'production-checkout-synthetic-only'`;
    writer = connection(url!, "still_entitlement_writer", "production-checkout-synthetic-only");
    qa = connection(url!, "still_qa_sandbox_writer", "production-checkout-synthetic-only");
    const store = new PgAppleReviewAccessStore(writer);
    const tx: VerifiedAppleTransaction = { key: "d".repeat(64), environment: "sandbox", bundleId: "org.example.still",
      productId: "still_pro_v3", originalTransactionId: "987654321", transactionId: "987654321", active: true };
    const counts = async () => (await admin`select
      (select count(*) from private.access_rights) as rights,
      (select count(*) from private.production_purchase_operations) as payments,
      (select count(*) from private.qa_sandbox_purchase_operations) as qa`)[0];
    const before = await counts();
    await assertRejects(() => new PgAppleReviewAccessStore(qa!).begin(tx));
    await assertRejects(() => writer!`select * from private.apple_sandbox_review_access`);
    for (const role of ["anon", "authenticated", "service_role", "still_qa_sandbox_writer", "still_qa_sandbox_owner"]) {
      assertEquals((await admin`select has_function_privilege(${role},'public.begin_apple_sandbox_review_observation(text,text,text,text)','execute') as allowed`)[0]!.allowed, false);
    }
    await assertRejects(() => store.begin({ ...tx, environment: "production" }));
    const first = await store.begin(tx), second = await store.begin(tx);
    assertEquals(await store.commit(tx, first), { status: "stale" });
    const result = await store.commit(tx, second);
    if (!("right" in result)) throw new Error("Expected local review right");
    assertEquals(result.right.holder, result.right.right);
    assertEquals(await store.confirm(tx, second, result.right), true);
    await assertRejects(() => store.commit(tx, second, { holder: crypto.randomUUID(), operation: crypto.randomUUID(), expectedRevision: 0 }));
    await assertRejects(() => store.confirm(tx, second, { ...result.right, holder: crypto.randomUUID() }));
    await assertRejects(() => store.begin({ ...tx, originalTransactionId: "11111" }));
    const third = await store.begin(tx);
    assertEquals(await store.confirm(tx, second, result.right), false);
    assertEquals(await store.commit({ ...tx, active: false }, third), { status: "revoked" });
    const fourth = await store.begin(tx);
    assertEquals(await store.commit(tx, fourth), { status: "revoked" });
    assertEquals(await store.confirm(tx, fourth, result.right), false);
    const negative = { ...tx, key: "e".repeat(64), originalTransactionId: "987654322", active: false };
    const negativeToken = await store.begin(negative);
    assertEquals(await store.commit(negative, negativeToken), { status: "revoked" });
    assertEquals(await store.commit({ ...negative, active: true }, negativeToken), { status: "revoked" });
    const expired = { ...tx, key: "f".repeat(64), originalTransactionId: "987654323" };
    const expiredToken = await store.begin(expired);
    await admin`update private.apple_sandbox_review_access set deadline=clock_timestamp()-interval '1 second' where provider_key=${expired.key}`;
    assertEquals(await store.commit(expired, expiredToken), { status: "stale" });
    assertEquals(await counts(), before);
    assertEquals((await admin.unsafe(gate))[0]!.issues, []);
  } finally { await writer?.end(); await qa?.end(); await admin.end(); }
} });
