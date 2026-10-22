import { assert, assertEquals } from "@std/assert";
import { readProductionCheckoutConfig, readProductionCheckoutRuntime, handleProductionCheckout, handleProductionCheckoutUnavailable } from "./production-checkout-runtime.ts";
import type { ManagedCheckoutRequestDeps } from "./managed-checkout-handler.ts";
import type { PurchaseOperation, PurchaseOperationStatus, PurchaseOperationStore } from "./purchase-operation-store.ts";
import { authenticatedClaims, signHs256 } from "./jwt.ts";

const HOLDER="11111111-1111-4111-8111-111111111111", OP="22222222-2222-4222-8222-222222222222";
const HASH="a".repeat(64), SESSION="cs_live_Synthetic", SECRET="synthetic-jwt", URL="https://project.example.test";
const ADMISSION={ surface:"chrome_desktop",build:"3.0.0.1" };
function b64(value: ArrayBuffer): string { return btoa(String.fromCharCode(...new Uint8Array(value))); }
async function request(body: unknown = { access_schema:1,...ADMISSION }) {
  const token=await signHs256({ sub:HOLDER,...authenticatedClaims(URL),exp:Math.floor(Date.now()/1000)+600 },SECRET);
  return new Request(URL,{ method:"POST",headers:{ Authorization:`Bearer ${token}`,"content-type":"application/json" },body:JSON.stringify(body) });
}
async function configurationInputs(): Promise<Record<string,string>> {
  const keys = await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]); assert("privateKey" in keys);
  const apple = await crypto.subtle.generateKey({ name:"ECDSA",namedCurve:"P-256" },true,["sign","verify"]);
  return { ACCESS_PROOF_ENVIRONMENT:"production", SUPABASE_URL:URL,SUPABASE_ANON_KEY:"synthetic-public",SUPABASE_JWT_SECRET:SECRET,
    ENTITLEMENT_WRITER_DB_URL:"postgres://still_entitlement_writer:synthetic@db.example.test/postgres",
    ACCESS_PROOF_KEY_ID:"prod-synthetic",
    ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64:b64(await crypto.subtle.exportKey("pkcs8",keys.privateKey)),
    ACCESS_PROOF_PUBLIC_KEY_HEX:Array.from(new Uint8Array(await crypto.subtle.exportKey("raw",keys.publicKey)),b => b.toString(16).padStart(2,"0")).join(""),
    ACCESS_APPLE_PRODUCTS_JSON:JSON.stringify([{ bundleId:"com.example.still",appAppleId:1234,productId:"still_pro_v3" }]),
    APP_STORE_SERVER_PRIVATE_KEY:`-----BEGIN PRIVATE KEY-----\n${b64(await crypto.subtle.exportKey("pkcs8",apple.privateKey))}\n-----END PRIVATE KEY-----`,
    APP_STORE_SERVER_KEY_ID:"TESTKEY123",APP_STORE_SERVER_ISSUER_ID:HOLDER,
    STRIPE_SECRET_API_KEY:"sk_live_synthetic123",STRIPE_ACCOUNT_ID:"acct_synthetic",
    STRIPE_API_VERSION:"2026-09-30.endive",STRIPE_PRICE_ID:"price_synthetic",STRIPE_PRODUCT_ID:"prod_synthetic",
    REVENUECAT_STRIPE_PUBLIC_API_KEY:"syntheticStripePublic",WEB_RETURN_ORIGIN:"https://return.example.test",
    WEB_RETURN_PATHS_JSON:JSON.stringify({ success:"/checkout/success",cancel:"/checkout/cancel" }),
    REVENUECAT_PROJECT_ID:"proj_synthetic",REVENUECAT_ACCESS_SECRET_API_KEY:"synthetic-live-server",
    ACCESS_PROVIDER_PRODUCTS_JSON:JSON.stringify([{ product_id:"product_rc",app_id:"app_live",store:"stripe",store_identifier:"price_synthetic",entitlement_lookup_key:"still_pro_v3",benefit_product:"still_pro_v3" }]),
  };
}
function setup() {
  const now = () => new Date().toISOString();
  const state = { row: null as PurchaseOperation<"production"> | null, creates: 0, imports: 0, paid: false, saleEnabled: true, confirmed: true };
  const operations: PurchaseOperationStore<"production"> = {
    prepare: () => {
      if (!state.saleEnabled) throw new Error("SQL sales admission refused");
      state.row ??= { operation_id:OP,holder:HOLDER,environment:"production",configuration_hash:HASH,stripe_session_id:null,
        status:"prepared",creation_started_at:null,paid_at:null,created_at:now(),updated_at:now() };
      return Promise.resolve({ ...state.row });
    },
    read: (op,holder) => Promise.resolve(state.row?.operation_id===op && state.row.holder===holder ? { ...state.row } : null),
    claimCreation: () => {
      if (!state.saleEnabled) throw new Error("SQL sales admission refused");
      assert(state.row); const claimed=state.row.creation_started_at===null;
      state.row={ ...state.row,creation_started_at:state.row.creation_started_at ?? now() };
      return Promise.resolve({ operation:{ ...state.row },claimed });
    },
    bindSession: (_op,_holder,session) => { assert(state.row); state.row={ ...state.row,stripe_session_id:session,status:"session_bound" }; return Promise.resolve({ ...state.row }); },
    recordStatus: (_op,_session,status) => { assert(state.row); state.row={ ...state.row,status,paid_at:state.paid ? state.row.paid_at ?? now() : null }; return Promise.resolve({ ...state.row }); },
    recordDeletedAccountRefund: () => { throw new Error("not a refund route"); },
  };
  const recovery = () => state.paid ? { status:"recovered" as const,sessionId:SESSION,paymentState:"paid" as const } :
    { status:"created" as const,sessionId:SESSION,checkoutUrl:`https://checkout.stripe.com/c/pay/${SESSION}` };
  const deps: ManagedCheckoutRequestDeps = { jwtSecret:SECRET,expected:authenticatedClaims(URL),environment:"production",configurationHash:HASH,
    limiter:{ consume:() => Promise.resolve(0) },accounts:{ confirmed:() => Promise.resolve(state.confirmed) },
    operationStore: admission => { assertEquals(admission,ADMISSION); return operations; },canGrant:() => Promise.resolve(true),admissionError:"sales_unavailable",
    billing:{ createCheckout:() => { state.creates++; return Promise.resolve(recovery()); },recoverCheckout:() => Promise.resolve(recovery()),
      recoverUnknownCheckout:() => Promise.resolve({ status:"unknown" }),trackCompletedPurchase:() => { state.imports++; return Promise.resolve({ status:"tracked" }); } } };
  return { state,deps };
}

