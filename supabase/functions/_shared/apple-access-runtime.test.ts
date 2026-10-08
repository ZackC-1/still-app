import { assert, assertEquals } from "@std/assert";
import { createAppleFulfillmentRuntimeFromConfig, readAppleFulfillmentRuntimeConfig,
  type AppleFulfillmentRuntimeConfig, type AppleFulfillmentRuntimePorts } from "./apple-access-runtime.ts";
import type { AccessEnvironment } from "@still/shared-types";

const base64 = (bytes: ArrayBuffer) => btoa(Array.from(new Uint8Array(bytes), b => String.fromCharCode(b)).join(""));
async function configured(environment: AccessEnvironment): Promise<AppleFulfillmentRuntimeConfig> {
  const signer = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  assert("privateKey" in signer);
  const api = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { environment, writerDbUrl: "unused-explicit-port",
    signer: { kid: "synthetic-runtime", privateKeyPkcs8Base64: base64(await crypto.subtle.exportKey("pkcs8", signer.privateKey)),
      publicKeyHex: Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", signer.publicKey)), b => b.toString(16).padStart(2, "0")).join("") },
    apple: { productsJson: JSON.stringify([{ bundleId: "com.example.still", appAppleId: 1234, productId: "still_pro_v3" }]),
      apiPrivateKey: `-----BEGIN PRIVATE KEY-----\n${base64(await crypto.subtle.exportKey("pkcs8", api.privateKey))}\n-----END PRIVATE KEY-----`,
      apiKeyId: "TESTKEY123", apiIssuerId: "11111111-1111-1111-1111-111111111111" },
    auth: { supabaseUrl: "https://project.example.test", jwtSecret: "synthetic-shared-jwt", publicApiKey: "synthetic-public-key" } };
}
function storage(environments: AccessEnvironment[]): AppleFulfillmentRuntimePorts {
  return { limiter: { consume: () => Promise.resolve(0) },
    createStore(environment) {
      environments.push(environment);
      return { begin: () => Promise.reject(new Error("No SQL in factory tests")),
        commit: () => Promise.reject(new Error("No SQL in factory tests")), confirm: () => Promise.resolve(false) };
    } };
}

Deno.test("legacy environment reader retains ordinary names and empty defaults", () => {
  assertEquals(readAppleFulfillmentRuntimeConfig(() => undefined), { environment: undefined, writerDbUrl: "",
    signer: { kid: undefined, privateKeyPkcs8Base64: undefined, publicKeyHex: undefined },
    apple: { productsJson: undefined, apiPrivateKey: undefined, apiKeyId: undefined, apiIssuerId: undefined },
    auth: { supabaseUrl: "", jwtSecret: "", publicApiKey: "" } });
  const names: string[] = [];
  const config = readAppleFulfillmentRuntimeConfig(name => { names.push(name); return name; });
  assertEquals(config, { environment: "ACCESS_PROOF_ENVIRONMENT", writerDbUrl: "ENTITLEMENT_WRITER_DB_URL",
    signer: { kid: "ACCESS_PROOF_KEY_ID", privateKeyPkcs8Base64: "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64", publicKeyHex: "ACCESS_PROOF_PUBLIC_KEY_HEX" },
    apple: { productsJson: "ACCESS_APPLE_PRODUCTS_JSON", apiPrivateKey: "APP_STORE_SERVER_PRIVATE_KEY", apiKeyId: "APP_STORE_SERVER_KEY_ID", apiIssuerId: "APP_STORE_SERVER_ISSUER_ID" },
    auth: { supabaseUrl: "SUPABASE_URL", jwtSecret: "SUPABASE_JWT_SECRET", publicApiKey: "SUPABASE_ANON_KEY" } });
  assert(names.every(name => !name.startsWith("STILL_QA_")));
});

Deno.test("explicit factory shares one environment across real signer, Apple verifier and supplied store", async () => {
  for (const environment of ["production", "sandbox"] as const) {
    const config = await configured(environment);
    const environments: AccessEnvironment[] = [];
    const ports = storage(environments);
    const deps = await createAppleFulfillmentRuntimeFromConfig(config, ports);
    assert(deps.access);
    assertEquals(deps.access.signer.environment, environment);
    assertEquals(environments, [environment]);
    assertEquals(deps.limiter, ports.limiter);
    assertEquals(deps.jwtSecret, config.auth.jwtSecret);
    assertEquals(deps.jwksUrl, "https://project.example.test/auth/v1/.well-known/jwks.json");
    assertEquals(deps.expected, { iss: "https://project.example.test/auth/v1", aud: "authenticated", role: "authenticated" });
    const proof = JSON.parse(await deps.access.signer.sign({ right: "33333333-3333-3333-3333-333333333333",
      holder: "11111111-1111-1111-1111-111111111111", revision: 1, verified_at: 1000 }));
    const claims = JSON.parse(atob(proof.payload.replaceAll("-", "+").replaceAll("_", "/")));
    assertEquals(claims.environment, environment);
    // Verifier must reject the opposite environment before any provider lookup.
    assertEquals(await deps.access.verifier.refresh({ key: "a".repeat(64), environment: environment === "sandbox" ? "production" : "sandbox",
      bundleId: "com.example.still", productId: "still_pro_v3", originalTransactionId: "123", transactionId: "123", active: true }), null);
  }
});

Deno.test("unavailable signer or mapping never constructs a store and retains Auth/limiter", async () => {
  const valid = await configured("sandbox");
  for (const config of [{ ...valid, environment: undefined }, { ...valid, signer: {} },
    { ...valid, signer: { ...valid.signer, publicKeyHex: "00".repeat(32) } }, { ...valid, apple: {} }]) {
    const environments: AccessEnvironment[] = [];
    const ports = storage(environments);
    const deps = await createAppleFulfillmentRuntimeFromConfig(config, ports);
    assertEquals(deps.access, undefined);
    assertEquals(environments, []);
    assertEquals(deps.limiter, ports.limiter);
    assertEquals(deps.jwtSecret, valid.auth.jwtSecret);
  }
});

Deno.test("explicit confirmed-account port is preserved without environment reads", async () => {
  const config = await configured("sandbox");
  const accounts = { confirmed: () => Promise.resolve(false) };
  const deps = await createAppleFulfillmentRuntimeFromConfig(config, { ...storage([]), accounts });
  assertEquals(deps.accounts, accounts);
});
