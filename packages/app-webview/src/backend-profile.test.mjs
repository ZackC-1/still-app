import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";
import { backendRoutes, backendRouteEnvironmentMatches, readBackendRouteProfile } from "@still/core/sync/backend-route-profile";

// Execute the real entry's construction and fulfillment closures with controlled platform ports.
// This does not simulate WebKit, StoreKit, or a hosted backend.
const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import[\s\S]*?;\n/gm, "").replaceAll("import.meta.env", "compiledEnv");
let profileBindings = {};
try {
  const profileSource = await readFile(new URL("./backend-profile.ts", import.meta.url), "utf8");
  const profileCode = ts.transpileModule(profileSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/^import[\s\S]*?;\n/gm, "").replaceAll("export function", "function");
  const context = { backendRoutes, backendRouteEnvironmentMatches, readBackendRouteProfile, AbortSignal };
  vm.runInNewContext(`${profileCode}\nglobalThis.bindings = { readAppleBackendProfile, createAppleFulfillmentTransport };`, context);
  profileBindings = context.bindings;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function launch(env = {}, responseError = null) {
  const calls = [];
  let clientCount = 0;
  let backendOptions;
  let authority;
  let sessionDeps;
  let authEvent;
  let invalidations = 0;
  let accountRefreshes = 0;
  const events = [];
  let analyticsFactory;
  let analyticsDeps;
  let subjectIssuerClient;
  const analyticsStub = () => ({ ui: {}, start: async () => {}, accountAbsent: async () => {}, identifyAccount: async () => {}, recheckSetup: async () => {} });
  const client = {
    functions: { invoke: async (name, options) => { calls.push({ name, options }); return { data: { synthetic: true }, error: responseError }; } },
    auth: { onAuthStateChange(callback) { authEvent = callback; }, getSession: async () => ({ data: { session: null } }) },
  };
  class Bridge {
    available = true;
    setAccountSyncStatus = async () => {};
    price = async () => null;
  }
  const context = {
    ...profileBindings,
    compiledEnv: { VITE_SUPABASE_URL: "https://example.invalid", VITE_SUPABASE_ANON_KEY: "public-synthetic", VITE_MODERN_SETTINGS_SYNC_ENABLED: "true", ...env },
    mount() {}, App: {}, PAID_TIER_ENABLED: true,
    selectAppleSettingsMode: ({ modernSyncFlag }) => modernSyncFlag === "true" ? "atomic-cloud" : "legacy",
    WKWebViewStorageAdapter: class {},
    SettingsCache: class { watch() {} hydrate = async () => {}; whenHydrated = async () => {}; },
    NativeBridge: Bridge,
    appleSettingsCacheOptions: () => ({}),
    buildChannelEnvelope: value => value === "test" ? { build_channel: "test" } : undefined,
    createAppAnalytics: (deps) => { analyticsFactory = "2.x"; analyticsDeps = deps; return analyticsStub(); },
    createDefaultOnAppAnalytics: (deps) => { analyticsFactory = "default-on"; analyticsDeps = deps; return analyticsStub(); },
    supabaseSubjectIssuer: (client) => { subjectIssuerClient = client; return async () => ({ state: "active", subject: "synthetic" }); },
    createClient() { clientCount++; return client; },
    SupabaseAuthPort: class { currentVerifiedAccount = async () => ({ id: "synthetic", emailConfirmed: true }); },
    packagedAccessTrust: config => ({ environment: config.environment === "sandbox" ? "sandbox" : "production", keys: [] }),
    createApplePurchaseAuthority(deps) { authority = deps; return { invalidateAccount: () => {invalidations++;}, refreshAccountAccess: async () => {accountRefreshes++;}, verifyLocalPurchase: async () => ({}), refreshOwnership: async () => {}, ownershipRevision: () => 0, purchaseLink: {}, readLinkEligibility: async () => null }; },
    SupabaseBackendPort: class { constructor(_client, options) { backendOptions = options; } },
    SyncService: class {},
    UiController: class { rehydrateCodeEntry() {} },
    createAppleSession: deps => {sessionDeps = deps; return { resumeAccount: async () => {}, refreshReceipt: async () => {} };},
    document: { addEventListener() {}, getElementById: () => ({}), visibilityState: "visible" },
    window: { addEventListener() {}, dispatchEvent(event) {events.push(event.type);} },
    bindTextScale() {},
    SAFARI_SURFACE_GUIDANCE: {},
    AbortSignal, atob, Event,
    isAccessUUID: value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value),
  };
  vm.runInNewContext(compiled, context, { filename: "main.ts", importModuleDynamically: async () => { throw new Error("Controlled dynamic screen import"); } });
  return { analyticsFactory, analyticsDeps, subjectIssuerClient: () => subjectIssuerClient, calls, clientCount, backendOptions, authority, sessionDeps, events, authEvent: event => authEvent(event), invalidations: () => invalidations, accountRefreshes: () => accountRefreshes };
}