Deno.test("production config binds live provider, real key pairs and complete private configuration", async () => {
  const values=await configurationInputs(); const config=await readProductionCheckoutConfig(name=>values[name]); assert(config);
  assertEquals(config.billing.environment,"production"); assertEquals(config.apple.environment,"production");
  for (const key of ["STRIPE_SECRET_API_KEY","REVENUECAT_ACCESS_SECRET_API_KEY","REVENUECAT_STRIPE_PUBLIC_API_KEY","SUPABASE_JWT_SECRET"]) {
    const changed=await readProductionCheckoutConfig(name=>name===key ? values[name]+"changed" : values[name]);
    assert(changed); assert(changed.configurationHash!==config.configurationHash);
  }
});

Deno.test("production cannot borrow QA secrets, sandbox signer, test key or elevated SQL role", async () => {
  const values=await configurationInputs(); let sqlCalls=0;
  for (const key of Object.keys(values).filter(key=>key!=="SUPABASE_JWT_SECRET")) {
    assertEquals(await readProductionCheckoutRuntime(name=>name===key ? undefined : values[name],()=>{ sqlCalls++; throw new Error("must not compose SQL"); }),null,key);
  }
  const patches: Record<string,string>[] = [{ ACCESS_PROOF_ENVIRONMENT:"sandbox" },{ STRIPE_SECRET_API_KEY:"sk_test_synthetic123" },
    { ENTITLEMENT_WRITER_DB_URL:"postgres://postgres:synthetic@db.example.test/postgres" }];
  for (const patch of patches) {
    assertEquals(await readProductionCheckoutConfig(name=>({ ...values,...patch })[name]),null);
  }
  assertEquals(await readProductionCheckoutConfig(name=>values[`STILL_QA_SANDBOX_${name}`]),null);
  assertEquals(sqlCalls,0);
});

