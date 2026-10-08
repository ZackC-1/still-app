import { assertEquals, assertRejects } from "@std/assert";
import { PgQaSandboxMembership } from "./qa-sandbox-auth.ts";

const HOLDER = "11111111-1111-1111-1111-111111111111";
type Sql = ConstructorParameters<typeof PgQaSandboxMembership>[0];

Deno.test("QA membership uses only its fixed RPC and requires a real Boolean", async () => {
  for (const enabled of [true, false]) {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values }); return Promise.resolve([{ enabled }]);
    }) as unknown as Sql;
    assertEquals(await new PgQaSandboxMembership(sql).enabled(HOLDER), enabled);
    assertEquals(calls, [{ text: "select public.qa_sandbox_account_enabled(?::uuid) as enabled", values: [HOLDER] }]);
  }
  for (const rows of [[], [{ enabled: "true" }], [{ enabled: null }], [{ enabled: true }, { enabled: false }]]) {
    await assertRejects(() => new PgQaSandboxMembership((() => Promise.resolve(rows)) as unknown as Sql).enabled(HOLDER));
  }
});

Deno.test("QA membership invalid subjects never reach SQL; errors omit parameter-bearing driver details", async () => {
  let calls = 0;
  const sql = (() => { calls++; return Promise.reject(new Error(`raw driver ${HOLDER}`)); }) as unknown as Sql;
  await assertRejects(() => new PgQaSandboxMembership(sql).enabled("bad"));
  assertEquals(calls, 0);
  const error = await assertRejects(() => new PgQaSandboxMembership(sql).enabled(HOLDER), Error);
  assertEquals(error.message, "QA membership unavailable");
  assertEquals(error.cause, undefined);
  assertEquals(Object.keys(error), ["code"]);
});
