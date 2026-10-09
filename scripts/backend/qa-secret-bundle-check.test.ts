import { assert, assertEquals } from "@std/assert";
import {
  BUNDLE_NAMES,
  checkQaSecretBundle,
  renderChecks,
  RETURN_ORIGIN,
  RETURN_PATHS,
} from "./qa-secret-bundle-check.ts";

// Every value is synthetic and generated at runtime; no provider or hosted system is contacted.
const b64 = (bytes: ArrayBuffer) => btoa(Array.from(new Uint8Array(bytes), (b) => String.fromCharCode(b)).join(""));
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const random = (length: number) => hex(crypto.getRandomValues(new Uint8Array(length)).buffer).slice(0, length);

async function synthetic() {
  const signer = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const apple = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const kid = "qa-synthetic-signer";
  const publicKeyHex = hex(await crypto.subtle.exportKey("raw", signer.publicKey));
  const price = `price_${random(12)}`;
  const bundle: Record<string, string> = {
    STILL_QA_SANDBOX_ACCESS_PROOF_KEY_ID: kid,
    STILL_QA_SANDBOX_ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64: b64(await crypto.subtle.exportKey("pkcs8", signer.privateKey)),
    STILL_QA_SANDBOX_ACCESS_PROOF_PUBLIC_KEY_HEX: publicKeyHex,
    STILL_QA_SANDBOX_ACCESS_APPLE_PRODUCTS_JSON: JSON.stringify([{ bundleId: "com.example.still", appAppleId: 1234, productId: "still_pro_v3" }]),
    STILL_QA_SANDBOX_APP_STORE_SERVER_PRIVATE_KEY:
      `-----BEGIN PRIVATE KEY-----\n${b64(await crypto.subtle.exportKey("pkcs8", apple.privateKey))}\n-----END PRIVATE KEY-----\n`,
    STILL_QA_SANDBOX_APP_STORE_SERVER_KEY_ID: "TESTKEY123",
    STILL_QA_SANDBOX_APP_STORE_SERVER_ISSUER_ID: crypto.randomUUID(),
    STILL_QA_SANDBOX_REVENUECAT_PROJECT_ID: `proj${random(8)}`,
    STILL_QA_SANDBOX_REVENUECAT_ACCESS_SECRET_API_KEY: ["sk", random(24)].join("_"),
    STILL_QA_SANDBOX_ACCESS_PROVIDER_PRODUCTS_JSON: JSON.stringify([{
      product_id: "product_rc", app_id: "app_qa", store: "stripe", store_identifier: price,
      entitlement_lookup_key: "still_pro_v3", benefit_product: "still_pro_v3",
    }]),
    STILL_QA_SANDBOX_STRIPE_SECRET_API_KEY: ["sk", "test", random(24)].join("_"),
    STILL_QA_SANDBOX_STRIPE_ACCOUNT_ID: `acct_${random(16)}`,
    STILL_QA_SANDBOX_STRIPE_WEBHOOK_SECRET: ["whsec", random(32)].join("_"),
    STILL_QA_SANDBOX_STRIPE_API_VERSION: "2026-09-30.endive",
    STILL_QA_SANDBOX_STRIPE_PRICE_ID: price,
    STILL_QA_SANDBOX_STRIPE_PRODUCT_ID: `prod_${random(12)}`,
    STILL_QA_SANDBOX_REVENUECAT_STRIPE_PUBLIC_API_KEY: `strp_${random(20)}`,
    STILL_QA_SANDBOX_WEB_RETURN_ORIGIN: RETURN_ORIGIN,
    STILL_QA_SANDBOX_WEB_RETURN_PATHS_JSON: JSON.stringify(RETURN_PATHS),
  };
  const keys = [{ kid, publicKeyHex, environment: "sandbox", purpose: "access" }];
  const trust = {
    kind: "synthetic-public-inputs",
    inputs: {
      STILL_QA_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      STILL_QA_SUPABASE_ANON_KEY: "synthetic-public-anon",
      STILL_QA_ACCESS_PUBLIC_KEYS: JSON.stringify(keys),
    },
    trustSha256: hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(keys)))),
  };
  return { bundle, trust };
}

