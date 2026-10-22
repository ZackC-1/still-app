import { assert, assertEquals } from "@std/assert";
import { handleProductionStripeWebhook, readProductionStripeWebhookRuntime } from "./production-stripe-webhook.ts";
import type { ManagedStripeWebhookDeps } from "./managed-stripe-webhook.ts";
import type { PurchaseOperation, PurchaseOperationStatus } from "./purchase-operation-store.ts";

const HOLDER = "11111111-1111-1111-1111-111111111111", OP = "22222222-2222-2222-2222-222222222222";
const HASH = "a".repeat(64), SESSION = "cs_live_Fixture", INTENT = "pi_Fixture", CHARGE = "ch_Fixture", SECRET = "whsec_SyntheticOnly";
const KEY = "b".repeat(64), NOW = new Date().toISOString();
const CREATED = Math.floor(Date.parse(NOW)/1000);
function event(type = "checkout.session.completed", patch: Record<string, unknown> = {}) {
  return { object: "event", id: "evt_Fixture", type, livemode: true, data: { object: type === "charge.refunded" ?
    { object: "charge", id: CHARGE, livemode: true } : { object: "checkout.session", id: SESSION, livemode: true,
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
  const state = { row: { operation_id: OP, holder: HOLDER, environment: "production", configuration_hash: HASH, stripe_session_id: SESSION,
    status: "session_bound", creation_started_at: NOW, paid_at: null, created_at: NOW, updated_at: NOW } as PurchaseOperation<"production">,
    reads: 0, creates: 0, imports: 0, recoveries: 0, begins: 0, commits: 0, signs: 0, refunds: 0, enabled: false, confirmed: false,
    paid: true, pending: false, expired: false, unknown: false, importFails: false, rcUnavailable: false, customerMissing: false, active: false,
    negative: true, complete: true, known: true, stale: false, full: true, partial: false, deleted: false, readFails: false, mutations: [] as string[], snapshots: [] as unknown[] };
  const deps: ManagedStripeWebhookDeps = { secret: SECRET, checkout: { configurationHash: HASH, environment: "production",
    operations: {
      prepare: () => { throw Error("must not prepare"); }, claimCreation: () => { throw Error("must not claim"); },
      read: (op, holder) => { state.reads++; if (state.readFails) return Promise.reject(Error("QA account unavailable"));
        return Promise.resolve(op === OP && holder === HOLDER && !state.deleted ? { ...state.row } : null); },
      bindSession: (op, holder, session, hash) => { assertEquals([op,holder,session,hash],[OP,HOLDER,SESSION,HASH]);
        assert(state.row.creation_started_at); state.row = { ...state.row,stripe_session_id: session,status: "session_bound" }; state.mutations.push("bind"); return Promise.resolve({ ...state.row }); },
      recordStatus: (op, session, status: PurchaseOperationStatus) => { assertEquals([op,session],[OP,SESSION]);
        assert(state.row.status !== "refunded" || status === "refunded");
        if (status === "closed_unpaid") assertEquals(state.row.paid_at,null);
        state.row = { ...state.row,status,paid_at: ["paid_verified","import_pending","imported","refunded"].includes(status) ? state.row.paid_at ?? NOW : state.row.paid_at };
        state.mutations.push(status); return Promise.resolve({ ...state.row }); },
      recordDeletedAccountRefund: (op, session) => { assertEquals([op,session],[OP,SESSION]); state.mutations.push("deleted-account-refunded");
        if (!state.deleted) throw Error("stored operation still names an account");
        state.row = { ...state.row,status: "refunded",paid_at: state.row.paid_at ?? NOW };
        return Promise.resolve({ ...state.row,holder: null,status: "refunded" as const }); },
    }, billing: {
      createCheckout: () => { state.creates++; throw Error("must not create"); },
      recoverCheckout: () => { state.recoveries++; return Promise.resolve(state.unknown ? { status: "unknown",sessionId: SESSION } :
        state.paid || state.pending || state.expired ? { status: "recovered",sessionId: SESSION,paymentState: state.expired ? "expired_unpaid" : state.pending ? "payment_pending" : "paid" } :
        { status: "created",sessionId: SESSION,checkoutUrl: `https://checkout.stripe.com/c/pay/${SESSION}` }); },
      recoverUnknownCheckout: () => deps.checkout.billing.recoverCheckout({ operationId: OP,holderId: HOLDER },SESSION),
      trackCompletedPurchase: () => { state.imports++; return Promise.resolve({ status: state.importFails ? "unavailable" : "tracked" }); },
    }, access: {
      signer: { environment: "production",sign: () => { state.signs++; throw Error("must never sign"); } },
      provider: { getRights: (_holder,environment) => { assertEquals(environment,"production"); return Promise.resolve(state.rcUnavailable ? { status: "unavailable" } : state.customerMissing ? { status: "verified",complete: true,rights: [],customerMissing: true } : { status: "verified",complete: state.complete,
        rights: state.active ? [{ key: KEY,product: "still_pro_v3" }] : state.negative ? [{ key: KEY,product: "still_pro_v3",state: "revoked" }] : [] }); } },
      rights: {
        begin: (_holder,environment) => { assertEquals(environment,"production"); state.begins++; return Promise.resolve(OP); },
        commit: (_holder,environment,_token,rights) => { assertEquals(environment,"production"); state.commits++; state.snapshots.push(rights);
          if (!state.known && rights.length) throw Error("unknown negative key");
          return Promise.resolve(state.stale ? { status: "stale" } : { status: "committed",rights: state.active || (state.known && !rights.length) ?
            [{ right: OP,holder: HOLDER,revision: 1,verified_at: Date.now() }] : [],revocations: [],issuer_time: Date.now() }); },
        confirm: () => { throw Error("must not confirm positive"); },
      },
    } }, refunds: { readChargeRefund: (id) => { assertEquals(id,CHARGE); state.refunds++; return Promise.resolve({
      status: state.full ? "full_refund" : state.partial ? "partial_refund" : "not_refunded",operationId: OP,holderId: HOLDER,sessionId: SESSION,paymentIntentId: INTENT,createdAtMs: CREATED*1000 }); } } };
  return { state,deps };
}
Deno.test("production webhook requires real raw signature and live event before any work", async () => {
  for (const options of [{ header:null },{ secret:"whsec_Other" },{ timestamp:Math.floor(Date.now()/1000)-301 }]) {
    const s=setup();
    assertEquals((await handleProductionStripeWebhook(await request(event(),options),s.deps)).status,400);
    assertEquals([s.state.reads,s.state.imports,s.state.refunds],[0,0,0]);
  }
  for (const value of [event(undefined,{ livemode:false }),event("charge.refunded",{ data:{ object:{ object:"charge",id:CHARGE,livemode:false } } }),
    event(undefined,{ data:{ object:{ ...event().data.object,id:"cs_test_Fixture" } } })]) {
    const s=setup(); assertEquals((await handleProductionStripeWebhook(await request(value),s.deps)).status,400);
    assertEquals([s.state.reads,s.state.imports,s.state.refunds],[0,0,0]);
  }
});
Deno.test("production webhook cannot use a sandbox runtime or QA-only signing secret", async () => {
  const s=setup(); Object.assign(s.deps.checkout,{ environment:"sandbox" });
  assertEquals((await handleProductionStripeWebhook(await request(),s.deps)).status,503);
  assertEquals(await readProductionStripeWebhookRuntime(name=>name==="STILL_QA_SANDBOX_STRIPE_WEBHOOK_SECRET" ? SECRET : undefined),null);
  assertEquals((await handleProductionStripeWebhook(new Request("https://example.test"),null)).status,405);
});
Deno.test("production paid notification retries import without creating checkout or minting access", async () => {
  const s=setup(); s.state.importFails=true;
  assertEquals((await handleProductionStripeWebhook(await request(),s.deps)).status,502);
  s.state.importFails=false;
  assertEquals((await handleProductionStripeWebhook(await request(),s.deps)).status,200);
  assertEquals([s.state.imports,s.state.creates,s.state.signs],[2,0,0]);
  assertEquals(s.state.row.status,"imported");
  assertEquals((await handleProductionStripeWebhook(await request(),s.deps)).status,200);
  assertEquals(s.state.imports,2);
});
Deno.test("production webhook rejects wrong ledger environment, holder and configuration", async () => {
  for (const patch of [{ environment:"sandbox" },{ holder:OP },{ configuration_hash:"b".repeat(64) }]) {
    const s=setup(); Object.assign(s.state.row,patch);
    assertEquals((await handleProductionStripeWebhook(await request(),s.deps)).status,502);
    assertEquals(s.state.imports,0);
  }
});
Deno.test("production full refund is terminal before negative reconciliation and safe on duplicate", async () => {
  const s=setup(); s.state.rcUnavailable=true;
  assertEquals((await handleProductionStripeWebhook(await request(event("charge.refunded")),s.deps)).status,502);
  assertEquals(s.state.row.status,"refunded"); assertEquals(s.state.mutations[0],"refunded");
  s.state.rcUnavailable=false;
  assertEquals((await handleProductionStripeWebhook(await request(event("charge.refunded")),s.deps)).status,200);
  assertEquals((await handleProductionStripeWebhook(await request(),s.deps)).status,200);
  assertEquals(s.state.snapshots,[[{ key:KEY,product:"still_pro_v3",state:"revoked" }]]);
  assertEquals([s.state.imports,s.state.creates,s.state.signs],[0,0,0]);
});
Deno.test("production refund after account deletion retains the payment and never recreates rights", async () => {
  const s=setup(); s.state.deleted=true;
  assertEquals((await handleProductionStripeWebhook(await request(event("charge.refunded")),s.deps)).status,200);
  assertEquals(s.state.mutations,["deleted-account-refunded"]);
  assertEquals([s.state.begins,s.state.commits,s.state.imports,s.state.signs],[0,0,0,0]);
});
