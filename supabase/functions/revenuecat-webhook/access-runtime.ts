import type postgres from "postgres";
import { createAppleAccessVerifier } from "../_shared/apple-access.ts";
import { PgAppleAccessStore } from "../_shared/apple-access-store.ts";
import { VerifiedAppleAccountRefresher } from "../_shared/apple-account-access.ts";
import { PgAccessRightStore } from "../_shared/pg-access-store.ts";
import { HttpRevenueCatAccessClient, parseAccessProductMappings, stripeMappingsBoundTo } from "../_shared/revenuecat-access.ts";
import type { ProductionWebhookAccess } from "./access.ts";

/** Production-only canonical refresh, deliberately independent of signing and checkout secrets. */
export function productionWebhookAccess(read: (name: string) => string | undefined,
  sql: ReturnType<typeof postgres>): ProductionWebhookAccess | null {
  if (read("ACCESS_PROOF_ENVIRONMENT") !== "production") return null;
  const products = stripeMappingsBoundTo(parseAccessProductMappings(read("ACCESS_PROVIDER_PRODUCTS_JSON") ?? ""), read("STRIPE_PRICE_ID") ?? "");
  const project = read("REVENUECAT_PROJECT_ID") ?? "";
  const secret = read("REVENUECAT_ACCESS_SECRET_API_KEY") ?? "";
  if (!products || !project || !secret) return null;
  const verifier = createAppleAccessVerifier({ environment: "production",
    productsJson: read("ACCESS_APPLE_PRODUCTS_JSON"), apiPrivateKey: read("APP_STORE_SERVER_PRIVATE_KEY"),
    apiKeyId: read("APP_STORE_SERVER_KEY_ID"), apiIssuerId: read("APP_STORE_SERVER_ISSUER_ID") });
  return {
    rights: new PgAccessRightStore(sql),
    provider: new HttpRevenueCatAccessClient(secret, project, products, "production"),
    apple: new VerifiedAppleAccountRefresher(new PgAppleAccessStore(sql, "production"),
      verifier ?? { authenticate: () => Promise.resolve(null), refresh: () => Promise.resolve(null) }),
  };
}