const failed = (checks: { name: string; pass: boolean }[]) => checks.filter(({ pass }) => !pass).map(({ name }) => name);
function assertNoValues(text: string, bundle: Record<string, string>) {
  for (const value of Object.values(bundle)) {
    for (const part of value.split(/[\s"{}[\],:]+/).filter((part) => part.length >= 8)) {
      assert(!text.includes(part), "output must never contain a bundle value");
    }
  }
}

Deno.test("a complete synthetic bundle passes every check and prints names only", async () => {
  const { bundle, trust } = await synthetic();
  assertEquals(Object.keys(bundle).sort(), [...BUNDLE_NAMES].sort());
  const checks = await checkQaSecretBundle(bundle, trust);
  assertEquals(failed(checks), []);
  const text = renderChecks(checks);
  assert(text.endsWith("PASS overall\n"));
  assert(text.split("\n").filter(Boolean).every((line) => /^(PASS|FAIL) [a-z0-9-]+$/.test(line)));
  assertNoValues(text, bundle);
});

Deno.test("each broken input fails only its own named checks", async () => {
  const cases: [string, (b: Record<string, string>, t: Record<string, unknown>) => void, string[]][] = [
    ["signer not in trust", (_b, t) => {
      const other = [{ kid: "qa-other", publicKeyHex: "a".repeat(64), environment: "sandbox", purpose: "access" }];
      (t.inputs as Record<string, string>).STILL_QA_ACCESS_PUBLIC_KEYS = JSON.stringify(other);
    }, ["trust-file-digest", "signer-public-key-in-trust"]],
    ["trust digest differs", (_b, t) => {
      t.trustSha256 = "0".repeat(64);
    }, ["trust-file-digest"]],
    ["mismatched signer pair", (b) => {
      b.STILL_QA_SANDBOX_ACCESS_PROOF_PUBLIC_KEY_HEX = "b".repeat(64);
    }, ["signer-public-key-in-trust", "signer-key-pair", "apple-config", "checkout-config", "stripe-webhook-runtime"]],
    ["wrong Stripe API version", (b) => {
      b.STILL_QA_SANDBOX_STRIPE_API_VERSION = "2025-01-01.synthetic";
    }, ["stripe-api-version", "checkout-config", "stripe-webhook-runtime"]],
    ["mapping bound to another price", (b) => {
      b.STILL_QA_SANDBOX_STRIPE_PRICE_ID = "price_other";
    }, ["provider-mapping-bound-to-price", "checkout-config", "stripe-webhook-runtime"]],
    ["bad webhook secret", (b) => {
      b.STILL_QA_SANDBOX_STRIPE_WEBHOOK_SECRET = "not-a-webhook-secret";
    }, ["stripe-webhook-runtime"]],
    ["unapproved return page", (b) => {
      b.STILL_QA_SANDBOX_WEB_RETURN_PATHS_JSON = JSON.stringify({ success: "/elsewhere", cancel: "/qa/cancel" });
    }, ["return-pages-approved"]],
    ["malformed Apple key", (b) => {
      b.STILL_QA_SANDBOX_APP_STORE_SERVER_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nbad\n-----END PRIVATE KEY-----";
    }, ["apple-api-key-es256", "apple-config", "checkout-config", "stripe-webhook-runtime"]],
    ["untrimmed value", (b) => {
      b.STILL_QA_SANDBOX_STRIPE_ACCOUNT_ID += "\n";
    }, ["bundle-values-trimmed", "checkout-config", "stripe-webhook-runtime"]],
    ["generated database URL included", (b) => {
      b.STILL_QA_SANDBOX_ENTITLEMENT_WRITER_DB_URL = "postgresql://still_qa_sandbox_writer:synthetic@db.example.test/postgres";
    }, ["bundle-names-exact"]],
  ];
  for (const [label, mutate, expected] of cases) {
    const { bundle, trust } = await synthetic();
    mutate(bundle, trust);
    const checks = await checkQaSecretBundle(bundle, trust);
    assertEquals(failed(checks).sort(), [...expected].sort(), label);
    assertNoValues(renderChecks(checks), bundle);
  }
});

Deno.test("unreadable bundle or trust input fails closed without throwing", async () => {
  for (const [bundle, trust] of [[null, null], ["text", 1], [[], {}]] as const) {
    const checks = await checkQaSecretBundle(bundle, trust);
    assert(failed(checks).includes("bundle-is-object") && failed(checks).includes("trust-file-keys"));
    assert(renderChecks(checks).endsWith("FAIL overall\n"));
  }
});

Deno.test("command line reads only the two named files and prints PASS/FAIL lines", async () => {
  const { bundle, trust } = await synthetic();
  const dir = await Deno.makeTempDir();
  try {
    const bundlePath = `${dir}/bundle.json`, trustPath = `${dir}/trust.json`;
    await Deno.writeTextFile(bundlePath, JSON.stringify(bundle));
    await Deno.writeTextFile(trustPath, JSON.stringify(trust));
    const script = new URL("./qa-secret-bundle-check.ts", import.meta.url).pathname;
    const config = new URL("../../supabase/functions/deno.json", import.meta.url).pathname;
    const run = (paths: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "--config", config, "--no-prompt", `--allow-read=${bundlePath},${trustPath}`,
          `--allow-env=${PG_ENV}`, script, ...paths],
        stdout: "piped", stderr: "piped",
      }).output();
    const ok = await run([bundlePath, trustPath]);
    const out = new TextDecoder().decode(ok.stdout);
    assertEquals(ok.code, 0, out);
    assert(out.endsWith("PASS overall\n"));
    assertNoValues(out + new TextDecoder().decode(ok.stderr), bundle);
    await Deno.writeTextFile(bundlePath, `{"STILL_QA_SANDBOX_STRIPE_SECRET_API_KEY": "${bundle.STILL_QA_SANDBOX_STRIPE_SECRET_API_KEY}"`);
    const broken = await run([bundlePath, trustPath]);
    const brokenText = new TextDecoder().decode(broken.stdout) + new TextDecoder().decode(broken.stderr);
    assertEquals(broken.code, 1);
    assert(brokenText.includes("FAIL bundle-is-object"));
    assertNoValues(brokenText, bundle);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const PG_ENV = [
  "PGMAX", "PGHOST", "PGPORT", "PGUSERNAME", "PGUSER", "PGDATABASE", "PGPASSWORD", "PGSSL", "PGSSLNEGOTIATION",
  "PGIDLE_TIMEOUT", "PGCONNECT_TIMEOUT", "PGMAX_LIFETIME", "PGMAX_PIPELINE", "PGBACKOFF", "PGKEEP_ALIVE",
  "PGDEBUG", "PGFETCH_TYPES", "PGPUBLICATIONS", "PGTARGET_SESSION_ATTRS", "PGTARGETSESSIONATTRS", "PGAPPNAME",
].join(",");
