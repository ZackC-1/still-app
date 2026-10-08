import { assert, assertEquals } from "@std/assert";
import { readQaSandboxAppleConfig } from "./qa-sandbox-config.ts";

const PREFIX = "STILL_QA_SANDBOX_";
const SUFFIXES = ["ACCESS_PROOF_KEY_ID", "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64", "ACCESS_PROOF_PUBLIC_KEY_HEX",
  "ACCESS_APPLE_PRODUCTS_JSON", "APP_STORE_SERVER_PRIVATE_KEY", "APP_STORE_SERVER_KEY_ID",
  "APP_STORE_SERVER_ISSUER_ID", "ENTITLEMENT_WRITER_DB_URL"];
const base64 = (bytes: ArrayBuffer) => btoa(Array.from(new Uint8Array(bytes), b => String.fromCharCode(b)).join(""));

// Ephemeral test material is generated in memory; no owner/deployment keys or provider calls.
async function inputs(): Promise<Record<string, string>> {
  const signer = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  assert("privateKey" in signer);
  const api = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    [PREFIX + "ACCESS_PROOF_KEY_ID"]: "synthetic-qa-access",
    [PREFIX + "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64"]: base64(await crypto.subtle.exportKey("pkcs8", signer.privateKey)),
    [PREFIX + "ACCESS_PROOF_PUBLIC_KEY_HEX"]: Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", signer.publicKey)), b => b.toString(16).padStart(2, "0")).join(""),
    [PREFIX + "ACCESS_APPLE_PRODUCTS_JSON"]: JSON.stringify([{ bundleId: "com.example.still", appAppleId: 1234, productId: "still_pro_v3" }]),
    [PREFIX + "APP_STORE_SERVER_PRIVATE_KEY"]: `-----BEGIN PRIVATE KEY-----\n${base64(await crypto.subtle.exportKey("pkcs8", api.privateKey))}\n-----END PRIVATE KEY-----`,
    [PREFIX + "APP_STORE_SERVER_KEY_ID"]: "TESTKEY123",
    [PREFIX + "APP_STORE_SERVER_ISSUER_ID"]: "11111111-1111-1111-1111-111111111111",
    [PREFIX + "ENTITLEMENT_WRITER_DB_URL"]: "postgres://still_qa_sandbox_writer:synthetic-password@db.example.test/postgres",
    SUPABASE_URL: "https://project.example.test", SUPABASE_ANON_KEY: "synthetic-public-key",
  };
}

Deno.test("QA Apple config fixes sandbox and reads only reviewed paid names plus shared Auth", async () => {
  const values = await inputs();
  values.ACCESS_PROOF_ENVIRONMENT = "production";
  values[PREFIX + "ACCESS_PROOF_ENVIRONMENT"] = "production";
  const names: string[] = [];
  const config = await readQaSandboxAppleConfig(name => { names.push(name); return values[name]; });
  assert(config);
  assertEquals(config.environment, "sandbox");
  assertEquals(config.writerDbUrl, values[PREFIX + "ENTITLEMENT_WRITER_DB_URL"]);
  assertEquals(config.auth, { supabaseUrl: values.SUPABASE_URL, jwtSecret: "", publicApiKey: values.SUPABASE_ANON_KEY });
  assertEquals(names.sort(), [...SUFFIXES.map(suffix => PREFIX + suffix), "SUPABASE_URL", "SUPABASE_JWT_SECRET", "SUPABASE_ANON_KEY"].sort());
});

Deno.test("every missing QA paid input stays unavailable even when its live counterpart exists", async () => {
  const valid = await inputs();
  for (const suffix of SUFFIXES) {
    const values = { ...valid, [suffix]: valid[PREFIX + suffix]!, ACCESS_PROOF_ENVIRONMENT: "production" };
    delete values[PREFIX + suffix];
    assertEquals(await readQaSandboxAppleConfig(name => values[name]), null, suffix);
  }
});

Deno.test("mismatched real Ed25519 pair rejects QA composition", async () => {
  const values = await inputs();
  const other = await inputs();
  values[PREFIX + "ACCESS_PROOF_PUBLIC_KEY_HEX"] = other[PREFIX + "ACCESS_PROOF_PUBLIC_KEY_HEX"]!;
  assertEquals(await readQaSandboxAppleConfig(name => values[name]), null);
});

Deno.test("QA malformed signer, Apple mapping and API material fail closed", async () => {
  const valid = await inputs();
  for (const [suffix, value] of [
    ["ACCESS_PROOF_KEY_ID", "rules:key"], ["ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64", "bad"],
    ["ACCESS_PROOF_PUBLIC_KEY_HEX", "00"], ["ACCESS_APPLE_PRODUCTS_JSON", "[]"],
    ["ACCESS_APPLE_PRODUCTS_JSON", JSON.stringify([{ bundleId: "com.example.still", appAppleId: 1234, productId: "still_sync" }])],
    ["APP_STORE_SERVER_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----\nbad\n-----END PRIVATE KEY-----"],
    ["APP_STORE_SERVER_KEY_ID", "invalid"], ["APP_STORE_SERVER_ISSUER_ID", "invalid"],
    ["APP_STORE_SERVER_ISSUER_ID", "------------------------------------"],
  ]) {
    const values = { ...valid, [PREFIX + suffix!]: value! };
    assertEquals(await readQaSandboxAppleConfig(name => values[name]), null, suffix);
  }
});

Deno.test("QA shared project URL has one canonical Auth base even with a trailing slash", async () => {
  const values = await inputs();
  values.SUPABASE_URL += "/";
  assertEquals((await readQaSandboxAppleConfig(name => values[name]))?.auth.supabaseUrl, "https://project.example.test");
});

Deno.test("QA database input rejects live/privileged roles and unreviewed pooler aliases", async () => {
  const valid = await inputs();
  for (const writerDbUrl of ["", "not-a-url", "https://still_qa_sandbox_writer:p@db.example.test/postgres",
    "postgres://still_entitlement_writer:p@db.example.test/postgres", "postgres://postgres:p@db.example.test/postgres",
    "postgres://still_qa_sandbox_writer.project:p@db.example.test/postgres",
    "postgres://still_qa_sandbox_writer@db.example.test/postgres"]) {
    const values = { ...valid, [PREFIX + "ENTITLEMENT_WRITER_DB_URL"]: writerDbUrl };
    assertEquals(await readQaSandboxAppleConfig(name => values[name]), null);
  }
});

Deno.test("QA requires shared project Auth identity but not hosted HS256 secret", async () => {
  const valid = await inputs();
  for (const [name, value] of [["SUPABASE_URL", ""], ["SUPABASE_ANON_KEY", ""],
    ["SUPABASE_URL", "https://project.example.test/wrong"], ["SUPABASE_URL", "https://person:secret@project.example.test"],
    ["SUPABASE_URL", "http://project.example.test"], ["SUPABASE_URL", "https://project.example.test?query=1"]]) {
    const values = { ...valid, [name!]: value! };
    assertEquals(await readQaSandboxAppleConfig(input => values[input]), null);
  }
  assert((await readQaSandboxAppleConfig(name => valid[name])) !== null);
});
