import { assert, assertEquals } from "@std/assert";
import { createQaSandboxRuntime, handleQaSandboxReconcile, handleQaSandboxUnavailable, readQaSandboxRuntime } from "./qa-sandbox-runtime.ts";
import { handleLinkAppleAccess, handleVerifyAppleAccess } from "./apple-fulfillment.ts";
import { readQaSandboxAppleConfig } from "./qa-sandbox-config.ts";
import { signHs256, authenticatedClaims } from "./jwt.ts";
import { HttpRevenueCatAccessClient, type ProviderAccess } from "./revenuecat-access.ts";
import type { VerifiedAppleTransaction } from "./apple-access.ts";
import type { QaSandboxRuntimePorts } from "./qa-sandbox-runtime.ts";
import type { ProviderRight } from "./access-issuer.ts";

const A = "11111111-1111-1111-1111-111111111111", RIGHT = "22222222-2222-2222-2222-222222222222";
const OBS = "33333333-3333-3333-3333-333333333333", OP = "44444444-4444-4444-4444-444444444444";
const SECRET = "synthetic-only-qa-jwt-secret", URL = "https://project.example.test";
const evidence = { bundleId: "com.example.still", productId: "still_pro_v3", signedTransaction: "eyJhbGciOiJFUzI1NiJ9.e30.signature" };
const TX: VerifiedAppleTransaction = { key: "a".repeat(64), environment: "sandbox", bundleId: evidence.bundleId,
  productId: "still_pro_v3", originalTransactionId: "123456", transactionId: "123457", active: true };