Deno.test("production requires closed release metadata and verified confirmed holder", async () => {
  const s=setup();
  for (const body of [{ access_schema:1 },{ access_schema:1,...ADMISSION,holder:HOLDER },{ access_schema:1,...ADMISSION,surface:"safari_ios" },
    { access_schema:1,...ADMISSION,build:"../other" },{ access_schema:1,...ADMISSION,environment:"sandbox" }]) {
    assertEquals((await handleProductionCheckout(await request(body),s.deps,false)).status,400);
  }
  s.state.confirmed=false;
  assertEquals((await handleProductionCheckout(await request(),s.deps,false)).status,403);
  assertEquals(s.state.creates,0);
});

Deno.test("production creates once and recovers the same paid operation after sales stop", async () => {
  const s=setup();
  const first=await (await handleProductionCheckout(await request(),s.deps,false)).json();
  assertEquals(first.operation_id,OP); assertEquals(s.state.creates,1);
  s.state.saleEnabled=false; s.state.paid=true;
  const completed=await (await handleProductionCheckout(await request({ access_schema:1,...ADMISSION,operation_id:OP }),s.deps,true)).json();
  assertEquals(s.state.creates,1); assertEquals(s.state.imports,1); assertEquals(completed.status,"imported");
  assertEquals(completed.access.status,"unavailable"); // Import ACK alone grants nothing.
  assertEquals((await handleProductionCheckout(await request(),s.deps,false)).status,502);
});

Deno.test("production refuses sandbox operation or signer before provider import", async () => {
  for (const mismatch of ["operation","signer"]) {
    const s=setup(); await handleProductionCheckout(await request(),s.deps,false); assert(s.state.row); s.state.paid=true;
    if (mismatch==="operation") Object.assign(s.state.row,{ environment:"sandbox" });
    else Object.assign(s.deps,{ access:{ signer:{ environment:"sandbox" } } });
    assertEquals((await handleProductionCheckout(await request({ access_schema:1,...ADMISSION,operation_id:OP }),s.deps,true)).status,502);
    assertEquals(s.state.imports,0);
  }
});

Deno.test("missing production composition keeps authenticated route behavior", async () => {
  const read=(name:string)=>({ SUPABASE_URL:URL,SUPABASE_JWT_SECRET:SECRET } as Record<string,string>)[name];
  assertEquals((await handleProductionCheckoutUnavailable(new Request(URL,{ method:"POST" }),read)).status,401);
  assertEquals((await handleProductionCheckoutUnavailable(await request(),read)).status,502);
});

