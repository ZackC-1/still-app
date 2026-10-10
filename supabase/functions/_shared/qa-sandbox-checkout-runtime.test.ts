import { assert, assertEquals } from "@std/assert";
import { handleQaSandboxCreateCheckout, handleQaSandboxCompleteCheckout, readQaSandboxCheckoutConfig, readQaSandboxCheckoutRuntime, handleQaSandboxCheckoutUnavailable } from "./qa-sandbox-checkout-runtime.ts";
import type { QaSandboxCheckoutDeps } from "./qa-sandbox-checkout-runtime.ts";
import type { QaPurchaseOperation, QaPurchaseOperationStatus } from "./qa-purchase-operation-store.ts";
import { authenticatedClaims, signHs256 } from "./jwt.ts";

const HOLDER = "11111111-1111-1111-1111-111111111111";
const OP = "22222222-2222-2222-2222-222222222222";
const FOREIGN = "33333333-3333-3333-3333-333333333333";
const HASH = "a".repeat(64), SESSION = "cs_test_synthetic", SECRET = "synthetic-jwt-only", URL = "https://project.example.test";
const CHECKOUT = `https://checkout.stripe.com/c/pay/${SESSION}`;
const now = () => new Date().toISOString();
async function jwt(patch: Record<string, unknown> = {}) {
  return await signHs256({ sub: HOLDER, ...authenticatedClaims(URL), exp: Math.floor(Date.now()/1000)+600, ...patch }, SECRET);
}
function request(token: string, body: unknown = { access_schema: 1 }, method = "POST") {
  return new Request(`${URL}/functions/v1/qa`, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", "x-real-ip": "192.0.2.1" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
}
function setup() {
  const state = { enabled: true, confirmed: true, creates: 0, recoveries: 0, discoveries: 0, imports: 0,
    paid: false, expired: false, pending: false, unknown: false, knownUnknown: false, importFails: false, proof: false,
    alreadyEntitled: false, providerUnavailable: false, disableOnCreate: false, disableOnImport: false, disableOnSign: false, loseAuthOnSign: false, beginCalls: 0, commits: 0, disableOnHandoffFence: false, disableOnStatus: false, invalidateOnStatus: false, fence: true,
    foreignBody: false, wait: 0, row: null as QaPurchaseOperation | null };
  const calls: string[] = [];
  const row = (): QaPurchaseOperation => ({ operation_id: OP, holder: HOLDER, environment: "sandbox", configuration_hash: HASH,
    stripe_session_id: null, status: "prepared", creation_started_at: null, paid_at: null, created_at: now(), updated_at: now() });
  const outcome = () => state.unknown ? { status: "unknown" as const, ...(state.knownUnknown ? { sessionId: SESSION } : {}) } :
    state.paid || state.expired || state.pending ? { status: "recovered" as const, sessionId: SESSION,
      paymentState: state.paid ? "paid" as const : state.expired ? "expired_unpaid" as const : "payment_pending" as const } :
      { status: "created" as const, sessionId: SESSION, checkoutUrl: CHECKOUT };
  const deps: QaSandboxCheckoutDeps = { jwtSecret: SECRET, expected: authenticatedClaims(URL), configurationHash: HASH,
    accounts: { confirmed: (_token,holder) => Promise.resolve(state.confirmed && holder === HOLDER) }, membership: { enabled: () => Promise.resolve(state.enabled) },
    limiter: { consume: (key, max, window) => { calls.push(`${key.split(":").slice(0,2).join(":")}:${max}:${window}`); return Promise.resolve(state.wait); } },
    operations: {
      prepare: (_operation, holder, hash) => { assertEquals(holder,HOLDER); assertEquals(hash,HASH); state.row ??= row(); return Promise.resolve({ ...state.row }); },
      read: (operation, holder) => Promise.resolve(state.row?.operation_id === operation && state.row.holder === holder ? { ...state.row } : null),
      claimCreation: (_operation, _holder, _hash) => { assert(state.row); const claimed = state.row.creation_started_at === null;
        if (claimed) state.row = { ...state.row, creation_started_at: now() };
        if (!claimed && state.disableOnHandoffFence) { state.enabled = false; throw new Error("QA membership disabled"); }
        return Promise.resolve({ claimed, operation: { ...state.row } }); },
      bindSession: (_operation, holder, session, hash) => { assertEquals(holder,HOLDER); assertEquals(hash,HASH); assert(state.row?.creation_started_at);
        state.row = { ...state.row, stripe_session_id: session, status: state.row.status === "prepared" ? "session_bound" : state.row.status }; return Promise.resolve({ ...state.row }); },
      recordStatus: (_operation, session, status: QaPurchaseOperationStatus) => { assert(state.row); assertEquals(session,state.row.stripe_session_id);
        if (["refunded", "closed_unpaid"].includes(state.row.status) && status !== state.row.status) throw new Error("terminal checkout state");
        if (status === "closed_unpaid") assertEquals(state.row.paid_at,null);
        const transitions = ["session_bound:paid_verified","recovery_required:paid_verified","paid_verified:import_pending","recovery_required:import_pending","import_pending:imported","recovery_required:imported","imported:access_observed"];
        assert(state.row.status === status || status === "refunded" || status === "recovery_required" ||
          (status === "closed_unpaid" && ["session_bound","recovery_required"].includes(state.row.status)) || transitions.includes(`${state.row.status}:${status}`));
        state.row = { ...state.row, status, paid_at: ["paid_verified","import_pending","imported","access_observed","refunded"].includes(status) ? state.row.paid_at ?? now() : state.row.paid_at };
        calls.push(status); if (state.disableOnStatus && status === "access_observed") state.enabled = false; if (state.invalidateOnStatus && status === "access_observed") state.fence = false; return Promise.resolve({ ...state.row }); },
    },
    billing: {
      createCheckout: (operation,started) => { assert(Number.isSafeInteger(started) && started > 0 && started <= Date.now()); assertEquals(operation,{ operationId: OP, holderId: HOLDER }); state.creates++; if (state.disableOnCreate) state.enabled = false; return Promise.resolve(outcome()); },
      recoverCheckout: (operation, session) => { assertEquals(operation,{ operationId: OP, holderId: HOLDER }); assertEquals(session,SESSION); state.recoveries++; return Promise.resolve(outcome()); },
      recoverUnknownCheckout: (_operation, started) => { assert(Number.isSafeInteger(started)); state.discoveries++; return Promise.resolve(outcome()); },
      trackCompletedPurchase: (_operation, session) => { assertEquals(session,SESSION); state.imports++; if(state.disableOnImport) state.enabled = false; return Promise.resolve(state.importFails ? { status: "unavailable" as const } : { status: "tracked" as const }); },
    },
    access: {
      signer: { environment: "sandbox", sign: () => { if (state.disableOnSign) state.enabled = false; if(state.loseAuthOnSign) state.confirmed = false; return Promise.resolve("synthetic-proof"); } },
      provider: { getRights: () => Promise.resolve(state.providerUnavailable ? { status: "unavailable" } : { status: "verified", rights: (state.alreadyEntitled || (state.proof && state.imports > 0)) ? [{ key: "b".repeat(64), product: "still_pro_v3" }] : [] }) },
      rights: { begin: () => { state.beginCalls++; return Promise.resolve(FOREIGN); },
        commit: (_holder,_environment,_token,rights) => { state.commits++; const right = { right: OP, holder: HOLDER, revision: 1, verified_at: Date.now() };
          return Promise.resolve({ status: "committed", rights: rights.length ? [right] : [], observed_rights: rights.length ? [right] : [], revocations: [], issuer_time: Date.now() }); },
        confirm: () => Promise.resolve(state.fence && state.confirmed && state.enabled) },
    },
  };
  return { state, deps, calls, row };
}
Deno.test("checkout winner creates once; bound retry uses GET recovery", async () => {
  const s = setup(), token = await jwt();
  const first = await (await handleQaSandboxCreateCheckout(request(token),s.deps)).json();
  assertEquals(first.checkout_url,CHECKOUT); assertEquals(first.operation_id,OP); assertEquals(s.state.creates,1);
  const retry = await (await handleQaSandboxCreateCheckout(request(token,{ access_schema: 1, operation_id: OP }),s.deps)).json();
  assertEquals(retry.checkout_url,CHECKOUT); assertEquals([s.state.creates,s.state.recoveries],[1,1]);
});
Deno.test("paid import ACK cannot grant without independent current proof", async () => {
  const s = setup(); s.state.paid = true;
  const result = await (await handleQaSandboxCreateCheckout(request(await jwt()),s.deps)).json();
  assertEquals(result.access.status,"none"); assertEquals(s.state.row?.status,"imported"); assertEquals(s.state.imports,1);
});
Deno.test("unknown creation is persisted and retry never POSTs", async () => {
  const s = setup(); s.state.unknown = true; const token = await jwt();
  const first = await (await handleQaSandboxCreateCheckout(request(token),s.deps)).json();
  assertEquals(first.status,"recovery_required"); assertEquals(first.checkout_url,undefined);
  await handleQaSandboxCompleteCheckout(request(token,{ access_schema: 1, operation_id: OP }),s.deps);
  assertEquals([s.state.creates,s.state.discoveries],[1,1]);
});
Deno.test("concurrent requests share one creation claim", async () => {
  const s = setup(), token = await jwt();
  await Promise.all(Array.from({ length: 8 },() => handleQaSandboxCreateCheckout(request(token),s.deps)));
  assertEquals(s.state.creates,1); assert(s.state.row?.creation_started_at);
});
Deno.test("lost response with no operation ID resumes same holder's unresolved attempt", async () => {
  const s = setup(), token = await jwt();
  await handleQaSandboxCreateCheckout(request(token),s.deps);
  const retry = await (await handleQaSandboxCreateCheckout(request(token),s.deps)).json();
  assertEquals(retry.operation_id,OP); assertEquals([s.state.creates,s.state.recoveries],[1,1]);
});
Deno.test("known Session is bound even when subsequent readback is unknown", async () => {
  const s = setup(); s.state.unknown = true; s.state.knownUnknown = true; const token = await jwt();
  await handleQaSandboxCreateCheckout(request(token),s.deps);
  assertEquals(s.state.row?.stripe_session_id,SESSION); assertEquals(s.state.row?.status,"recovery_required");
  await handleQaSandboxCompleteCheckout(request(token,{ access_schema: 1, operation_id: OP }),s.deps);
  assertEquals([s.state.creates,s.state.recoveries,s.state.discoveries],[1,1,0]);
});
Deno.test("complete unpaid payment remains pending and cannot start another operation", async () => {
  const s = setup(); s.state.pending = true; const token = await jwt();
  const result = await (await handleQaSandboxCreateCheckout(request(token),s.deps)).json();
  assertEquals(result.status,"session_bound"); assertEquals(result.checkout_url,undefined); assertEquals(s.state.imports,0);
  await handleQaSandboxCreateCheckout(request(token),s.deps);
  assertEquals(s.state.creates,1); assertEquals(s.state.row?.status,"session_bound");
});
Deno.test("canonical expired unpaid attempt closes; prior paid state cannot close", async () => {
  const s = setup(); s.state.expired = true;
  const result = await (await handleQaSandboxCreateCheckout(request(await jwt()),s.deps)).json();
  assertEquals(result.status,"closed_unpaid"); assertEquals(s.state.imports,0);
  const paid = setup(); paid.state.row = { ...paid.row(), creation_started_at: now(), stripe_session_id: SESSION, status: "recovery_required", paid_at: now() }; paid.state.expired = true;
  assertEquals((await handleQaSandboxCompleteCheckout(request(await jwt(),{ access_schema: 1,operation_id: OP }),paid.deps)).status,502);
  assertEquals(paid.state.row.status,"recovery_required");
});
Deno.test("import failure retains paid operation and a later retry uses same Session", async () => {
  const s = setup(); s.state.paid = true; s.state.importFails = true; const token = await jwt();
  const first = await (await handleQaSandboxCreateCheckout(request(token),s.deps)).json();
  assertEquals(first.status,"recovery_required"); assert(s.state.row?.paid_at); assertEquals(s.state.row?.stripe_session_id,SESSION);
  s.state.importFails = false; s.state.proof = true;
  const retry = await (await handleQaSandboxCompleteCheckout(request(token,{ access_schema:1, operation_id:OP }),s.deps)).json();
  assertEquals([s.state.creates,s.state.imports],[1,2]); assertEquals(retry.access.status,"verified"); assertEquals(retry.status,"access_observed");
  await handleQaSandboxCompleteCheckout(request(token,{ access_schema:1, operation_id:OP }),s.deps);
  assertEquals(s.state.imports,2); assertEquals(s.state.row?.status,"access_observed");
});
Deno.test("membership disablement after provider latency suppresses checkout URL", async () => {
  const s = setup(); s.state.disableOnCreate = true;
  const result = await (await handleQaSandboxCreateCheckout(request(await jwt()),s.deps)).json();
  assertEquals(result.checkout_url,undefined); assertEquals(s.state.row?.stripe_session_id,SESSION);
});
Deno.test("disabled membership permits existing paid recovery and import but never proof", async () => {
  const s = setup(); s.state.row = { ...s.row(),creation_started_at:now(),stripe_session_id:SESSION,status:"session_bound" };
  s.state.enabled = false; s.state.paid = true; s.state.proof = true;
  const result = await (await handleQaSandboxCompleteCheckout(request(await jwt(),{ access_schema:1,operation_id:OP }),s.deps)).json();
  assertEquals(result.access.status,"unavailable"); assertEquals(s.state.imports,1); assertEquals(s.state.creates,0); assertEquals(s.state.row.status,"imported");
});
Deno.test("membership loss during import or signing cannot emit a proof", async () => {
  for (const stage of ["disableOnImport","disableOnSign","loseAuthOnSign"] as const) {
    const s = setup(); s.state[stage] = true; s.state.paid = true; s.state.proof = true;
    const response = await handleQaSandboxCreateCheckout(request(await jwt()),s.deps);
    const result = await response.json(); assertEquals(result.access?.proofs?.length ?? 0,0);
    assert(s.state.row?.status !== "access_observed");
  }
});
Deno.test("foreign operation and body-supplied identity/config/Session are rejected", async () => {
  const s = setup(), token = await jwt();
  const missing = await handleQaSandboxCompleteCheckout(request(token,{ access_schema:1,operation_id:FOREIGN }),s.deps);
  assertEquals(missing.status,404);
  for (const field of ["holder","user_id","environment","configuration_hash","stripe_session_id","checkout_url"]) {
    assertEquals((await handleQaSandboxCreateCheckout(request(token,{ access_schema:1,[field]:FOREIGN }),s.deps)).status,400);
  }
  assertEquals(s.state.creates,0);
});
Deno.test("changed immutable configuration fails before any provider work", async () => {
  const s = setup(); s.state.row = { ...s.row(),configuration_hash:"c".repeat(64),creation_started_at:now(),stripe_session_id:SESSION,status:"session_bound" };
  assertEquals((await handleQaSandboxCompleteCheckout(request(await jwt(),{ access_schema:1,operation_id:OP }),s.deps)).status,502);
  assertEquals([s.state.creates,s.state.recoveries,s.state.imports],[0,0,0]);
});
Deno.test("complete cannot create an unstarted operation; disabled subjects cannot initiate", async () => {
  const s = setup(); s.state.row = s.row();
  await handleQaSandboxCompleteCheckout(request(await jwt(),{ access_schema:1,operation_id:OP }),s.deps);
  assertEquals(s.state.creates,0); assertEquals(s.state.row.creation_started_at,null);
  const disabled = setup(); disabled.state.enabled = false;
  assertEquals((await handleQaSandboxCreateCheckout(request(await jwt()),disabled.deps)).status,403); assertEquals(disabled.state.row,null);
});
Deno.test("strict authenticated/live confirmed contract and bounded closed checkout rate", async () => {
  const s = setup();
  for (const patch of [{ is_anonymous:true },{ exp:0 },{ exp:undefined },{ sub:FOREIGN }]) {
    const response = await handleQaSandboxCreateCheckout(request(await jwt(patch)),s.deps); assert([401,403].includes(response.status));
  }
  s.state.confirmed = false; assertEquals((await handleQaSandboxCreateCheckout(request(await jwt()),s.deps)).status,403);
  s.state.confirmed = true; s.state.wait = 17;
  const limited = await handleQaSandboxCreateCheckout(request(await jwt()),s.deps);
  assertEquals(limited.status,429); assertEquals(limited.headers.get("retry-after"),"17"); assertEquals(s.state.creates,0);
  assert(s.calls.includes("checkout:user:5:60"));
});
Deno.test("known existing account purchase stops new handoff; unknown first-customer lookup does not grant", async () => {
  const current = setup(); current.state.alreadyEntitled = true;
  assertEquals((await handleQaSandboxCreateCheckout(request(await jwt()),current.deps)).status,409); assertEquals(current.state.creates,0);
  const unknown = setup(); unknown.state.providerUnavailable = true;
  const result = await (await handleQaSandboxCreateCheckout(request(await jwt()),unknown.deps)).json();
  assertEquals(result.checkout_url,CHECKOUT); assertEquals(result.access,undefined);
});
const b64 = (bytes: ArrayBuffer) => btoa(Array.from(new Uint8Array(bytes),b => String.fromCharCode(b)).join(""));
async function configurationInputs(): Promise<Record<string,string>> {
  const keys = await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]); assert("privateKey" in keys);
  const apple = await crypto.subtle.generateKey({ name:"ECDSA",namedCurve:"P-256" },true,["sign","verify"]);
  return { SUPABASE_URL:URL,SUPABASE_ANON_KEY:"synthetic-public",SUPABASE_JWT_SECRET:SECRET,
    STILL_QA_SANDBOX_ENTITLEMENT_WRITER_DB_URL:"postgres://still_qa_sandbox_writer:synthetic@db.example.test/postgres",
    STILL_QA_SANDBOX_ACCESS_PROOF_KEY_ID:"qa-synthetic",
    STILL_QA_SANDBOX_ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64:b64(await crypto.subtle.exportKey("pkcs8",keys.privateKey)),
    STILL_QA_SANDBOX_ACCESS_PROOF_PUBLIC_KEY_HEX:Array.from(new Uint8Array(await crypto.subtle.exportKey("raw",keys.publicKey)),b => b.toString(16).padStart(2,"0")).join(""),
    STILL_QA_SANDBOX_ACCESS_APPLE_PRODUCTS_JSON:JSON.stringify([{ bundleId:"com.example.still",appAppleId:1234,productId:"still_pro_v3" }]),
    STILL_QA_SANDBOX_APP_STORE_SERVER_PRIVATE_KEY:`-----BEGIN PRIVATE KEY-----\n${b64(await crypto.subtle.exportKey("pkcs8",apple.privateKey))}\n-----END PRIVATE KEY-----`,
    STILL_QA_SANDBOX_APP_STORE_SERVER_KEY_ID:"TESTKEY123",STILL_QA_SANDBOX_APP_STORE_SERVER_ISSUER_ID:HOLDER,
    STILL_QA_SANDBOX_STRIPE_SECRET_API_KEY:"sk_test_synthetic123",STILL_QA_SANDBOX_STRIPE_ACCOUNT_ID:"acct_synthetic",
    STILL_QA_SANDBOX_STRIPE_API_VERSION:"2026-09-30.endive",STILL_QA_SANDBOX_STRIPE_PRICE_ID:"price_synthetic",STILL_QA_SANDBOX_STRIPE_PRODUCT_ID:"prod_synthetic",
    STILL_QA_SANDBOX_REVENUECAT_STRIPE_PUBLIC_API_KEY:"syntheticStripePublic",STILL_QA_SANDBOX_WEB_RETURN_ORIGIN:"https://return.example.test",
    STILL_QA_SANDBOX_WEB_RETURN_PATHS_JSON:JSON.stringify({ success:"/checkout/success",cancel:"/checkout/cancel" }),
    STILL_QA_SANDBOX_REVENUECAT_PROJECT_ID:"proj_synthetic",STILL_QA_SANDBOX_REVENUECAT_ACCESS_SECRET_API_KEY:"synthetic-qa-server",
    STILL_QA_SANDBOX_ACCESS_PROVIDER_PRODUCTS_JSON:JSON.stringify([{ product_id:"product_rc",app_id:"app_qa",store:"stripe",store_identifier:"price_synthetic",entitlement_lookup_key:"still_pro_v3",benefit_product:"still_pro_v3" }]),
  };
}
Deno.test("a Stripe mapping must name the exact configured sandbox price", async () => {
  const values = await configurationInputs();
  assert(await readQaSandboxCheckoutConfig(name => values[name]));
  for (const storeIdentifier of ["prod_synthetic","price_other",""]) {
    const mapping = JSON.parse(values.STILL_QA_SANDBOX_ACCESS_PROVIDER_PRODUCTS_JSON)[0];
    const changed: Record<string,string> = { ...values, STILL_QA_SANDBOX_ACCESS_PROVIDER_PRODUCTS_JSON:JSON.stringify([{ ...mapping,store_identifier:storeIdentifier }]) };
    assertEquals(await readQaSandboxCheckoutConfig(name => changed[name]),null,storeIdentifier);
  }
  assertEquals(await readQaSandboxCheckoutConfig(name => ({ ...values,STILL_QA_SANDBOX_STRIPE_PRICE_ID:"price_other" } as Record<string,string>)[name]),null);
});
Deno.test("closed sandbox config validates real key pairs and freezes complete private binding fingerprints", async () => {
  const values = await configurationInputs(); const config = await readQaSandboxCheckoutConfig(name => values[name]); assert(config);
  assertEquals(config.billing.successUrl,"https://return.example.test/checkout/success"); assertEquals(config.apple.environment,"sandbox");
  assert(/^[a-f0-9]{64}$/.test(config.configurationHash));
  for (const name of ["STILL_QA_SANDBOX_STRIPE_SECRET_API_KEY","STILL_QA_SANDBOX_REVENUECAT_ACCESS_SECRET_API_KEY","STILL_QA_SANDBOX_REVENUECAT_STRIPE_PUBLIC_API_KEY","SUPABASE_JWT_SECRET"]) {
    const changed = await readQaSandboxCheckoutConfig(key => key === name ? values[key]+"changed" : values[key]); assert(changed); assert(changed.configurationHash !== config.configurationHash);
  }
});
Deno.test("missing closed inputs never fall back to live provider config or create SQL", async () => {
  const values = await configurationInputs(); let sqlCalls = 0;
  for (const name of Object.keys(values).filter(key => key.startsWith("STILL_QA_SANDBOX_"))) {
    const read = (key: string) => key === name ? undefined : values[key] ?? (key.startsWith("STILL_QA_SANDBOX_") ? undefined : "live-provider-value");
    assertEquals(await readQaSandboxCheckoutRuntime(read,() => { sqlCalls++; throw new Error("SQL must not initialize"); }),null);
  }
  assertEquals(sqlCalls,0);
});
Deno.test("wrong versions, native/secret import keys, ambiguous mapping and return paths fail closed", async () => {
  const values = await configurationInputs();
  const patches = [
    { STRIPE_API_VERSION:"latest" },{ STRIPE_SECRET_API_KEY:"sk_live_synthetic" },{ REVENUECAT_STRIPE_PUBLIC_API_KEY:"appl_native" },
    { REVENUECAT_STRIPE_PUBLIC_API_KEY:"sk_server" },{ WEB_RETURN_ORIGIN:"https://return.example.test/" },{ WEB_RETURN_ORIGIN:"https://evil.test/a" },
    { WEB_RETURN_PATHS_JSON:JSON.stringify({ success:"//evil.test",cancel:"/cancel" }) },
    { WEB_RETURN_PATHS_JSON:JSON.stringify({ success:"/success?redirect=x",cancel:"/cancel" }) },
    { WEB_RETURN_PATHS_JSON:JSON.stringify({ success:"/../success",cancel:"/cancel" }) },
    { WEB_RETURN_PATHS_JSON:JSON.stringify({ success:"/success",cancel:"/cancel",other:"/extra" }) },
    { ACCESS_PROVIDER_PRODUCTS_JSON:"[]" },{ REVENUECAT_ACCESS_SECRET_API_KEY:"bad secret" },
  ];
  for (const patch of patches) assertEquals(await readQaSandboxCheckoutConfig(key => patch[key.slice("STILL_QA_SANDBOX_".length) as keyof typeof patch] ?? values[key]),null);
});
Deno.test("unconfigured routes still enforce method and JWT contract", async () => {
  const read = (key: string) => ({ SUPABASE_URL:URL,SUPABASE_JWT_SECRET:SECRET } as Record<string,string>)[key];
  assertEquals((await handleQaSandboxCheckoutUnavailable(new Request(URL,{ method:"POST" }),read)).status,401);
  assertEquals((await handleQaSandboxCheckoutUnavailable(request(await jwt()),read)).status,502);
  assertEquals((await handleQaSandboxCheckoutUnavailable(request(await jwt(),undefined,"GET"),read)).status,405);
  assertEquals((await handleQaSandboxCheckoutUnavailable(request(await jwt(),undefined,"OPTIONS"),read)).status,204);
});
Deno.test("final atomic membership fence prevents URL after admission changes", async () => {
  const s = setup(); s.state.disableOnHandoffFence = true;
  const result = await (await handleQaSandboxCreateCheckout(request(await jwt()),s.deps)).json();
  assertEquals(result.checkout_url,undefined); assertEquals(s.state.creates,1); assertEquals(s.state.row?.stripe_session_id,SESSION);
});
Deno.test("final access confirmation after operation-status latency prevents late proof delivery", async () => {
  const s = setup(); s.state.disableOnStatus = true; s.state.paid = true; s.state.proof = true;
  const result = await (await handleQaSandboxCreateCheckout(request(await jwt()),s.deps)).json();
  assertEquals(result.access.status,"unavailable"); assertEquals(result.access.proofs,undefined);
});
Deno.test("malformed/oversized requests cannot enter provider composition", async () => {
  const s = setup(), token = await jwt();
  for (const value of [null,[],{ access_schema:2 },{ access_schema:1,operation_id:"bad" },{ access_schema:1,padding:"a".repeat(4096) }]) {
    assertEquals((await handleQaSandboxCreateCheckout(request(token,value),s.deps)).status,400);
  }
  assertEquals(s.state.creates,0);
});
Deno.test("final SQL observation fence prevents proof invalidated during status persistence", async () => {
  const s = setup(); s.state.invalidateOnStatus = true; s.state.paid = true; s.state.proof = true;
  const result = await (await handleQaSandboxCreateCheckout(request(await jwt()),s.deps)).json();
  assertEquals(result.access.status,"unavailable"); assertEquals(result.access.proofs,undefined); assertEquals(s.state.enabled,true);
});
Deno.test("JWT expiry during live Auth latency cannot extend checkout authority", async () => {
  const s = setup(); const realNow = Date.now; let clock = realNow();
  const token = await jwt({ exp: Math.floor(clock/1000)+2 });
  Date.now = () => clock;
  s.deps.accounts.confirmed = () => { clock += 3000; return Promise.resolve(true); };
  try {
    assertEquals((await handleQaSandboxCreateCheckout(request(token),s.deps)).status,403);
    assertEquals(s.state.creates,0);
  } finally { Date.now = realNow; }
});
Deno.test("refund persisted after import admission prevents the receipt POST", async () => {
  const s = setup(); s.state.paid = true;
  s.state.row = { ...s.row(), creation_started_at: now(), stripe_session_id: SESSION, status: "session_bound" };
  const record = s.deps.operations.recordStatus.bind(s.deps.operations);
  s.deps.operations.recordStatus = async (...args) => {
    const admitted = await record(...args);
    if (args[2] === "import_pending") s.state.row = { ...admitted, status: "refunded" };
    return admitted;
  };
  const result = await (await handleQaSandboxCompleteCheckout(request(await jwt(), { access_schema: 1, operation_id: OP }), s.deps)).json();
  assertEquals(s.state.imports, 0); assertEquals(s.state.row.status, "refunded");
  assertEquals(result.access?.proofs?.length ?? 0, 0);
});
Deno.test("refund during canonical provider latency prevents a positive rights commit", async () => {
  const s = setup(); s.state.paid = true; s.state.proof = true;
  s.state.row = { ...s.row(), creation_started_at: now(), stripe_session_id: SESSION, status: "session_bound" };
  const getRights = s.deps.access!.provider.getRights.bind(s.deps.access!.provider);
  s.deps.access!.provider.getRights = (...args) => {
    assert(s.state.row); s.state.row = { ...s.state.row, status: "refunded" };
    return getRights(...args);
  };
  let positives = 0;
  const commit = s.deps.access!.rights.commit.bind(s.deps.access!.rights);
  s.deps.access!.rights.commit = (...args) => {
    if (args[3].some(right => right.state !== "revoked")) positives++;
    return commit(...args);
  };
  const result = await (await handleQaSandboxCompleteCheckout(request(await jwt(), { access_schema: 1, operation_id: OP }), s.deps)).json();
  assertEquals(positives, 0); assertEquals(s.state.row.status, "refunded");
  assertEquals(result.access?.proofs?.length ?? 0, 0);
});
Deno.test("refund during an in-flight receipt import cannot publish a proof", async () => {
  const s = setup(); s.state.paid = true; s.state.proof = true;
  s.state.row = { ...s.row(), creation_started_at: now(), stripe_session_id: SESSION, status: "session_bound" };
  const track = s.deps.billing.trackCompletedPurchase.bind(s.deps.billing);
  s.deps.billing.trackCompletedPurchase = async (...args) => {
    const result = await track(...args);
    assert(s.state.row); s.state.row = { ...s.state.row, status: "refunded" };
    return result;
  };
  const result = await (await handleQaSandboxCompleteCheckout(request(await jwt(), { access_schema: 1, operation_id: OP }), s.deps)).json();
  assertEquals(s.state.imports, 1); assertEquals(s.state.row.status, "refunded");
  assertEquals(s.state.commits, 0); assertEquals(result.access?.proofs?.length ?? 0, 0);
});
Deno.test("actual composed runtime uses fixed QA RPCs, managed readback, RC import and real signed sandbox proof", async () => {
  const values = await configurationInputs(); const originalFetch = globalThis.fetch;
  const rpcCalls: string[] = []; let operation: QaPurchaseOperation | null = null, paid = false, imported = false, creates = 0;
  const sql = Object.assign((strings: TemplateStringsArray,...parameters: unknown[]) => {
    const rpc = /public\.([a-z_]+)\(/.exec(strings.join("?"))?.[1] ?? ""; rpcCalls.push(rpc); assert(rpc.startsWith("qa_sandbox_"));
    if (rpc === "qa_sandbox_consume_rate_limit") { assert(String(parameters[0]).startsWith("qa-sandbox-checkout:")); return Promise.resolve([{ wait:0 }]); }
    if (rpc === "qa_sandbox_account_enabled") return Promise.resolve([{ enabled:true }]);
    if (rpc === "qa_sandbox_prepare_checkout_operation") {
      operation ??= { operation_id:parameters[0] as string,holder:parameters[1] as string,environment:"sandbox",configuration_hash:parameters[2] as string,
        stripe_session_id:null,status:"prepared",creation_started_at:null,paid_at:null,created_at:now(),updated_at:now() };
      return Promise.resolve([{ result:{ ...operation } }]);
    }
    if (rpc === "qa_sandbox_claim_checkout_creation") {
      assert(operation); const claimed = operation.creation_started_at === null;
      operation = { ...operation,creation_started_at:operation.creation_started_at ?? now() };
      return Promise.resolve([{ result:{ operation:{ ...operation },claimed } }]);
    }
    if (rpc === "qa_sandbox_bind_checkout_session") {
      assert(operation); operation = { ...operation,stripe_session_id:parameters[2] as string,status:"session_bound" }; return Promise.resolve([{ result:{ ...operation } }]);
    }
    if (rpc === "qa_sandbox_read_checkout_operation") return Promise.resolve([{ result:operation ? { ...operation } : null }]);
    if (rpc === "qa_sandbox_record_checkout_status") {
      assert(operation); const status = parameters[2] as QaPurchaseOperationStatus;
      operation = { ...operation,status,paid_at:["paid_verified","import_pending","imported","access_observed"].includes(status) ? operation.paid_at ?? now() : operation.paid_at };
      return Promise.resolve([{ result:{ ...operation } }]);
    }
    if (rpc === "qa_sandbox_begin_access_observation") return Promise.resolve([{ token:FOREIGN }]);
    if (rpc === "qa_sandbox_read_linked_apple_transactions") return Promise.resolve([{ result:[] }]);
    if (rpc === "qa_sandbox_commit_access_observation") {
      const hasRights = (parameters[2] as unknown[]).length > 0, time = Date.now();
      const rights = hasRights ? [{ right:OP,holder:HOLDER,revision:1,verified_at:time }] : [];
      return Promise.resolve([{ result:{ status:"committed",rights,observed_rights:rights,revocations:[],issuer_time:time } }]);
    }
    if (rpc === "qa_sandbox_confirm_access_observation") return Promise.resolve([{ confirmed:true }]);
    throw new Error("Unexpected fixed QA RPC");
  },{ json:(value: unknown) => value }) as unknown as ReturnType<NonNullable<Parameters<typeof readQaSandboxCheckoutRuntime>[1]>>;
  globalThis.fetch = (input,init) => {
    const url = String(input), respond = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value),{ headers:{"content-type":"application/json"} }));
    if (url === `${URL}/auth/v1/user`) return respond({ id:HOLDER,is_anonymous:false,email_confirmed_at:now() });
    if (url.startsWith("https://api.stripe.com")) {
      assertEquals(new Headers(init?.headers).get("Stripe-Version"),"2026-09-30.endive");
      assertEquals(new Headers(init?.headers).get("Authorization"),"Bearer sk_test_synthetic123");
      if (url.endsWith("/v1/account")) return respond({ object:"account",id:"acct_synthetic" });
      if (url.endsWith("/v1/payment_intents/pi_synthetic")) return respond({ object:"payment_intent",id:"pi_synthetic",livemode:false,currency:"usd",amount:999,status:"succeeded",latest_charge:"ch_synthetic" });
      if (url.endsWith("/v1/charges/ch_synthetic")) return respond({ object:"charge",id:"ch_synthetic",payment_intent:"pi_synthetic",livemode:false,currency:"usd",paid:true,status:"succeeded",amount:999,amount_refunded:0,refunded:false });
      assert(operation);
      if (init?.method === "POST") {
        creates++; const body = new URLSearchParams(init.body as string);
        assertEquals(body.get("managed_payments[enabled]"),"true"); assertEquals(body.get("metadata[operation_id]"),operation.operation_id);
      }
      if (url.includes("/line_items?")) return respond({ object:"list",has_more:false,data:[{ object:"item",quantity:1,currency:"usd",amount_subtotal:999,amount_total:999,
        price:{ object:"price",id:"price_synthetic",currency:"usd",livemode:false,type:"one_time",recurring:null,unit_amount:999,
          product:{ object:"product",id:"prod_synthetic",livemode:false } } }] });
      return respond({ object:"checkout.session",id:SESSION,livemode:false,mode:"payment",managed_payments:{ enabled:true },client_reference_id:HOLDER,
        metadata:{ operation_id:operation.operation_id },payment_intent:"pi_synthetic",currency:"usd",amount_subtotal:999,amount_total:999,status:paid ? "complete" : "open",payment_status:paid ? "paid" : "unpaid",url:CHECKOUT });
    }
    if (url === "https://api.revenuecat.com/v1/receipts") {
      assertEquals(JSON.parse(init?.body as string),{ fetch_token:SESSION,app_user_id:HOLDER });
      assertEquals(new Headers(init?.headers).get("X-Platform"),"stripe"); imported = true; return Promise.resolve(new Response(null,{ status:204 }));
    }
    // Real RevenueCat shape: the purchase names its entitlement; products come from the entitlement read.
    const entitlement = { object:"entitlement",id:"entl_synthetic",state:"active",project_id:"proj_synthetic",lookup_key:"still_pro_v3" };
    if (url === "https://api.revenuecat.com/v2/projects/proj_synthetic/entitlements/entl_synthetic?expand=product") {
      return respond({ ...entitlement,products:{ object:"list",next_page:null,items:[{ object:"product",id:"product_rc",state:"active",app_id:"app_qa",store_identifier:"price_synthetic",type:"one_time",one_time:{ is_consumable:null } }] } });
    }
    assert(url.startsWith(`https://api.revenuecat.com/v2/projects/proj_synthetic/customers/${HOLDER}/purchases?environment=sandbox`));
    return respond({ object:"list",next_page:null,items:imported ? [{ object:"purchase",id:"purchase_synthetic",customer_id:HOLDER,environment:"sandbox",
      product_id:"product_rc",store:"stripe",status:"owned",ownership:"purchased",purchased_at:Date.now(),revenue_in_usd:{ currency:"USD",gross:9.99 },
      entitlements:{ object:"list",next_page:null,items:[entitlement] } }] : [] });
  };
  try {
    const runtime = await readQaSandboxCheckoutRuntime(name => values[name],() => sql); assert(runtime);
    const first = await (await handleQaSandboxCreateCheckout(request(await jwt()),runtime)).json();
    assertEquals(first.checkout_url,CHECKOUT); assertEquals(first.status,"session_bound"); paid = true;
    const result = await (await handleQaSandboxCompleteCheckout(request(await jwt(),{ access_schema:1,operation_id:first.operation_id }),runtime)).json();
    assertEquals(result.status,"access_observed"); assertEquals(result.access.status,"verified"); assertEquals(creates,1);
    const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g,"+").replace(/_/g,"/")),b => b.charCodeAt(0));
    const envelope = JSON.parse(result.access.proofs[0]), canonical = new TextDecoder().decode(decode(envelope.payload)), claims = JSON.parse(canonical);
    assertEquals([claims.holder,claims.environment,claims.kind],[HOLDER,"sandbox","paid_account"]);
    const publicKey = await crypto.subtle.importKey("raw",Uint8Array.from(values.STILL_QA_SANDBOX_ACCESS_PROOF_PUBLIC_KEY_HEX.match(/../g)!,b => parseInt(b,16)),"Ed25519",false,["verify"]);
    assert(await crypto.subtle.verify("Ed25519",publicKey,decode(envelope.signature),new TextEncoder().encode("still-access-proof-v1\n"+canonical)));
    assertEquals(rpcCalls.some(rpc => rpc === "set_entitlement" || !rpc.startsWith("qa_sandbox_")),false);
  } finally { globalThis.fetch = originalFetch; }
});