const decode = (text: string) => atob(text.replace(/-/g, "+").replace(/_/g, "/"));
const b64 = (buffer: ArrayBuffer) => btoa(Array.from(new Uint8Array(buffer), b => String.fromCharCode(b)).join(""));
async function inputs(): Promise<Record<string,string>> {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]); assert("privateKey" in keys);
  const api = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { SUPABASE_URL: URL, SUPABASE_ANON_KEY: "synthetic-public", SUPABASE_JWT_SECRET: SECRET,
    STILL_QA_SANDBOX_ENTITLEMENT_WRITER_DB_URL: "postgres://still_qa_sandbox_writer:synthetic@db.example.test/postgres",
    STILL_QA_SANDBOX_ACCESS_PROOF_KEY_ID: "qa-synthetic",
    STILL_QA_SANDBOX_ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64: b64(await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
    STILL_QA_SANDBOX_ACCESS_PROOF_PUBLIC_KEY_HEX: Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)), b => b.toString(16).padStart(2,"0")).join(""),
    STILL_QA_SANDBOX_ACCESS_APPLE_PRODUCTS_JSON: JSON.stringify([{ bundleId: evidence.bundleId, appAppleId: 1234, productId: "still_pro_v3" }]),
    STILL_QA_SANDBOX_APP_STORE_SERVER_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${b64(await crypto.subtle.exportKey("pkcs8", api.privateKey))}\n-----END PRIVATE KEY-----`,
    STILL_QA_SANDBOX_APP_STORE_SERVER_KEY_ID: "TESTKEY123",
    STILL_QA_SANDBOX_APP_STORE_SERVER_ISSUER_ID: A,
    STILL_QA_SANDBOX_REVENUECAT_PROJECT_ID: "proj_qa",
    STILL_QA_SANDBOX_REVENUECAT_ACCESS_SECRET_API_KEY: "synthetic-qa-only",
    STILL_QA_SANDBOX_ACCESS_PROVIDER_PRODUCTS_JSON: JSON.stringify([{ product_id: "prod_qa", app_id: "app_qa",
      store_identifier: "still_pro_v3", entitlement_lookup_key: "still_pro_v3", store: "rc_billing" }]),
  };
}
function request(jwt?: string, body: unknown = { access_schema: 1 }): Request {
  return new Request(`${URL}/functions/v1/qa`, { method: "POST", headers: { "content-type": "application/json",
    "x-real-ip": "192.0.2.1", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) }, body: JSON.stringify(body) });
}
function token(patch: Record<string,unknown> = {}) { return signHs256({ sub: A, ...authenticatedClaims(URL),
  exp: Math.floor(Date.now()/1000) + 600, ...patch }, SECRET); }
async function setup() {
  const values = await inputs(); const config = await readQaSandboxAppleConfig(name => values[name]); assert(config);
  const calls: { rpc: string; values: unknown[] }[] = [];
  const state = { enabled: true, confirmed: true, fence: true, negative: false, localRefund: false,
    providerFails: false, providerThrow: false, linked: false, appleFails: false, productionTx: false, membershipFails: false, ledgerEmpty: false };
  const now = Date.now(); const right = { right: RIGHT, holder: A, revision: 1, verified_at: now };
  const revoked = [{ right: RIGHT, revision: 2 }];
  const sql = Object.assign((strings: TemplateStringsArray, ...parameters: unknown[]) => {
    const rpc = /public\.([a-z_]+)\(/.exec(strings.join("?"))?.[1] ?? "unknown";
    calls.push({ rpc, values: parameters });
    if (!rpc.startsWith("qa_sandbox_")) throw new Error("Production SQL invoked");
    if (rpc === "qa_sandbox_consume_rate_limit") return Promise.resolve([{ wait: 0 }]);
    if (rpc === "qa_sandbox_account_enabled") return state.membershipFails ? Promise.reject(new Error("unavailable")) : Promise.resolve([{ enabled: state.enabled }]);
    if (rpc.includes("begin_")) return Promise.resolve([{ token: OBS }]);
    if (rpc === "qa_sandbox_read_linked_apple_transactions") return Promise.resolve([{ result: state.linked ? [{ ...TX, transactionId: TX.originalTransactionId }] : [] }]);
    if (rpc === "qa_sandbox_commit_apple_local") {
      if (parameters[2] === false) { state.localRefund = true; return Promise.resolve([{ result: { status: "revoked" } }]); }
      return Promise.resolve([{ result: { status: "verified", right: { ...right, holder: RIGHT }, issuer_time: now } }]);
    }
    if (rpc === "qa_sandbox_commit_apple_link") return Promise.resolve([{ result: { status: state.enabled ? "linked" : "stale", right, issuer_time: now } }]);
    if (rpc === "qa_sandbox_commit_access_observation") {
      const rights = parameters[2] as ProviderRight[];
      const removals = state.localRefund || rights.some(r => r.state === "revoked");
      return Promise.resolve([{ result: { status: "committed", rights: removals || (state.ledgerEmpty && !rights.length) ? [] : [right],
        observed_rights: removals || !rights.length ? [] : [right], revocations: removals ? revoked : [], issuer_time: now } }]);
    }
    if (rpc === "qa_sandbox_read_access_removals") return Promise.resolve([{ result: state.negative || state.localRefund
      ? { holder: A, environment: "sandbox", revocations: revoked, issuer_time: now } : null }]);
    if (rpc.includes("confirm_")) return Promise.resolve([{ confirmed: state.fence && (rpc.endsWith("apple_local") || state.enabled) }]);
    throw new Error(`Unexpected QA RPC ${rpc}`);
  }, { json: (value: unknown) => value }) as unknown as QaSandboxRuntimePorts["sql"];
  const provider = { getRights: (): Promise<ProviderAccess> => {
    if (state.providerThrow) return Promise.reject(new Error("provider unavailable"));
    return Promise.resolve(state.providerFails ? { status: "unavailable" } : { status: "verified", rights: [
      { key: "b".repeat(64), product: "still_pro_v3", ...(state.negative ? { state: "revoked" as const } : {}) }] });
  } };
  const verifier = { authenticate: () => Promise.resolve(state.productionTx ? { ...TX, environment: "production" as const } : TX),
    refresh: (tx: VerifiedAppleTransaction) => Promise.resolve(state.appleFails ? null : { ...tx, active: !state.negative }) };
  const runtime = await createQaSandboxRuntime(config, { sql, provider, appleVerifier: verifier,
    accounts: { confirmed: () => Promise.resolve(state.confirmed) } });
  return { runtime, state, calls, values, sql, config, verifier };
}

Deno.test("composed QA accountless Apple verification uses local sandbox RPCs and real signed proofs", async () => {
  const s = await setup(); s.state.confirmed = false; s.state.enabled = false;
  const result = await (await handleVerifyAppleAccess(request(undefined, { schema: 1, transaction: evidence }), s.runtime.apple)).json();
  assertEquals(result.status, "verified"); assertEquals(result.proofs.length, 1);
  const claims = JSON.parse(decode(JSON.parse(result.proofs[0]).payload));
  assertEquals([claims.environment, claims.holder, claims.kind], ["sandbox", RIGHT, "paid_apple_local"]);
  const envelope = JSON.parse(result.proofs[0]);
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(s.values.STILL_QA_SANDBOX_ACCESS_PROOF_PUBLIC_KEY_HEX.match(/../g)!, b => parseInt(b,16)), "Ed25519", false, ["verify"]);
  const signature = Uint8Array.from(decode(envelope.signature), b => b.charCodeAt(0));
  assert(await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode("still-access-proof-v1\n" + decode(envelope.payload))));
  assertEquals(s.calls.some(call => call.rpc.includes("account") || call.rpc.includes("link")), false);
});
Deno.test("composed QA explicit Apple link uses verified subject and account RPC; sign-in alone never links", async () => {
  const s = await setup(); const jwt = await token();
  await handleQaSandboxReconcile(request(jwt), s.runtime.reconcile);
  assertEquals(s.calls.some(call => call.rpc === "qa_sandbox_commit_apple_link"), false);
  const result = await (await handleLinkAppleAccess(request(jwt, { intendedAccountId: A, expectedOwnershipRevision: 0, operationId: OP, evidence }), s.runtime.apple)).json();
  assertEquals(result.status, "linked"); assertEquals(s.calls.find(call => call.rpc === "qa_sandbox_commit_apple_link")?.values, [TX.key, OBS, true, A, OP, 0, null]);
  assertEquals(JSON.parse(decode(JSON.parse(result.accountProof).payload)).holder, A);
});
Deno.test("composed QA rejects legacy/client-selected reconciliation and missing JWT before provider writes", async () => {
  for (const body of [{}, { access_schema: 1, holder: A }, { access_schema: 1, environment: "production" }]) {
    const s = await setup(); assertEquals((await handleQaSandboxReconcile(request(await token(), body), s.runtime.reconcile)).status, 400);
    assertEquals(s.calls.some(call => call.rpc.includes("begin") || call.rpc.includes("commit")), false);
  }
  const s = await setup(); assertEquals((await handleQaSandboxReconcile(request(), s.runtime.reconcile)).status, 401); assertEquals(s.calls, []);
});
Deno.test("QA reconciliation derives subject, issues current sandbox account proof and has no Boolean projection", async () => {
  const s = await setup(); const result = await (await handleQaSandboxReconcile(request(await token()), s.runtime.reconcile)).json();
  assertEquals(Object.keys(result), ["access"]); assertEquals(result.access.status, "verified");
  assertEquals(JSON.parse(decode(JSON.parse(result.access.proofs[0]).payload)).holder, A);
  assertEquals(s.calls.find(call => call.rpc === "qa_sandbox_begin_access_observation")?.values, [A]);
});
Deno.test("disabled QA filters positives and returns known canonical refunds without positive confirmation", async () => {
  const s = await setup(); s.state.enabled = false; s.state.negative = true;
  const result = await (await handleQaSandboxReconcile(request(await token()), s.runtime.reconcile)).json();
  assertEquals(result.access.status, "unavailable"); assertEquals(result.access.proofs, []); assertEquals(result.access.revocations, [{ right: RIGHT, revision: 2 }]);
  assertEquals((s.calls.find(call => call.rpc === "qa_sandbox_commit_access_observation")?.values[2] as ProviderRight[])[0]?.state, "revoked");
  const positive = await setup(); positive.state.enabled = false;
  assertEquals((await (await handleQaSandboxReconcile(request(await token()), positive.runtime.reconcile)).json()).access, { status: "unavailable" });
  assertEquals(positive.calls.find(call => call.rpc === "qa_sandbox_commit_access_observation")?.values[2], []);
});
Deno.test("membership outage withholds grants while canonical negatives still commit", async () => {
  const s = await setup(); s.state.membershipFails = true; s.state.negative = true;
  const result = await (await handleQaSandboxReconcile(request(await token()), s.runtime.reconcile)).json();
  assertEquals(result.access.proofs, []); assertEquals(result.access.revocations.length, 1);
  assertEquals((s.calls.find(call => call.rpc === "qa_sandbox_commit_access_observation")?.values[2] as ProviderRight[])[0]?.state, "revoked");
});
Deno.test("one failed QA provider cannot suppress another linked Apple canonical refund", async () => {
  const s = await setup(); s.state.providerThrow = true; s.state.linked = true; s.state.negative = true; s.state.enabled = false;
  const result = await (await handleQaSandboxReconcile(request(await token()), s.runtime.reconcile)).json();
  assertEquals(s.state.localRefund, true); assertEquals(result.access.proofs, []); assertEquals(result.access.revocations.length, 1);
});
Deno.test("QA final SQL fence and live account loss during signing withhold all authority", async () => {
  for (const control of ["fence", "confirmed", "enabled"] as const) {
    const s = await setup(); const access = s.runtime.reconcile.access!; const original = access.signer.sign;
    const deps = { ...s.runtime.reconcile, access: { ...access, signer: { ...access.signer, async sign(...args: Parameters<typeof original>) {
      const proof = await original(...args); s.state[control] = false; return proof;
    } } } };
    const result = await (await handleQaSandboxReconcile(request(await token()), deps)).json();
    assertEquals(result.access, { status: "unavailable" });
  }
});
Deno.test("QA expired JWT after provider latency and wrong-environment Apple transaction cannot grant", async () => {
  const s = await setup(); s.state.productionTx = true;
  assertEquals(await (await handleVerifyAppleAccess(request(undefined, { schema: 1, transaction: evidence }), s.runtime.apple)).json(), { status: "unavailable" });
  assertEquals(s.calls.some(c => c.rpc.includes("begin")), false);
  const q = await setup(); const old = Date.now; const start = old(); const jwt = await token();
  const access = q.runtime.reconcile.access!;
  const deps = { ...q.runtime.reconcile, access: { ...access, provider: { getRights() {
    Date.now = () => start + 601_000; return Promise.resolve({ status: "verified" as const, rights: [{ key: "b".repeat(64), product: "still_pro_v3" as const }] });
  } } } };
  try { assertEquals((await (await handleQaSandboxReconcile(request(jwt), deps)).json()).access, { status: "unavailable" });
    assertEquals(q.calls.find(c => c.rpc === "qa_sandbox_commit_access_observation")?.values[2], []); }
  finally { Date.now = old; }
});
Deno.test("runtime reader uses only prefixed provider config and never falls back to legacy/live secrets", async () => {
  const s = await setup(); const names: string[] = [];
  const runtime = await readQaSandboxRuntime(name => { names.push(name); return s.values[name]; }, url => { assertEquals(url, s.config.writerDbUrl); return s.sql; }); assert(runtime);
  assertEquals(names.filter(name => name.includes("REVENUECAT") || name.includes("PROVIDER_PRODUCTS")).sort(), [
    "STILL_QA_SANDBOX_ACCESS_PROVIDER_PRODUCTS_JSON", "STILL_QA_SANDBOX_REVENUECAT_ACCESS_SECRET_API_KEY", "STILL_QA_SANDBOX_REVENUECAT_PROJECT_ID"].sort());
  delete s.values.STILL_QA_SANDBOX_REVENUECAT_ACCESS_SECRET_API_KEY;
  s.values.REVENUECAT_ACCESS_SECRET_API_KEY = "live-must-not-fallback";
  const missing = await readQaSandboxRuntime(name => s.values[name], () => s.sql); assert(missing);
  assertEquals(await missing.reconcile.access?.provider.getRights(A, "sandbox"), { status: "unavailable" }); assert(missing.apple.access);
  delete s.values.STILL_QA_SANDBOX_ACCESS_PROOF_KEY_ID;
  assertEquals(await readQaSandboxRuntime(name => s.values[name], () => { throw new Error("Must not open DB"); }), null);
});
Deno.test("actual composed HTTP RevenueCat client uses sandbox purchases and rejects wrong environment", async () => {
  const s = await setup(); const original = globalThis.fetch; let wrong = false;
  globalThis.fetch = (input, init) => {
    assertEquals(input, `https://api.revenuecat.com/v2/projects/proj_qa/customers/${A}/purchases?environment=sandbox&limit=100`);
    assertEquals((init?.headers as Record<string,string>).Authorization, "Bearer synthetic-qa-only");
    return Promise.resolve(new Response(JSON.stringify({ object: "list", next_page: null, items: [{ object: "purchase", id: "purch_qa", customer_id: A,
      environment: wrong ? "production" : "sandbox", product_id: "prod_qa", store: "rc_billing", status: "owned", ownership: "purchased", purchased_at: 1000,
      revenue_in_usd: { currency: "USD", gross: 9.99 }, entitlements: { object: "list", next_page: null, items: [{ object: "entitlement", state: "active",
        project_id: "proj_qa", lookup_key: "still_pro_v3", products: { object: "list", next_page: null, items: [{ object: "product", id: "prod_qa", state: "active",
          app_id: "app_qa", store_identifier: "still_pro_v3", type: "one_time", one_time: { is_consumable: false } }] } }] } }] })));
  };
  try {
    const provider = new HttpRevenueCatAccessClient("synthetic-qa-only", "proj_qa", JSON.parse(s.values.STILL_QA_SANDBOX_ACCESS_PROVIDER_PRODUCTS_JSON));
    const runtime = await createQaSandboxRuntime(s.config, { sql: s.sql, provider, appleVerifier: s.verifier, accounts: { confirmed: () => Promise.resolve(true) } });
    assertEquals((await (await handleQaSandboxReconcile(request(await token()), runtime.reconcile)).json()).access.status, "verified");
    wrong = true;
    assertEquals((await (await handleQaSandboxReconcile(request(await token()), runtime.reconcile)).json()).access, { status: "unavailable" });
  } finally { globalThis.fetch = original; }
});
Deno.test("QA reconcile answers verified-none for a never-purchased account only on RevenueCat's customer-missing 404", async () => {
  const original = globalThis.fetch;
  const run = async (body: string | null, patch: Partial<Awaited<ReturnType<typeof setup>>["state"]> = { ledgerEmpty: true }) => {
    const s = await setup(); Object.assign(s.state, patch); const urls: unknown[] = [];
    globalThis.fetch = (input) => { urls.push(input); return Promise.resolve(new Response(body, { status: 404 })); };
    const provider = new HttpRevenueCatAccessClient("synthetic-qa-only", "proj_qa", JSON.parse(s.values.STILL_QA_SANDBOX_ACCESS_PROVIDER_PRODUCTS_JSON));
    const runtime = await createQaSandboxRuntime(s.config, { sql: s.sql, provider, appleVerifier: s.verifier, accounts: { confirmed: () => Promise.resolve(s.state.confirmed) } });
    const response = await handleQaSandboxReconcile(request(await token()), runtime.reconcile);
    return { status: response.status, result: await response.json(), urls, s };
  };
  const missing = JSON.stringify({ object: "error", type: "resource_missing", message: "Customer not found", retryable: false });
  try {
    const none = await run(missing);
    assertEquals(none.status, 200);
    assertEquals(none.result.access.status, "none"); assertEquals(none.result.access.environment, "sandbox");
    assertEquals(none.result.access.proofs, []);
    // Bound to the JWT subject: the provider read, the observation and the final fence all name A.
    assertEquals(none.urls, [`https://api.revenuecat.com/v2/projects/proj_qa/customers/${A}/purchases?environment=sandbox&limit=100`]);
    assertEquals(none.s.calls.find(call => call.rpc === "qa_sandbox_commit_access_observation")?.values.slice(0, 3), [A, OBS, []]);
    assertEquals(none.s.calls.some(call => call.rpc === "qa_sandbox_confirm_access_observation"), true);
    // Any other 404 body stays unavailable exactly as before.
    for (const body of [null, "{}", JSON.stringify({ type: "parameter_error" }), JSON.stringify({ type: "resource_missing", param: "project_id" })]) {
      assertEquals((await run(body)).result.access, { status: "unavailable" }, String(body));
    }
    // An account with any recorded right is never told "none" by a provider 404.
    assertEquals((await run(missing, { ledgerEmpty: false })).result.access.status, "unavailable");
    // Losing the account binding (final fence, live confirmation) withholds the answer entirely.
    assertEquals((await run(missing, { ledgerEmpty: true, fence: false })).result.access, { status: "unavailable" });
    const unconfirmed = await run(missing, { ledgerEmpty: true, confirmed: false });
    assertEquals(unconfirmed.status, 403); assertEquals(unconfirmed.urls, []);
  } finally { globalThis.fetch = original; }
});

