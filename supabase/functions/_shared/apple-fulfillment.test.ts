// deno-lint-ignore-file require-await
// Async test ports deliberately match production contracts.
import { assertEquals } from "@std/assert";
import { handleLinkAppleAccess, handleVerifyAppleAccess, HttpConfirmedAppleAccounts, type AppleFulfillmentDeps } from "./apple-fulfillment.ts";
import { signHs256 } from "./jwt.ts";
import { authenticatedClaims } from "./jwt.ts";
import type { AppleAccessLink, AppleAccessCommit } from "./apple-access-store.ts";
import type { VerifiedAppleTransaction } from "./apple-access.ts";

const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222", RIGHT = "33333333-3333-3333-3333-333333333333";
const OP = "44444444-4444-4444-4444-444444444444";
const SECRET = "synthetic-only-apple-test-secret";
const expected = authenticatedClaims("https://synthetic.example.invalid");
const evidence = { bundleId: "com.example.still", productId: "still_pro_v3", signedTransaction: "eyJhbGciOiJFUzI1NiJ9.e30.signature" };
const tx: VerifiedAppleTransaction = { key: "a".repeat(64), environment: "sandbox", bundleId: evidence.bundleId,
  productId: "still_pro_v3", originalTransactionId: "900719925474099312345", transactionId: "12345", active: true };
