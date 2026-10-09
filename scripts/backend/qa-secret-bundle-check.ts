// Offline check of the private QA sandbox secret bundle before it is staged anywhere.
//
//   deno run --config supabase/functions/deno.json --cached-only --no-prompt \
//     --allow-read=<bundle.json>,<public-trust.json> \
//     --allow-env=PGMAX,PGHOST,PGPORT,PGUSERNAME,PGUSER,PGDATABASE,PGPASSWORD,PGSSL,PGSSLNEGOTIATION,PGIDLE_TIMEOUT,PGCONNECT_TIMEOUT,PGMAX_LIFETIME,PGMAX_PIPELINE,PGBACKOFF,PGKEEP_ALIVE,PGDEBUG,PGFETCH_TYPES,PGPUBLICATIONS,PGTARGET_SESSION_ATTRS,PGTARGETSESSIONATTRS,PGAPPNAME \
//     scripts/backend/qa-secret-bundle-check.ts <bundle.json> <public-trust.json>
//
// No network permission is granted. `--cached-only` refuses to download modules; run the
// supabase/functions Deno tests once first to populate the cache. The PG* environment names are
// read (never printed) only by the pinned Postgres driver while it builds an idle client for the
// dummy writer URL; no connection is attempted.
//
// The bundle is one JSON object holding exactly the 19 provider/authority values staged as
// STILL_QA_SANDBOX_* secrets. Database URLs are generated inside the protected run and must not be
// in the bundle; this check substitutes dummy URLs with the exact role usernames. The public trust
// file is the paid-sandbox public-inputs record (`inputs.STILL_QA_ACCESS_PUBLIC_KEYS`,
// `trustSha256`). Output is one PASS/FAIL line per check name. No value, digest, key, error
// message or count of characters is ever printed.
import { importPKCS8 } from "jose";
import { createAccessSigner } from "../../supabase/functions/_shared/access-issuer.ts";
import { createAppleAccessVerifier, parseAppleProducts } from "../../supabase/functions/_shared/apple-access.ts";
import { readQaSandboxAppleConfig } from "../../supabase/functions/_shared/qa-sandbox-config.ts";
import { readQaSandboxCheckoutConfig } from "../../supabase/functions/_shared/qa-sandbox-checkout-runtime.ts";
import { QA_STRIPE_API_VERSION } from "../../supabase/functions/_shared/qa-sandbox-managed-checkout.ts";
import {
  createQaSandboxPolicyHandler,
  createQaSandboxSyncHandler,
} from "../../supabase/functions/_shared/qa-sandbox-public-runtime.ts";
import { readQaSandboxStripeWebhookRuntime } from "../../supabase/functions/_shared/qa-sandbox-stripe-webhook.ts";
import {
  parseAccessProductMappings,
  stripeMappingsBoundTo,
} from "../../supabase/functions/_shared/revenuecat-access.ts";

const PREFIX = "STILL_QA_SANDBOX_";
/** The staged provider/authority values: REQUIRED_SECRETS minus the three generated DB URLs. */
export const BUNDLE_NAMES = Object.freeze([
  "ACCESS_PROOF_KEY_ID",
  "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64",
  "ACCESS_PROOF_PUBLIC_KEY_HEX",
  "ACCESS_APPLE_PRODUCTS_JSON",
  "APP_STORE_SERVER_PRIVATE_KEY",
  "APP_STORE_SERVER_KEY_ID",
  "APP_STORE_SERVER_ISSUER_ID",
  "REVENUECAT_PROJECT_ID",
  "REVENUECAT_ACCESS_SECRET_API_KEY",
  "ACCESS_PROVIDER_PRODUCTS_JSON",
  "STRIPE_SECRET_API_KEY",
  "STRIPE_ACCOUNT_ID",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_API_VERSION",
  "STRIPE_PRICE_ID",
  "STRIPE_PRODUCT_ID",
  "REVENUECAT_STRIPE_PUBLIC_API_KEY",
  "WEB_RETURN_ORIGIN",
  "WEB_RETURN_PATHS_JSON",
].map((suffix) => PREFIX + suffix));
/** The approved website return pages (docs/qa/success.html and docs/qa/cancel.html). */
export const RETURN_ORIGIN = "https://stillapp.fit";
export const RETURN_PATHS = Object.freeze({ success: "/qa/success", cancel: "/qa/cancel" });
const FALLBACK_REF = "abcdefghijklmnopqrst";