Deno.test("missing RC configuration leaves linked Apple current verification and canonical refunds independent", async () => {
  const s = await setup(); delete s.values.STILL_QA_SANDBOX_REVENUECAT_ACCESS_SECRET_API_KEY;
  const read = await readQaSandboxRuntime(name => s.values[name], () => s.sql); assert(read?.reconcile.access);
  const runtime = await createQaSandboxRuntime(s.config, { sql: s.sql, appleVerifier: s.verifier,
    accounts: { confirmed: () => Promise.resolve(true) } });
  s.state.linked = true;
  assertEquals((await (await handleQaSandboxReconcile(request(await token()), runtime.reconcile)).json()).access.status, "verified");
  s.state.negative = true; s.state.enabled = false;
  const result = await (await handleQaSandboxReconcile(request(await token()), runtime.reconcile)).json();
  assertEquals(result.access.proofs, []); assertEquals(result.access.revocations.length, 1);
});
Deno.test("disabled mixed provider snapshot drops active rights while preserving only canonical revoked identity", async () => {
  const s = await setup(); s.state.enabled = false; s.state.negative = true;
  const access = s.runtime.reconcile.access!;
  const deps = { ...s.runtime.reconcile, access: { ...access, provider: { getRights: () => Promise.resolve({ status: "verified" as const,
    rights: [{ key: "b".repeat(64), product: "still_pro_v3" as const }, { key: "c".repeat(64), product: "still_pro_v3" as const, state: "revoked" as const }] }) } } };
  const result = await (await handleQaSandboxReconcile(request(await token()), deps)).json();
  assertEquals(result.access.proofs, []);
  assertEquals(s.calls.find(c => c.rpc === "qa_sandbox_commit_access_observation")?.values[2], [
    { key: "c".repeat(64), product: "still_pro_v3", state: "revoked" }]);
});