const userClaims = (holder: string) => ({ sub: holder, exp: Date.now()/1000 + 600, iss: expected.iss, role: "authenticated", aud: "authenticated" });
const token = (holder = A, patch = {}) => signHs256({ ...userClaims(holder), ...patch }, SECRET);
const body = () => ({ intendedAccountId: A, expectedOwnershipRevision: 0, operationId: OP, evidence });
function request(value: unknown, auth?: string, ip = "192.0.2.1") {
  return new Request("https://synthetic.example.invalid/functions/v1/apple", { method: "POST", headers: {
    "content-type": "application/json", ...(ip ? { "x-real-ip": ip } : {}), ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(value) });
}
function setup(transaction: VerifiedAppleTransaction = tx) {
  const calls: string[] = []; let link: AppleAccessLink | undefined;
  const controls = { authentic: true, fresh: true, confirmation: true, confirmedAccount: true, wait: 0, commitStatus: "linked" as AppleAccessCommit["status"], wrongHolder: false, issuerClockOffset: 0 };
  const deps: AppleFulfillmentDeps = { jwtSecret: SECRET, expected,
    limiter: { consume: async () => { calls.push("limit"); return controls.wait; } },
    accounts: { confirmed: async () => { calls.push("account"); return controls.confirmedAccount; } },
    access: { signer: { environment: "sandbox", sign: async (right, kind) => { calls.push("sign"); return JSON.stringify({ right, kind }); },
      signAppleBinding: async b => { calls.push("binding"); return JSON.stringify(b); } },
      verifier: { authenticate: async () => { calls.push("authenticate"); return controls.authentic ? transaction : null; },
        refresh: async () => { calls.push("refresh"); return controls.fresh ? transaction : null; } },
      store: { begin: async () => { calls.push("begin"); return OP; },
        commit: async (_tx, _token, supplied) => {
          calls.push("commit"); link = supplied;
          if (["stale", "owned_elsewhere", "revoked"].includes(controls.commitStatus)) return { status: controls.commitStatus } as AppleAccessCommit;
          return { status: supplied ? controls.commitStatus : "verified", issuer_time: 1000 + controls.issuerClockOffset,
            right: { right: RIGHT, holder: controls.wrongHolder ? B : supplied?.holder ?? RIGHT, revision: supplied ? 1 : 0, verified_at: 1000 } } as AppleAccessCommit;
        }, confirm: async () => { calls.push("confirm"); return controls.confirmation; } } } };
  return { deps, controls, calls, link: () => link };
}
Deno.test("accountless verification signs stable scoped local proof and transaction binding", async () => {
  const s = setup(); const response = await handleVerifyAppleAccess(request({ schema: 1, transaction: evidence }), s.deps);
  const result = await response.json();
  assertEquals(result.status, "verified"); assertEquals(result.localRight, RIGHT);
  assertEquals(JSON.parse(result.proofs[0]).right.holder, RIGHT);
  assertEquals(JSON.parse(result.nativeBinding).originalTransactionId, tx.originalTransactionId);
  assertEquals(s.link(), undefined);
  assertEquals(s.calls, ["limit", "authenticate", "begin", "refresh", "commit", "sign", "binding", "confirm"]);
});
Deno.test("first explicit link returns exact native session contract and derives holder solely from JWT", async () => {
  const s = setup(); const response = await handleLinkAppleAccess(request(body(), await token()), s.deps);
  const result = await response.json();
  assertEquals(Object.keys(result).sort(), ["accountProof", "issuerTime", "localProof", "nativeBinding", "ownershipRevision", "status"]);
  assertEquals(result.status, "linked"); assertEquals(JSON.parse(result.accountProof).right.holder, A);
  assertEquals(JSON.parse(result.localProof).right.holder, RIGHT);
  assertEquals(s.link(), { holder: A, operation: OP, expectedRevision: 0 });
});
Deno.test("family purchase can issue existing local proof/binding but cannot link or transfer account ownership", async () => {
  const family = { ...tx, localOnly: true as const };
  const local = setup(family);
  const result = await (await handleVerifyAppleAccess(request({ schema: 1, transaction: evidence }), local.deps)).json();
  assertEquals(result.status, "verified"); assertEquals(JSON.parse(result.proofs[0]).right.holder, RIGHT);
  for (const value of [body(), { ...body(), sourceAccountId: B, sourceAuthority: await token(B) }]) {
    const link = setup(family);
    assertEquals((await (await handleLinkAppleAccess(request(value, await token()), link.deps)).json()).status, "unavailable");
    assertEquals(link.calls.includes("begin"), false); assertEquals(link.calls.includes("commit"), false);
  }
});
Deno.test("forged, foreign, missing-expiry and anonymous account authority cannot mutate ownership", async t => {
  for (const patch of [{ iss: "https://foreign.example/auth/v1" }, { role: "service_role" }, { aud: "anon" },
    { exp: undefined }, { exp: 1 }, { is_anonymous: true }]) {
    await t.step(JSON.stringify(patch), async () => {
      const s = setup(); const response = await handleLinkAppleAccess(request(body(), await token(A, patch)), s.deps);
      assertEquals([401, 403].includes(response.status), true); assertEquals(s.calls.includes("commit"), false);
    });
  }
  const s = setup(); await handleLinkAppleAccess(request({ ...body(), intendedAccountId: B }, await token()), s.deps);
  assertEquals(s.calls.includes("authenticate"), false);
});
Deno.test("transfer needs two distinct fresh confirmed project account authorities", async t => {
  const first = body();
  await t.step("both authenticated accounts reach explicit CAS transfer", async () => {
    const s = setup(); await handleLinkAppleAccess(request({ ...first, sourceAccountId: B, sourceAuthority: await token(B) }, await token()), s.deps);
    assertEquals(s.link()?.sourceHolder, B);
    assertEquals(s.calls.filter(c => c === "account").length, 4);
  });
  for (const sourceAuthority of [await token(A), await token(B, { iss: "https://other.example/auth/v1" }), await token(B, { exp: 1 }), "forged"]) {
    await t.step("invalid source token", async () => {
      const s = setup(); const response = await handleLinkAppleAccess(request({ ...first, sourceAccountId: B, sourceAuthority }, await token()), s.deps);
      assertEquals(response.status, 403); assertEquals(s.calls.includes("commit"), false);
    });
  }
  await t.step("a supplied source string without its proof is rejected", async () => {
    const s = setup(); const response = await handleLinkAppleAccess(request({ ...first, sourceAccountId: B }, await token()), s.deps);
    assertEquals(response.status, 400); assertEquals(s.calls.includes("commit"), false);
  });
});
Deno.test("conflict/stale/refund/provider ambiguity/signing race return no access authority", async t => {
  for (const status of ["owned_elsewhere", "stale", "revoked"] as const) await t.step(status, async () => {
    const s = setup(); s.controls.commitStatus = status;
    assertEquals((await (await handleLinkAppleAccess(request(body(), await token()), s.deps)).json()).status, status === "revoked" ? "unavailable" : status);
    assertEquals(s.calls.includes("sign"), false);
  });
  for (const control of ["authentic", "fresh", "confirmation"] as const) await t.step(control, async () => {
    const s = setup(); s.controls[control] = false;
    const result = await (await handleVerifyAppleAccess(request({ schema: 1, transaction: evidence }), s.deps)).json();
    assertEquals(["unavailable", "stale"].includes(result.status), true); assertEquals("proofs" in result, false);
  });
  const s = setup(); s.controls.wrongHolder = true;
  assertEquals((await (await handleLinkAppleAccess(request(body(), await token()), s.deps)).json()).status, "unavailable");
  assertEquals(s.calls.includes("sign"), false);
});
Deno.test("input bytes, peer rate limit and missing configuration fail closed before provider work", async t => {
  for (const value of [{ schema: 1, transaction: evidence, environment: "sandbox" }, { schema: 1, transaction: { ...evidence, extra: A } },
    { schema: 1, transaction: { ...evidence, signedTransaction: "x".repeat(40_000) } }]) await t.step("invalid closed request", async () => {
      const s = setup(); assertEquals((await handleVerifyAppleAccess(request(value), s.deps)).status, 400);
      assertEquals(s.calls.includes("authenticate"), false);
    });
  const missing = setup(); await handleVerifyAppleAccess(request({ schema: 1, transaction: evidence }, undefined, ""), missing.deps);
  assertEquals(missing.calls, []);
  const limited = setup(); limited.controls.wait = 30;
  assertEquals((await handleVerifyAppleAccess(request({ schema: 1, transaction: evidence }), limited.deps)).status, 429);
  assertEquals(limited.calls, ["limit"]);
  const s = setup(); assertEquals((await (await handleVerifyAppleAccess(request({ schema: 1, transaction: evidence }), { ...s.deps, access: undefined })).json()).status, "unavailable");
});
Deno.test("live account confirmation binds the intended auth user and fails on unconfirmed/deleted responses", async () => {
  const original = globalThis.fetch; let user: unknown = { id: A, email_confirmed_at: new Date().toISOString(), is_anonymous: false };
  try {
    globalThis.fetch = async (input, init) => {
      assertEquals(input, "https://synthetic.example.invalid/auth/v1/user");
      assertEquals((init?.headers as Record<string,string>).Authorization, "Bearer synthetic-user-token");
      assertEquals(init?.redirect, "error");
      return new Response(JSON.stringify(user), { status: user ? 200 : 401 });
    };
    const accounts = new HttpConfirmedAppleAccounts("https://synthetic.example.invalid", "synthetic-public-key");
    assertEquals(await accounts.confirmed("synthetic-user-token", A), true);
    for (const bad of [{ id: B, email_confirmed_at: new Date().toISOString() }, { id: A },
      { id: A, email_confirmed_at: "nonsense" }, { id: A, email_confirmed_at: new Date().toISOString(), is_anonymous: true }, null]) {
      user = bad; assertEquals(await accounts.confirmed("synthetic-user-token", A), false);
    }
  } finally { globalThis.fetch = original; }
});

Deno.test("account authority lost during provider verification cannot commit a link", async () => {
  const s = setup();
  const deps: AppleFulfillmentDeps = { ...s.deps, access: { ...s.deps.access!, verifier: {
    ...s.deps.access!.verifier, refresh: async () => { s.controls.confirmedAccount = false; return tx; },
  } } };
  const result = await (await handleLinkAppleAccess(request(body(), await token()), deps)).json();
  assertEquals(result.status, "unavailable"); assertEquals(s.calls.includes("commit"), false);
});

Deno.test("stalled body cannot treat partial valid JSON as a completed ownership request", async () => {
  const s = setup(); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ schema: 1, transaction: evidence })));
  }, cancel() { cancelled = true; return new Promise(() => {}); } });
  const req = new Request("https://synthetic.example.invalid/apple", { method: "POST", headers: { "x-real-ip": "192.0.2.1" }, body: stream });
  assertEquals((await handleVerifyAppleAccess(req, s.deps)).status, 400);
  assertEquals(cancelled, true); assertEquals(s.calls.includes("authenticate"), false);
});