test("usage analytics is on by default exactly where the V3 screens are", () => {
  assert.equal(launch().analyticsFactory, "default-on");
  assert.equal(launch({ VITE_MODERN_SETTINGS_SYNC_ENABLED: undefined }).analyticsFactory, "2.x");
});

test("V3 signed-in devices ask for their own identity through the configured client; 2.x never does", async () => {
  const v3 = launch();
  assert.equal(typeof v3.analyticsDeps.issueSubject, "function");
  assert.ok(v3.subjectIssuerClient(), "the issuer uses the app's configured Supabase client");
  assert.deepEqual(await v3.analyticsDeps.issueSubject({ originProof: "a".repeat(64) }, new AbortController().signal, "synthetic"), { state: "active", subject: "synthetic" });
  const legacy = launch({ VITE_MODERN_SETTINGS_SYNC_ENABLED: undefined });
  assert.equal("issueSubject" in legacy.analyticsDeps, false);
  assert.equal(legacy.subjectIssuerClient(), undefined);
});

test("explicit QA profile routes both Apple fulfillment requests and modern sync to QA", async () => {
  const host = launch({ VITE_BACKEND_ROUTE_PROFILE: "shared-hosted-sandbox", VITE_ACCESS_ENVIRONMENT: "sandbox" });
  assert.equal(host.clientCount, 1);
  const transaction = { schema: 1, transaction: { synthetic: true } };
  const link = { intendedAccountId: "synthetic", operationId: "synthetic-operation" };
  await host.authority.verifyLocal(transaction);
  await host.authority.fulfillLink(link);
  assert.deepEqual(host.calls.map(call => call.name), ["qa-sandbox-verify-apple-access", "qa-sandbox-link-apple-access"]);
  assert.equal(host.calls[0].options.body, transaction);
  assert.equal(host.calls[1].options.body, link);
  assert.equal(host.backendOptions.routeProfile, "shared-hosted-sandbox");
  assert.equal(host.backendOptions.modernSettings, true);
});

for (const env of [
  { VITE_BACKEND_ROUTE_PROFILE: "" },
  { VITE_ACCESS_ENVIRONMENT: "" },
  { VITE_BACKEND_ROUTE_PROFILE: "unknown", VITE_ACCESS_ENVIRONMENT: "sandbox" },
  { VITE_BACKEND_ROUTE_PROFILE: "shared-hosted-sandbox", VITE_ACCESS_ENVIRONMENT: "production" },
  { VITE_BACKEND_ROUTE_PROFILE: "production", VITE_ACCESS_ENVIRONMENT: "sandbox" },
  { VITE_ACCESS_ENVIRONMENT: "sandbox" },
  { VITE_BACKEND_ROUTE_PROFILE: "shared-hosted-sandbox", VITE_ACCESS_ENVIRONMENT: "sandbox", VITE_MODERN_SETTINGS_SYNC_ENABLED: "false" },
  { VITE_BACKEND_ROUTE_PROFILE: "production", VITE_ACCESS_ENVIRONMENT: "typo" },
]) {
  test(`invalid or incomplete route configuration holds before client construction: ${JSON.stringify(env)}`, () => {
    const host = launch(env);
    assert.equal(host.clientCount, 0);
    assert.equal(host.authority, undefined);
    assert.equal(host.backendOptions, undefined);
    assert.equal(host.calls.length, 0);
  });
}