const FOREIGN="33333333-3333-4333-8333-333333333333", CHECKOUT=`https://checkout.stripe.com/c/pay/${SESSION}`;
const now=() => new Date().toISOString();
Deno.test("actual composed runtime uses fixed production RPCs, live readback, RC import and real signed production proof", async () => {
  const values = await configurationInputs(); const originalFetch = globalThis.fetch;
  const rpcCalls: string[] = []; let operation: PurchaseOperation<"production"> | null = null, paid = false, imported = false, creates = 0;
  const sql = Object.assign((strings: TemplateStringsArray,...parameters: unknown[]) => {
    const rpc = /public\.([a-z_]+)\(/.exec(strings.join("?"))?.[1] ?? ""; rpcCalls.push(rpc); assert(!rpc.startsWith("qa_sandbox_"));
    if (rpc === "consume_rate_limit") { assert(String(parameters[0]).startsWith("checkout:")); return Promise.resolve([{ wait:0 }]); }
    if (rpc === "production_prepare_checkout_operation") {
      assertEquals(parameters.slice(3),[ADMISSION.surface,ADMISSION.build]);
      operation ??= { operation_id:parameters[0] as string,holder:parameters[1] as string,environment:"production",configuration_hash:parameters[2] as string,
        stripe_session_id:null,status:"prepared",creation_started_at:null,paid_at:null,created_at:now(),updated_at:now() };
      return Promise.resolve([{ result:{ ...operation } }]);
    }
    if (rpc === "production_claim_checkout_creation") {
      assertEquals(parameters.slice(3),[ADMISSION.surface,ADMISSION.build]);
      assert(operation); const claimed = operation.creation_started_at === null;
      operation = { ...operation,creation_started_at:operation.creation_started_at ?? now() };
      return Promise.resolve([{ result:{ operation:{ ...operation },claimed } }]);
    }
    if (rpc === "production_bind_checkout_session") {
      assert(operation); operation = { ...operation,stripe_session_id:parameters[2] as string,status:"session_bound" }; return Promise.resolve([{ result:{ ...operation } }]);
    }
    if (rpc === "production_read_checkout_operation") return Promise.resolve([{ result:operation ? { ...operation } : null }]);
    if (rpc === "production_record_checkout_status") {
      assert(operation); const status = parameters[2] as PurchaseOperationStatus;
      operation = { ...operation,status,paid_at:["paid_verified","import_pending","imported","access_observed"].includes(status) ? operation.paid_at ?? now() : operation.paid_at };
      return Promise.resolve([{ result:{ ...operation } }]);
    }
    if (rpc === "begin_access_observation") { assertEquals(parameters[1],"production"); return Promise.resolve([{ token:FOREIGN }]); }
    if (rpc === "read_linked_apple_transactions") { assertEquals(parameters[1],"production"); return Promise.resolve([{ result:[] }]); }
    if (rpc === "commit_access_observation") {
      assertEquals(parameters[1],"production"); const hasRights = (parameters[3] as unknown[]).length > 0, time = Date.now();
      const rights = hasRights ? [{ right:OP,holder:HOLDER,revision:1,verified_at:time }] : [];
      return Promise.resolve([{ result:{ status:"committed",rights,observed_rights:rights,revocations:[],issuer_time:time } }]);
    }
    if (rpc === "confirm_access_observation") { assertEquals(parameters[1],"production"); return Promise.resolve([{ confirmed:true }]); }
    throw new Error("Unexpected production RPC");
  },{ json:(value: unknown) => value }) as unknown as ReturnType<NonNullable<Parameters<typeof readProductionCheckoutRuntime>[1]>>;
  globalThis.fetch = (input,init) => {
    const url = String(input), respond = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value),{ headers:{"content-type":"application/json"} }));
    if (url === `${URL}/auth/v1/user`) return respond({ id:HOLDER,is_anonymous:false,email_confirmed_at:now() });
    if (url.startsWith("https://api.stripe.com")) {
      assertEquals(new Headers(init?.headers).get("Stripe-Version"),"2026-09-30.endive");
      assertEquals(new Headers(init?.headers).get("Authorization"),"Bearer sk_live_synthetic123");
      if (url.endsWith("/v1/account")) return respond({ object:"account",id:"acct_synthetic" });
      if (url.endsWith("/v1/payment_intents/pi_synthetic")) return respond({ object:"payment_intent",id:"pi_synthetic",livemode:true,currency:"usd",amount:999,status:"succeeded",latest_charge:"ch_synthetic" });
      if (url.endsWith("/v1/charges/ch_synthetic")) return respond({ object:"charge",id:"ch_synthetic",payment_intent:"pi_synthetic",livemode:true,currency:"usd",paid:true,status:"succeeded",amount:999,amount_refunded:0,refunded:false });
      assert(operation);
      if (init?.method === "POST") {
        creates++; const body = new URLSearchParams(init.body as string);
        assertEquals(body.get("managed_payments[enabled]"),"true"); assertEquals(body.get("metadata[operation_id]"),operation.operation_id);
      }
      if (url.includes("/line_items?")) return respond({ object:"list",has_more:false,data:[{ object:"item",quantity:1,currency:"usd",amount_subtotal:999,amount_total:999,
        price:{ object:"price",id:"price_synthetic",currency:"usd",livemode:true,type:"one_time",recurring:null,unit_amount:999,
          product:{ object:"product",id:"prod_synthetic",livemode:true } } }] });
      return respond({ object:"checkout.session",id:SESSION,livemode:true,mode:"payment",managed_payments:{ enabled:true },client_reference_id:HOLDER,
        metadata:{ operation_id:operation.operation_id },payment_intent:"pi_synthetic",currency:"usd",amount_subtotal:999,amount_total:999,status:paid ? "complete" : "open",payment_status:paid ? "paid" : "unpaid",url:CHECKOUT });
    }
    if (url === "https://api.revenuecat.com/v1/receipts") {
      assertEquals(JSON.parse(init?.body as string),{ fetch_token:SESSION,app_user_id:HOLDER });
      assertEquals(new Headers(init?.headers).get("X-Platform"),"stripe"); imported = true; return Promise.resolve(new Response(null,{ status:204 }));
    }
    // Real RevenueCat shape: the purchase names its entitlement; products come from the entitlement read.
    const entitlement = { object:"entitlement",id:"entl_synthetic",state:"active",project_id:"proj_synthetic",lookup_key:"still_pro_v3" };
    if (url === "https://api.revenuecat.com/v2/projects/proj_synthetic/entitlements/entl_synthetic?expand=product") {
      return respond({ ...entitlement,products:{ object:"list",next_page:null,items:[{ object:"product",id:"product_rc",state:"active",app_id:"app_live",store_identifier:"price_synthetic",type:"one_time",one_time:{ is_consumable:null } }] } });
    }
    assert(url.startsWith(`https://api.revenuecat.com/v2/projects/proj_synthetic/customers/${HOLDER}/purchases?environment=production`));
    return respond({ object:"list",next_page:null,items:imported ? [{ object:"purchase",id:"purchase_synthetic",customer_id:HOLDER,environment:"production",
      product_id:"product_rc",store:"stripe",status:"owned",ownership:"purchased",purchased_at:Date.now(),revenue_in_usd:{ currency:"USD",gross:9.99 },
      entitlements:{ object:"list",next_page:null,items:[entitlement] } }] : [] });
  };
  try {
    const runtime = await readProductionCheckoutRuntime(name => values[name],() => sql); assert(runtime);
    const first = await (await handleProductionCheckout(await request(),runtime,false)).json();
    assertEquals(first.checkout_url,CHECKOUT); assertEquals(first.status,"session_bound"); paid = true;
    const result = await (await handleProductionCheckout(await request({ access_schema:1,...ADMISSION,operation_id:first.operation_id }),runtime,true)).json();
    assertEquals(result.status,"access_observed"); assertEquals(result.access.status,"verified"); assertEquals(creates,1);
    const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g,"+").replace(/_/g,"/")),b => b.charCodeAt(0));
    const envelope = JSON.parse(result.access.proofs[0]), canonical = new TextDecoder().decode(decode(envelope.payload)), claims = JSON.parse(canonical);
    assertEquals([claims.holder,claims.environment,claims.kind],[HOLDER,"production","paid_account"]);
    const publicKey = await crypto.subtle.importKey("raw",Uint8Array.from(values.ACCESS_PROOF_PUBLIC_KEY_HEX.match(/../g)!,b => parseInt(b,16)),"Ed25519",false,["verify"]);
    assert(await crypto.subtle.verify("Ed25519",publicKey,decode(envelope.signature),new TextEncoder().encode("still-access-proof-v1\n"+canonical)));
    assertEquals(rpcCalls.some(rpc => rpc === "set_entitlement" || rpc.startsWith("qa_sandbox_")),false);
  } finally { globalThis.fetch = originalFetch; }
});
