/** Closed purchase deployment prerequisites, shared with checkout runtime refreshes. */
export const PURCHASE_ROUTE_SECRETS = Object.freeze([
  "ENTITLEMENT_WRITER_DB_URL",
  "PRODUCT_POLICY_READER_DB_URL",
  "REVENUECAT_SECRET_API_KEY",
  "REVENUECAT_WEBHOOK_TOKEN",
  "ACCESS_PROOF_ENVIRONMENT",
  "ACCESS_PROOF_KEY_ID",
  "ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64",
  "ACCESS_PROOF_PUBLIC_KEY_HEX",
  "ACCESS_APPLE_PRODUCTS_JSON",
  "ACCESS_PROVIDER_PRODUCTS_JSON",
  "APP_STORE_SERVER_ISSUER_ID",
  "APP_STORE_SERVER_KEY_ID",
  "APP_STORE_SERVER_PRIVATE_KEY",
  "REVENUECAT_PROJECT_ID",
  "REVENUECAT_ACCESS_SECRET_API_KEY",
  "STRIPE_SECRET_API_KEY",
  "STRIPE_ACCOUNT_ID",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_API_VERSION",
  "STRIPE_PRICE_ID",
  "STRIPE_PRODUCT_ID",
  "REVENUECAT_STRIPE_PUBLIC_API_KEY",
  "WEB_RETURN_ORIGIN",
  "WEB_RETURN_PATHS_JSON",
]);
export function purchaseRouteIssues(history, migrations, secrets, required = PURCHASE_ROUTE_SECRETS) {
  const applied = new Set(history.map(item => item.version));
  const present = new Set(secrets.map(item => item.name));
  return [...migrations.filter(version => !applied.has(version)).map(version => `history_missing:${version}`),
    ...required.filter(name => !present.has(name)).map(name => `missing_secret:${name}`)];
}