Deno.test("unconfigured QA account routes still verify JWT while anonymous local verification stays available", async () => {
  const read = (name: string) => ({ SUPABASE_URL: URL, SUPABASE_JWT_SECRET: SECRET } as Record<string,string>)[name];
  for (const kind of ["apple-account", "reconcile"] as const) {
    assertEquals((await handleQaSandboxUnavailable(request(), read, kind)).status, 401);
    assertEquals((await handleQaSandboxUnavailable(request(await token({ sub: "not-a-uuid" })), read, kind)).status, 401);
    assertEquals((await handleQaSandboxUnavailable(request(await token({ iss: "https://foreign.example/auth/v1" })), read, kind)).status, 401);
    const result = await (await handleQaSandboxUnavailable(request(await token()), read, kind)).json();
    assertEquals(result, kind === "reconcile" ? { access: { status: "unavailable" } } : { status: "unavailable" });
  }
  assertEquals(await (await handleQaSandboxUnavailable(request(), read, "apple-local")).json(), { status: "unavailable" });
});

Deno.test("QA final Auth and SQL latency cannot deliver proofs after JWT expiry", async t => {
  for (const boundary of ["auth", "sql"] as const) for (const expires of [false, true]) {
    await t.step(`${boundary}: ${expires ? "expired" : "current"}`, async () => {
      const s = await setup(); const old = Date.now; const start = old(); const jwt = await token();
      let confirmations = 0; const access = s.runtime.reconcile.access!;
      const advance = () => { if (expires) Date.now = () => start + 601_000; };
      const deps = { ...s.runtime.reconcile,
        accounts: { confirmed: () => { if (++confirmations === 3 && boundary === "auth") advance(); return Promise.resolve(true); } },
        access: { ...access, rights: { ...access.rights,
          begin: access.rights.begin.bind(access.rights), commit: access.rights.commit.bind(access.rights),
          removals: access.rights.removals?.bind(access.rights),
          confirm: async (...args: Parameters<typeof access.rights.confirm>) => {
            const valid = await access.rights.confirm(...args); if (boundary === "sql") advance(); return valid;
          } } } };
      try {
        const result = await (await handleQaSandboxReconcile(request(jwt), deps)).json();
        assertEquals(result.access.status, expires ? "unavailable" : "verified");
        assertEquals(result.access.proofs?.length ?? 0, expires ? 0 : 1);
      } finally { Date.now = old; }
    });
  }
});
