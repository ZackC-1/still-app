import { assertEquals, assertRejects } from "@std/assert";
import { createQaSandboxAccountAuthority, PgQaSandboxMembership, QaSandboxAccountAuthority } from "./qa-sandbox-auth.ts";

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

Deno.test("positive QA preflight requires both live confirmation and enabled membership", async () => {
  for (const confirmed of [true, false]) {
    for (const enabled of [true, false]) {
      const calls: string[] = [];
      const authority = new QaSandboxAccountAuthority(
        { confirmed: (token, holder) => { calls.push(`auth:${token}:${holder}`); return Promise.resolve(confirmed); } },
        { enabled: holder => { calls.push(`membership:${holder}`); return Promise.resolve(enabled); } },
      );
      assertEquals(await authority.canGrant("synthetic-token", HOLDER), confirmed && enabled);
      assertEquals(calls, [`auth:synthetic-token:${HOLDER}`, ...(confirmed ? [`membership:${HOLDER}`] : [])]);
    }
  }
});

Deno.test("disabled QA membership never changes raw live confirmation used before canonical negative evidence", async () => {
  let membershipCalls = 0;
  const accounts = { confirmed: () => Promise.resolve(true) };
  const authority = new QaSandboxAccountAuthority(accounts, { enabled: () => { membershipCalls++; return Promise.resolve(false); } });
  assertEquals(authority.accounts, accounts);
  assertEquals(await authority.accounts.confirmed("synthetic-token", HOLDER), true);
  assertEquals(membershipCalls, 0);
  assertEquals(await authority.canGrant("synthetic-token", HOLDER), false);
  assertEquals(membershipCalls, 1);
});

Deno.test("positive QA preflight fails closed on unknown Auth/membership without manufacturing identity", async () => {
  for (const failAuth of [true, false]) {
    const authority = new QaSandboxAccountAuthority(
      { confirmed: () => failAuth ? Promise.reject(new Error("Auth unavailable")) : Promise.resolve(true) },
      { enabled: () => Promise.reject(new Error("SQL unavailable")) },
    );
    assertEquals(await authority.canGrant("synthetic-token", HOLDER), false);
  }
  let calls = 0;
  const authority = new QaSandboxAccountAuthority({ confirmed: () => { calls++; return Promise.resolve(true); } }, { enabled: () => Promise.resolve(true) });
  assertEquals(await authority.canGrant("", HOLDER), false);
  assertEquals(await authority.canGrant("synthetic-token", "bad"), false);
  assertEquals(calls, 0);
});

Deno.test("QA composition reuses existing project Auth endpoint and keeps confirmation independent of membership", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; authorization: string | null; apiKey: string | null; redirect: RequestRedirect | undefined }[] = [];
  let user: unknown = { id: HOLDER, is_anonymous: false, email_confirmed_at: "2026-10-01T00:00:00Z" };
  globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), authorization: headers.get("authorization"), apiKey: headers.get("apikey"), redirect: init?.redirect });
    return Promise.resolve(Response.json(user));
  };
  try {
    const authority = createQaSandboxAccountAuthority({ supabaseUrl: "https://shared-project.example", publicApiKey: "synthetic-public-key" },
      { enabled: () => Promise.resolve(false) });
    assertEquals(await authority.accounts.confirmed("synthetic-token", HOLDER), true);
    assertEquals(await authority.canGrant("synthetic-token", HOLDER), false);
    assertEquals(calls[0], { url: "https://shared-project.example/auth/v1/user", authorization: "Bearer synthetic-token", apiKey: "synthetic-public-key", redirect: "error" });
    for (const invalid of [{ id: "22222222-2222-2222-2222-222222222222", email_confirmed_at: "2026-10-01" },
      { id: HOLDER, is_anonymous: true, email_confirmed_at: "2026-10-01" }, { id: HOLDER, email_confirmed_at: null }]) {
      user = invalid;
      assertEquals(await authority.accounts.confirmed("synthetic-token", HOLDER), false);
    }
  } finally { globalThis.fetch = originalFetch; }
});