test("absent profile and environment preserve ordinary production fulfillment", async () => {
  const host = launch();
  await host.authority.verifyLocal({ schema: 1, transaction: {} });
  await host.authority.fulfillLink({});
  assert.deepEqual(host.calls.map(call => call.name), ["verify-apple-access", "link-apple-access"]);
  assert.equal(host.backendOptions?.routeProfile ?? "production", "production");
});

test("copying the actual example preserves configured ordinary free sync", async () => {
  const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  const env = Object.fromEntries(example.split(/\r?\n/)
    .filter(line => /^[A-Z_]+=/.test(line))
    .map(line => { const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)]; }));
  const host = launch({...env, VITE_SUPABASE_URL: "https://example.invalid",
    VITE_SUPABASE_ANON_KEY: "public-synthetic", VITE_MODERN_SETTINGS_SYNC_ENABLED: "true"});
  assert.equal(host.clientCount, 1);
  assert.equal(host.backendOptions?.routeProfile ?? "production", "production");
  assert.equal(host.backendOptions.modernSettings, true);
});

test("ordinary legacy construction retains its legacy settings behavior", () => {
  const host = launch({ VITE_MODERN_SETTINGS_SYNC_ENABLED: "false" });
  assert.equal(host.clientCount, 1);
  assert.equal(host.backendOptions?.modernSettings, undefined);
  assert.equal(host.backendOptions?.routeProfile ?? "production", "production");
  assert.equal(host.authority, undefined);
});


test("QA fulfillment errors remain on the selected route without a production retry", async () => {
  const error = new Error("Synthetic QA transport rejection");
  const host = launch({ VITE_BACKEND_ROUTE_PROFILE: "shared-hosted-sandbox", VITE_ACCESS_ENVIRONMENT: "sandbox" }, error);
  await assert.rejects(host.authority.verifyLocal({ schema: 1, transaction: {} }), error);
  await assert.rejects(host.authority.fulfillLink({}), error);
  assert.deepEqual(host.calls.map(call => call.name), ["qa-sandbox-verify-apple-access", "qa-sandbox-link-apple-access"]);
  assert.equal(host.calls.length, 2);
  assert.ok(host.calls.every(call => call.options.signal instanceof AbortSignal));
});


test("modern entry wires account reconciliation separately and notifies accepted native cache", async () => {
  const host = launch({ VITE_BACKEND_ROUTE_PROFILE: "shared-hosted-sandbox", VITE_ACCESS_ENVIRONMENT: "sandbox" });
  assert.equal(typeof host.sessionDeps.refreshAccountAccess, "function");
  await host.sessionDeps.refreshAccountAccess();
  assert.equal(host.accountRefreshes(), 1);
  assert.deepEqual(host.events, ["still:accountAccess"]);
  host.sessionDeps.onNativeAccountStatusPublished();
  assert.deepEqual(host.events, ["still:accountAccess", "still:accountAccess"]);
  host.authEvent("TOKEN_REFRESHED");
  host.authEvent("SIGNED_OUT");
  assert.equal(host.invalidations(), 2);
  assert.equal(host.calls.length, 0);
});

test("legacy entry omits the account-only purchase authority hooks", () => {
  const host = launch({VITE_MODERN_SETTINGS_SYNC_ENABLED: "false"});
  assert.equal(host.sessionDeps.refreshAccountAccess, undefined);
  assert.equal(host.sessionDeps.onNativeAccountStatusPublished, undefined);
});