export interface BundleCheck {
  readonly name: string;
  readonly pass: boolean;
}

type Values = Record<string, string>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** Same closed grammar and fingerprint as apps/apple/scripts/paid-sandbox-qa.mjs. */
function trustedKeys(trust: unknown) {
  if (!object(trust) || !object(trust.inputs)) return null;
  const text = trust.inputs.STILL_QA_ACCESS_PUBLIC_KEYS;
  if (typeof text !== "string" || text.length > 16_384) return null;
  let keys: unknown;
  try {
    keys = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 8) return null;
  const seen = new Set<string>();
  for (const key of keys) {
    if (
      !object(key) || Object.keys(key).sort().join(",") !== "environment,kid,publicKeyHex,purpose" ||
      typeof key.kid !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(key.kid) || seen.has(key.kid) ||
      typeof key.publicKeyHex !== "string" || !/^[0-9a-f]{64}$/.test(key.publicKeyHex) ||
      key.environment !== "sandbox" || key.purpose !== "access"
    ) return null;
    seen.add(key.kid);
  }
  return (keys as { kid: string; publicKeyHex: string; environment: string; purpose: string }[])
    .map(({ kid, publicKeyHex, environment, purpose }) => ({ kid, publicKeyHex, environment, purpose }));
}

/** Public project origin and anon key from the trust record when valid; synthetic otherwise. */
function publicProject(trust: unknown): { url: string; anonKey: string; ref: string } {
  const inputs = object(trust) && object(trust.inputs) ? trust.inputs : {};
  try {
    const url = new URL(String(inputs.STILL_QA_SUPABASE_URL ?? ""));
    const ref = url.hostname.split(".")[0];
    const anonKey = String(inputs.STILL_QA_SUPABASE_ANON_KEY ?? "");
    if (url.protocol === "https:" && /^[a-z]{20}\.supabase\.co$/.test(url.hostname) && anonKey) {
      return { url: url.origin, anonKey, ref };
    }
  } catch { /* fall through to synthetic public inputs */ }
  return { url: `https://${FALLBACK_REF}.supabase.co`, anonKey: "dummy-public-anon-key", ref: FALLBACK_REF };
}

async function attempt(check: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return (await check()) === true;
  } catch {
    return false;
  }
}

