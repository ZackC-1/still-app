import { importPKCS8 } from "jose";
import { createAccessSigner } from "./access-issuer.ts";
import { createAppleAccessVerifier } from "./apple-access.ts";
import { isUuid } from "./types.ts";
import type { AppleFulfillmentRuntimeConfig } from "./apple-access-runtime.ts";

export interface QaSandboxAppleConfig extends AppleFulfillmentRuntimeConfig {
  readonly environment: "sandbox";
}

/** Exact role only. A pooler alias must earn a separately reviewed deployment contract. */
function isQaWriterUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return ["postgres:", "postgresql:"].includes(url.protocol) && !!url.hostname && !!url.password &&
      url.pathname.length > 1 && !url.hash && decodeURIComponent(url.username) === "still_qa_sandbox_writer";
  } catch { return false; }
}

/** Closed paid-secret namespace; normal project Auth inputs are deliberately shared.
 * Syntax and real key import/pair checks establish composition, not provider/SQL readiness. */
export async function readQaSandboxAppleConfig(read: (name: string) => string | undefined): Promise<QaSandboxAppleConfig | null> {
  const config: QaSandboxAppleConfig = { environment: "sandbox",
    writerDbUrl: read("STILL_QA_SANDBOX_ENTITLEMENT_WRITER_DB_URL") ?? "",
    signer: { kid: read("STILL_QA_SANDBOX_ACCESS_PROOF_KEY_ID"),
      privateKeyPkcs8Base64: read("STILL_QA_SANDBOX_ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64"),
      publicKeyHex: read("STILL_QA_SANDBOX_ACCESS_PROOF_PUBLIC_KEY_HEX") },
    apple: { productsJson: read("STILL_QA_SANDBOX_ACCESS_APPLE_PRODUCTS_JSON"),
      apiPrivateKey: read("STILL_QA_SANDBOX_APP_STORE_SERVER_PRIVATE_KEY"),
      apiKeyId: read("STILL_QA_SANDBOX_APP_STORE_SERVER_KEY_ID"),
      apiIssuerId: read("STILL_QA_SANDBOX_APP_STORE_SERVER_ISSUER_ID") },
    auth: { supabaseUrl: read("SUPABASE_URL") ?? "", jwtSecret: read("SUPABASE_JWT_SECRET") ?? "",
      publicApiKey: read("SUPABASE_ANON_KEY") ?? "" } };
  if (!isQaWriterUrl(config.writerDbUrl) || !config.auth.publicApiKey || !isUuid(config.apple.apiIssuerId)) return null;
  try {
    const url = new URL(config.auth.supabaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (!await createAccessSigner({ ...config.signer, environment: "sandbox" }) ||
      !createAppleAccessVerifier({ ...config.apple, environment: "sandbox" })) return null;
    // The existing Apple API client imports lazily; malformed PEM must fail before QA composition.
    await importPKCS8(config.apple.apiPrivateKey!, "ES256");
    return { ...config, auth: { ...config.auth, supabaseUrl: url.origin } };
  } catch { return null; }
}