Deno.test("verified refund persists without stale link authority and never grants", async () => {
  for (const transfer of [false, true]) {
    const s = setup(); s.controls.commitStatus = "revoked";
    const deps: AppleFulfillmentDeps = { ...s.deps, access: { ...s.deps.access!, verifier: {
      ...s.deps.access!.verifier, refresh: async () => { s.controls.confirmedAccount = false; return { ...tx, active: false }; },
    } } };
    const value = transfer ? { ...body(), sourceAccountId: B, sourceAuthority: await token(B) } : body();
    assertEquals(await (await handleLinkAppleAccess(request(value, await token()), deps)).json(), { status: "unavailable" });
    assertEquals(s.calls.includes("commit"), true); assertEquals(s.link(), undefined);
    assertEquals(s.calls.includes("sign"), false); assertEquals(s.calls.includes("binding"), false);
  }
  const wrongScope = setup(); wrongScope.controls.commitStatus = "revoked";
  const deps = { ...wrongScope.deps, access: { ...wrongScope.deps.access!, verifier: {
    ...wrongScope.deps.access!.verifier, refresh: async () => ({ ...tx, active: false, key: "b".repeat(64) }),
  } } };
  await handleLinkAppleAccess(request(body(), await token()), deps);
  assertEquals(wrongScope.calls.includes("commit"), false);
});
Deno.test("Apple issuer clock must equal the freshly verified right clock before any signing", async () => {
  for (const offset of [-1, 1]) {
    for (const link of [false, true]) {
      const s = setup(); s.controls.issuerClockOffset = offset;
      const result = link ? await handleLinkAppleAccess(request(body(), await token()), s.deps) : await handleVerifyAppleAccess(request({ schema: 1, transaction: evidence }), s.deps);
      assertEquals(await result.json(), { status: "unavailable" }); assertEquals(s.calls.includes("sign"), false);
    }
  }
});