export async function checkQaSecretBundle(bundle: unknown, trust: unknown): Promise<BundleCheck[]> {
  const checks: BundleCheck[] = [];
  const add = async (name: string, check: () => boolean | Promise<boolean>) => {
    checks.push({ name, pass: await attempt(check) });
  };
  const values: Values = {};
  await add("bundle-is-object", () => object(bundle));
  if (object(bundle)) {
    for (const [name, value] of Object.entries(bundle)) {
      if (typeof value === "string") values[name] = value;
    }
  }
  await add("bundle-names-exact", () =>
    object(bundle) && Object.keys(bundle).length === BUNDLE_NAMES.length &&
    BUNDLE_NAMES.every((name) => Object.hasOwn(bundle, name)));
  await add("bundle-values-present", () =>
    BUNDLE_NAMES.every((name) => typeof values[name] === "string" && values[name].trim() !== ""));
  await add("bundle-values-trimmed", () =>
    BUNDLE_NAMES.every((name) =>
      name === PREFIX + "APP_STORE_SERVER_PRIVATE_KEY" || values[name] === values[name]?.trim()
    ));

  const project = publicProject(trust);
  const password = crypto.randomUUID().replaceAll("-", "");
  const dbUrl = (role: string) =>
    `postgresql://${role}:${password}@db.${project.ref}.supabase.co:5432/postgres?sslmode=require`;
  const env: Values = {
    ...Object.fromEntries(BUNDLE_NAMES.map((name) => [name, values[name] ?? ""])),
    SUPABASE_URL: project.url,
    SUPABASE_ANON_KEY: project.anonKey,
    PRODUCT_POLICY_READER_DB_URL: dbUrl("still_policy_reader"),
    SETTINGS_WRITER_DB_URL: dbUrl("still_settings_writer"),
    [PREFIX + "ENTITLEMENT_WRITER_DB_URL"]: dbUrl("still_qa_sandbox_writer"),
  };
  const read = (name: string): string | undefined => env[name];
  const get = (suffix: string) => env[PREFIX + suffix];

  const keys = trustedKeys(trust);
  await add("trust-file-keys", () => keys !== null);
  await add("trust-file-digest", async () => {
    if (!keys || !object(trust) || typeof trust.trustSha256 !== "string") return false;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(keys)));
    return hex(digest) === trust.trustSha256;
  });
  await add("signer-public-key-in-trust", () =>
    !!keys?.some(({ kid, publicKeyHex }) =>
      kid === get("ACCESS_PROOF_KEY_ID") && publicKeyHex === get("ACCESS_PROOF_PUBLIC_KEY_HEX")
    ));
  await add("signer-key-pair", async () =>
    !!(await createAccessSigner({
      environment: "sandbox",
      kid: get("ACCESS_PROOF_KEY_ID"),
      privateKeyPkcs8Base64: get("ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64"),
      publicKeyHex: get("ACCESS_PROOF_PUBLIC_KEY_HEX"),
    })));
  await add("apple-products", () => parseAppleProducts(get("ACCESS_APPLE_PRODUCTS_JSON")) !== null);
  await add("apple-api-key-es256", async () => {
    await importPKCS8(get("APP_STORE_SERVER_PRIVATE_KEY"), "ES256");
    return true;
  });
  await add("apple-verifier", () =>
    createAppleAccessVerifier({
      environment: "sandbox",
      productsJson: get("ACCESS_APPLE_PRODUCTS_JSON"),
      apiPrivateKey: get("APP_STORE_SERVER_PRIVATE_KEY"),
      apiKeyId: get("APP_STORE_SERVER_KEY_ID"),
      apiIssuerId: get("APP_STORE_SERVER_ISSUER_ID"),
    }) !== null);
  await add("apple-config", async () => (await readQaSandboxAppleConfig(read)) !== null);
  await add("stripe-api-version", () => get("STRIPE_API_VERSION") === QA_STRIPE_API_VERSION);
  await add("provider-mapping-bound-to-price", () => {
    const mappings = stripeMappingsBoundTo(
      parseAccessProductMappings(get("ACCESS_PROVIDER_PRODUCTS_JSON")),
      get("STRIPE_PRICE_ID"),
    );
    return mappings?.filter((mapping) => mapping.store === "stripe").length === 1;
  });
  await add("return-pages-approved", () => {
    const paths: unknown = JSON.parse(get("WEB_RETURN_PATHS_JSON"));
    return get("WEB_RETURN_ORIGIN") === RETURN_ORIGIN && object(paths) &&
      Object.keys(paths).length === 2 && paths.success === RETURN_PATHS.success &&
      paths.cancel === RETURN_PATHS.cancel;
  });
  await add("checkout-config", async () => (await readQaSandboxCheckoutConfig(read)) !== null);
  await add("stripe-webhook-runtime", async () => (await readQaSandboxStripeWebhookRuntime(read)) !== null);
  await add("policy-reader-composition", () => {
    const urls: string[] = [];
    createQaSandboxPolicyHandler(read, (url) => {
      urls.push(url);
      return { read: () => Promise.reject(new Error("offline")) };
    });
    return urls.length === 1 && urls[0] === env.PRODUCT_POLICY_READER_DB_URL;
  });
  await add("sync-writer-composition", () => {
    const urls: string[] = [];
    createQaSandboxSyncHandler(read, (url) => {
      urls.push(url);
      return {
        store: {} as never,
        limiter: { consume: () => Promise.resolve(0) },
      };
    });
    return urls.length === 1 && urls[0] === env.SETTINGS_WRITER_DB_URL;
  });
  return checks;
}

export function renderChecks(checks: readonly BundleCheck[]): string {
  const failed = checks.filter(({ pass }) => !pass).length;
  return checks.map(({ name, pass }) => `${pass ? "PASS" : "FAIL"} ${name}`).join("\n") +
    `\n${failed ? "FAIL" : "PASS"} overall\n`;
}

async function readJson(path: string | undefined): Promise<unknown> {
  if (!path) return null;
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null; // Never echo a parse error: it can quote file contents.
  }
}

if (import.meta.main) {
  // Shared modules never log here, but silence the console so no composition path can print.
  const write = (text: string) => Deno.stdout.writeSync(new TextEncoder().encode(text));
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    console[method] = () => {};
  }
  let checks: BundleCheck[];
  try {
    const [bundlePath, trustPath] = Deno.args;
    checks = await checkQaSecretBundle(await readJson(bundlePath), await readJson(trustPath));
  } catch {
    checks = [{ name: "internal", pass: false }];
  }
  write(renderChecks(checks));
  Deno.exit(checks.every(({ pass }) => pass) ? 0 : 1);
}
