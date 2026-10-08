import type postgres from "postgres";
import { PgQaPurchaseOperationStore } from "./qa-purchase-operation-store.ts";
import { QaSandboxAccessRightStore } from "./qa-sandbox-store.ts";
import { assert, assertEquals } from "@std/assert";
import { handleQaSandboxStripeWebhook, readQaSandboxStripeWebhookRuntime, type QaSandboxStripeWebhookDeps } from "./qa-sandbox-stripe-webhook.ts";
import type { QaPurchaseOperation, QaPurchaseOperationStatus } from "./qa-purchase-operation-store.ts";
import { QaSandboxManagedCheckout } from "./qa-sandbox-managed-checkout.ts";
import { HttpRevenueCatAccessClient } from "./revenuecat-access.ts";

const HOLDER = "11111111-1111-1111-1111-111111111111", OP = "22222222-2222-2222-2222-222222222222";
const HASH = "a".repeat(64), SESSION = "cs_test_Fixture", INTENT = "pi_Fixture", CHARGE = "ch_Fixture", SECRET = "whsec_SyntheticOnly";
const KEY = "b".repeat(64), NOW = new Date().toISOString();
const CREATED = Math.floor(Date.parse(NOW)/1000);
function event(type = "checkout.session.completed", patch: Record<string, unknown> = {}) {
  return { object: "event", id: "evt_Fixture", type, livemode: false, data: { object: type === "charge.refunded" ?
    { object: "charge", id: CHARGE, livemode: false } : { object: "checkout.session", id: SESSION, livemode: false,
      metadata: { operation_id: OP }, client_reference_id: HOLDER, payment_status: "paid" } }, ...patch };
}
async function signed(value: unknown = event(), timestamp = Math.floor(Date.now()/1000), secret = SECRET, raw?: string) {
  const text = raw ?? JSON.stringify(value), bytes = new TextEncoder().encode(`${timestamp}.${text}`);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  return { text, signature: `t=${timestamp},v1=${Array.from(digest,b => b.toString(16).padStart(2,"0")).join("")}` };
}
async function request(value: unknown = event(), options: { timestamp?: number; secret?: string; header?: string | null; raw?: string } = {}) {
  const s = await signed(value,options.timestamp,options.secret,options.raw);
  return new Request("https://project.example.test/functions/v1/qa", { method: "POST", headers: options.header === null ? {} :
    { "Stripe-Signature": options.header ?? s.signature }, body: s.text });
}
function setup() {
  const state = { row: { operation_id: OP, holder: HOLDER, environment: "sandbox", configuration_hash: HASH, stripe_session_id: SESSION,
    status: "session_bound", creation_started_at: NOW, paid_at: null, created_at: NOW, updated_at: NOW } as QaPurchaseOperation,
    reads: 0, creates: 0, imports: 0, recoveries: 0, begins: 0, commits: 0, signs: 0, refunds: 0, enabled: false, confirmed: false,
    paid: true, pending: false, expired: false, unknown: false, importFails: false, rcUnavailable: false, active: false,
    negative: true, complete: true, known: true, stale: false, full: true, partial: false, mutations: [] as string[], snapshots: [] as unknown[] };
  const deps: QaSandboxStripeWebhookDeps = { secret: SECRET, checkout: { configurationHash: HASH, jwtSecret: "",
    accounts: { confirmed: () => Promise.resolve(state.confirmed) }, membership: { enabled: () => Promise.resolve(state.enabled) },
    limiter: { consume: () => { throw Error("webhooks do not use user/IP limiter"); } },
    operations: {
      prepare: () => { throw Error("must not prepare"); }, claimCreation: () => { throw Error("must not claim"); },
      read: (op, holder) => { state.reads++; return Promise.resolve(op === OP && holder === HOLDER ? { ...state.row } : null); },
      bindSession: (op, holder, session, hash) => { assertEquals([op,holder,session,hash],[OP,HOLDER,SESSION,HASH]);
        assert(state.row.creation_started_at); state.row = { ...state.row,stripe_session_id: session,status: "session_bound" }; state.mutations.push("bind"); return Promise.resolve({ ...state.row }); },
      recordStatus: (op, session, status: QaPurchaseOperationStatus) => { assertEquals([op,session],[OP,SESSION]);
        assert(state.row.status !== "refunded" || status === "refunded");
        if (status === "closed_unpaid") assertEquals(state.row.paid_at,null);
        state.row = { ...state.row,status,paid_at: ["paid_verified","import_pending","imported","refunded"].includes(status) ? state.row.paid_at ?? NOW : state.row.paid_at };
        state.mutations.push(status); return Promise.resolve({ ...state.row }); },
    }, billing: {
      createCheckout: () => { state.creates++; throw Error("must not create"); },
      recoverCheckout: () => { state.recoveries++; return Promise.resolve(state.unknown ? { status: "unknown",sessionId: SESSION } :
        state.paid || state.pending || state.expired ? { status: "recovered",sessionId: SESSION,paymentState: state.expired ? "expired_unpaid" : state.pending ? "payment_pending" : "paid" } :
        { status: "created",sessionId: SESSION,checkoutUrl: `https://checkout.stripe.com/c/pay/${SESSION}` }); },
      recoverUnknownCheckout: () => deps.checkout.billing.recoverCheckout({ operationId: OP,holderId: HOLDER },SESSION),
      trackCompletedPurchase: () => { state.imports++; return Promise.resolve({ status: state.importFails ? "unavailable" : "tracked" }); },
    }, access: {
      signer: { environment: "sandbox",sign: () => { state.signs++; throw Error("must never sign"); } },
      provider: { getRights: () => Promise.resolve(state.rcUnavailable ? { status: "unavailable" } : { status: "verified",complete: state.complete,
        rights: state.active ? [{ key: KEY,product: "still_pro_v3" }] : state.negative ? [{ key: KEY,product: "still_pro_v3",state: "revoked" }] : [] }) },
      rights: {
        begin: () => { state.begins++; return Promise.resolve(OP); },
        commit: (_holder,_env,_token,rights) => { state.commits++; state.snapshots.push(rights);
          if (!state.known && rights.length) throw Error("unknown negative key");
          return Promise.resolve(state.stale ? { status: "stale" } : { status: "committed",rights: state.active || (state.known && !rights.length) ?
            [{ right: OP,holder: HOLDER,revision: 1,verified_at: Date.now() }] : [],revocations: [],issuer_time: Date.now() }); },
        confirm: () => { throw Error("must not confirm positive"); },
      },
    } }, refunds: { readChargeRefund: (id) => { assertEquals(id,CHARGE); state.refunds++; return Promise.resolve({
      status: state.full ? "full_refund" : state.partial ? "partial_refund" : "not_refunded",operationId: OP,holderId: HOLDER,sessionId: SESSION,paymentIntentId: INTENT,createdAtMs: CREATED*1000 }); } } };
  return { state,deps };
}
Deno.test("real HMAC raw signature accepts exact bytes, no JWT and rotating multiple v1", async () => {
  const s = setup(), raw = ' {"object":"event","id":"evt_Unknown","type":"unknown.event","livemode":false,"data":{"object":{}}} ';
  const signedRaw = await signed({},undefined,undefined,raw);
  const req = new Request("https://example.test", { method: "POST", body: raw, headers: { "Stripe-Signature": `${signedRaw.signature},v1=${"0".repeat(64)},v0=abc` } });
  assertEquals((await handleQaSandboxStripeWebhook(req,s.deps)).status,200); assertEquals(s.state.reads,0);
});
Deno.test("missing wrong tampered stale future zero duplicate timestamp malformed signatures do no work", async () => {
  const s = setup();
  for (const options of [{ header: null }, { secret: "whsec_Wrong" }, { timestamp: 0 },
    { timestamp: Math.floor(Date.now()/1000)-301 }, { timestamp: Math.floor(Date.now()/1000)+301 },
    { header: `t=${Math.floor(Date.now()/1000)},t=1,v1=${"0".repeat(64)}` }, { header: "garbage" },
    { header: `t=${Math.floor(Date.now()/1000)},v1=bad` }, { header: "a".repeat(2049) }]) {
    assertEquals((await handleQaSandboxStripeWebhook(await request(event(),options),s.deps)).status,400);
  }
  const r = await signed();
  assertEquals((await handleQaSandboxStripeWebhook(new Request("https://example.test",{ method: "POST",headers: { "Stripe-Signature": r.signature },body: r.text+" " }),s.deps)).status,400);
  assertEquals([s.state.reads,s.state.refunds,s.state.begins,s.state.imports],[0,0,0,0]);
});
Deno.test("unconfigured signer refuses legacy tokens and unsupported methods before body work", async () => {
  const s = setup();
  assertEquals((await handleQaSandboxStripeWebhook(await request(),null)).status,503);
  assertEquals((await handleQaSandboxStripeWebhook(await request(),{ ...s.deps,secret: "legacy-shared-token" })).status,503);
  for (const method of ["GET","OPTIONS","PUT"]) assertEquals((await handleQaSandboxStripeWebhook(new Request("https://example.test",{ method }),s.deps)).status,405);
  const readNames: string[] = [];
  assertEquals(await readQaSandboxStripeWebhookRuntime(name => { readNames.push(name); return undefined; }),null);
  assertEquals(readNames,["STILL_QA_SANDBOX_STRIPE_WEBHOOK_SECRET"]);
});
Deno.test("live malformed event or hint never reaches SQL or provider", async () => {
  for (const value of [event(undefined,{ livemode: true }),event(undefined,{ id: "bad" }),event(undefined,{ object: "other" }),
    event(undefined,{ data: { object: { object: "checkout.session",id: "cs_live_X",livemode: false } } }),
    event(undefined,{ data: { object: { object: "charge",id: CHARGE,livemode: true } } }),null,[]]) {
    const s = setup(); assertEquals((await handleQaSandboxStripeWebhook(await request(value),s.deps)).status,400); assertEquals(s.state.reads,0);
  }
});
Deno.test("paid notification resumes import despite disabled membership and banned Auth, no proof or URL", async () => {
  const s = setup();
  const response = await handleQaSandboxStripeWebhook(await request(),s.deps);
  assertEquals(await response.json(),{ received: true }); assertEquals(response.status,200);
  assertEquals(s.state.row.status,"imported"); assertEquals([s.state.imports,s.state.creates,s.state.signs],[1,0,0]);
  assertEquals(s.state.snapshots,[[{ key: KEY,product: "still_pro_v3",state: "revoked" }]]);
});
Deno.test("interrupted paid import retries same Session without checkout creation", async () => {
  const s = setup(); s.state.importFails = true;
  assertEquals((await handleQaSandboxStripeWebhook(await request(),s.deps)).status,502); assertEquals(s.state.row.status,"recovery_required");
  s.state.importFails = false;
  assertEquals((await handleQaSandboxStripeWebhook(await request(),s.deps)).status,200);
  assertEquals([s.state.imports,s.state.creates,s.state.row.status],[2,0,"imported"]);
  await handleQaSandboxStripeWebhook(await request(),s.deps); assertEquals(s.state.imports,2);
});
Deno.test("snapshot paid never grants and canonical open pending or unknown remain safely held", async () => {
  for (const kind of ["open","pending","unknown"]) {
    const s = setup(); s.state.paid = false; s.state.pending = kind === "pending"; s.state.unknown = kind === "unknown";
    const response = await handleQaSandboxStripeWebhook(await request(),s.deps);
    assertEquals(response.status,kind === "unknown" ? 502 : 200); assertEquals(await response.json(),kind === "unknown" ? { error: "webhook_unavailable" } : { received: true });
    assertEquals([s.state.imports,s.state.creates,s.state.signs],[0,0,0]);
  }
});
Deno.test("async failure closes only canonical expired unpaid, never snapshot status", async () => {
  const s = setup(); s.state.paid = false; s.state.pending = true;
  assertEquals((await handleQaSandboxStripeWebhook(await request(event("checkout.session.async_payment_failed")),s.deps)).status,200);
  assertEquals(s.state.row.status,"session_bound");
  s.state.pending = false; s.state.expired = true;
  assertEquals((await handleQaSandboxStripeWebhook(await request(event("checkout.session.expired")),s.deps)).status,200);
  assertEquals(s.state.row.status,"closed_unpaid"); assertEquals(s.state.imports,0);
});
Deno.test("wrong config holder bound Session absent claim or unknown operation never imports", async () => {
  for (const patch of [{ configuration_hash: "c".repeat(64) },{ holder: "33333333-3333-3333-3333-333333333333" },
    { stripe_session_id: "cs_test_Other" },{ creation_started_at: null },{ operation_id: "33333333-3333-3333-3333-333333333333" }]) {
    const s = setup(); s.state.row = { ...s.state.row,...patch };
    assertEquals((await handleQaSandboxStripeWebhook(await request(),s.deps)).status,502);
    assertEquals([s.state.imports,s.state.recoveries,s.state.creates],[0,0,0]);
  }
});
Deno.test("claimed unbound notification uses canonical discovery before binding exact hinted Session", async () => {
  const s = setup(); s.state.row = { ...s.state.row,stripe_session_id: null,status: "prepared" };
  assertEquals((await handleQaSandboxStripeWebhook(await request(),s.deps)).status,200); assertEquals(s.state.mutations[0],"bind");
  assertEquals(s.state.creates,0);
  const wrong = setup(); wrong.state.row = { ...wrong.state.row,stripe_session_id: null,status: "prepared" };
  wrong.deps.checkout.billing.recoverUnknownCheckout = () => Promise.resolve({ status: "unknown",sessionId: "cs_test_Other" });
  assertEquals((await handleQaSandboxStripeWebhook(await request(),wrong.deps)).status,502); assertEquals(wrong.state.mutations,[]);
});
Deno.test("full refund terminalizes before canonical negative lookup and duplicate still retries", async () => {
  const s = setup(); s.state.rcUnavailable = true;
  assertEquals((await handleQaSandboxStripeWebhook(await request(event("charge.refunded")),s.deps)).status,502);
  assertEquals(s.state.row.status,"refunded"); assertEquals(s.state.begins,1);
  s.state.rcUnavailable = false;
  assertEquals((await handleQaSandboxStripeWebhook(await request(event("charge.refunded")),s.deps)).status,200);
  assertEquals([s.state.begins,s.state.commits,s.state.signs],[2,1,0]);
  assertEquals(s.state.mutations,["refunded"]);
});
Deno.test("refund before import blocks delayed completed notification from importing or granting", async () => {
  const s = setup();
  assertEquals((await handleQaSandboxStripeWebhook(await request(event("charge.refunded")),s.deps)).status,200);
  assertEquals((await handleQaSandboxStripeWebhook(await request(),s.deps)).status,200);
  assertEquals([s.state.imports,s.state.creates,s.state.signs,s.state.row.status],[0,0,0,"refunded"]);
});
Deno.test("partial zero refund does not mutate ledger or observe access", async () => {
  for (const partial of [true,false]) {
    const s = setup(); s.state.full = false; s.state.partial = partial;
    assertEquals((await handleQaSandboxStripeWebhook(await request(event("charge.refunded")),s.deps)).status,200);
    assertEquals([s.state.reads,s.state.begins,s.state.commits,s.state.imports],[0,0,0,0]);
    assertEquals(s.state.row.status,"session_bound");
  }
});
Deno.test("refund current active partial incomplete stale and unknown negatives stay retryable without positive commits", async () => {
  for (const kind of ["active","incomplete","stale","unknown-negative","absent-known"]) {
    const s = setup(); s.state.active = kind === "active"; s.state.complete = kind !== "incomplete";
    s.state.stale = kind === "stale"; s.state.known = kind !== "unknown-negative"; s.state.negative = kind !== "absent-known";
    assertEquals((await handleQaSandboxStripeWebhook(await request(event("charge.refunded")),s.deps)).status,502);
    assertEquals(s.state.row.status,"refunded"); assertEquals(s.state.signs,0);
    assertEquals(s.state.snapshots.every(value => (value as { state?: string }[]).every(right => right.state === "revoked")),true);
  }
});
Deno.test("refund rejects wrong frozen config or creation window without mutating", async () => {
  for (const patch of [{ configuration_hash: "c".repeat(64) },{ creation_started_at: new Date(Date.parse(NOW)-301000).toISOString() },
    { creation_started_at: null },{ stripe_session_id: "cs_test_Other" },{ status: "closed_unpaid" as const }]) {
    const s = setup(); s.state.row = { ...s.state.row,...patch };
    assertEquals((await handleQaSandboxStripeWebhook(await request(event("charge.refunded")),s.deps)).status,502);
    assertEquals(s.state.mutations,[]); assertEquals(s.state.begins,0);
  }
});
Deno.test("oversized body advertised and actual bytes fail before signature provider work", async () => {
  const s = setup();
  const oversized = await request(event(),{ raw: "a".repeat(65537) });
  assertEquals((await handleQaSandboxStripeWebhook(oversized,s.deps)).status,400);
  const advertised = await request(); advertised.headers.set("content-length","65537");
  assertEquals((await handleQaSandboxStripeWebhook(advertised,s.deps)).status,400); assertEquals(s.state.reads,0);
});
Deno.test("stalled body deadline cancels without awaiting hostile cancellation", async () => {
  const s = setup();
  const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}),cancel: () => new Promise<void>(() => {}) });
  const req = new Request("https://example.test",{ method: "POST",headers: { "Stripe-Signature": "t=1,v1=bad" },body });
  const start = performance.now(); assertEquals((await handleQaSandboxStripeWebhook(req,s.deps)).status,400);
  assert(performance.now()-start < 3000); assertEquals(s.state.reads,0);
});
Deno.test("signed refund composes actual managed Charge readback and RC negative mapping through existing RPC store", async () => {
  const s = setup(), calls: string[] = [], real = globalThis.fetch;
  const mapping = { product_id: "rc-product",app_id: "rc-app",store_identifier: "provider-product",store: "stripe",entitlement_lookup_key: "still_pro_v3",benefit_product: "still_pro_v3" } as const;
  const session = { object: "checkout.session",id: SESSION,livemode: false,mode: "payment",managed_payments: { enabled: true },
    client_reference_id: HOLDER,metadata: { operation_id: OP },currency: "usd",amount_subtotal: 999,amount_total: 1087,
    status: "complete",payment_status: "paid",payment_intent: INTENT,created: CREATED };
  const fetcher = ((url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url); calls.push(target); assert(init.method !== "POST");
    const payload = target.endsWith("/account") ? { object: "account",id: "acct_Fixture" } : target.includes("/charges/") ?
      { object: "charge",id: CHARGE,livemode: false,paid: true,status: "succeeded",currency: "usd",amount: 1087,amount_refunded: 1087,refunded: true,payment_intent: INTENT } :
      target.includes("?payment_intent=") ? { object: "list",url: "/v1/checkout/sessions",has_more: false,data: [session] } :
      target.includes("/line_items?") ? { object: "list",has_more: false,data: [{ object: "item",quantity: 1,currency: "usd",amount_subtotal: 999,amount_total: 1087,
        price: { object: "price",id: "price_Fixture",currency: "usd",unit_amount: 999,type: "one_time",recurring: null,livemode: false,
          product: { object: "product",id: "prod_Fixture",livemode: false } } }] } : target.includes("revenuecat.com") ?
      { object: "list",next_page: null,items: [{ object: "purchase",id: "purchase_Fixture",customer_id: HOLDER,product_id: mapping.product_id,
        environment: "sandbox",purchased_at: CREATED*1000,store: "stripe",ownership: "purchased",status: "refunded",revenue_in_usd: null }] } : session;
    return Promise.resolve(Response.json(payload));
  }) as typeof fetch;
  const adapter = new QaSandboxManagedCheckout({ stripeTestKey: "sk_test_SyntheticOnly",priceId: "price_Fixture",productId: "prod_Fixture",stripeAccountId: "acct_Fixture",
    revenueCatStripePublicKey: "syntheticPublic",successUrl: "https://stillapp.fit/qa/success",cancelUrl: "https://stillapp.fit/qa/cancel" },fetcher);
  // Actual provider parser, not a canned verified/negative result.
  const rpcCalls: string[] = [];
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?"); rpcCalls.push(text);
    assert(text.includes("public.qa_sandbox_"));
    if (text.includes("qa_sandbox_read_checkout_operation")) return [{ result: await s.deps.checkout.operations.read(values[0] as string,values[1] as string) }];
    if (text.includes("qa_sandbox_record_checkout_status")) return [{ result: await s.deps.checkout.operations.recordStatus(values[0] as string,values[1] as string,values[2] as QaPurchaseOperationStatus) }];
    if (text.includes("qa_sandbox_begin_access_observation")) return [{ token: await s.deps.checkout.access!.rights.begin(values[0] as string,"sandbox") }];
    if (text.includes("qa_sandbox_commit_access_observation")) return [{ result: await s.deps.checkout.access!.rights.commit(values[0] as string,"sandbox",values[1] as string,values[2] as never) }];
    throw Error("unapproved RPC");
  },{ json: (value: unknown) => value }) as unknown as ReturnType<typeof postgres>;
  const access = { ...s.deps.checkout.access!,rights: new QaSandboxAccessRightStore(sql),provider: new HttpRevenueCatAccessClient("syntheticSecret","project_Fixture",[mapping]) };
  const deps = { ...s.deps,refunds: adapter,checkout: { ...s.deps.checkout,operations: new PgQaPurchaseOperationStore(sql),billing: adapter,access } };
  globalThis.fetch = fetcher;
  try {
    assertEquals((await handleQaSandboxStripeWebhook(await request(event("charge.refunded")),deps)).status,200);
    assertEquals(calls.length,6); assertEquals(rpcCalls.length,4); assertEquals(s.state.row.status,"refunded");
    const snapshot = s.state.snapshots[0] as { key: string;product: string;state: string }[];
    assertEquals(snapshot.length,1); assertEquals(snapshot[0]!.key.length,64); assertEquals(snapshot[0]!.state,"revoked");
    assertEquals([s.state.signs,s.state.creates,s.state.imports],[0,0,0]);
  } finally { globalThis.fetch = real; }
});
