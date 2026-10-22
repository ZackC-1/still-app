# Production purchase routes and secrets: protected operations

This puts the production purchase routes and their function secrets on the hosted project (V3
go-live runbook steps 2.3 and 2.4, gap G3), and redeploys the App Review sign-in route
`review-signin` (runbook step 2.7). Every change goes through the protected **Supabase
production deploy** workflow and waits for the owner's approval. Nothing here is done with the
Supabase CLI, in the Supabase dashboard or in the SQL editor.

The code is `scripts/backend/deploy/purchase-operations.mjs`. The closed route lists are
`PURCHASE_FUNCTIONS`, `SYNC_SETTINGS_FUNCTIONS` and `REVIEW_SIGNIN_FUNCTIONS` in
`scripts/backend/deploy/qa-function-bundles.mjs`.

## The operations

| Operation | What it does | Modes |
|---|---|---|
| `purchase-functions` | Deploys exactly these routes, in this order, as sealed single-file bundles built from the planned commit, each read back byte for byte: `product-policy` (verify_jwt false), `export-user-data` (true), `verify-apple-access` (false), `link-apple-access` (true), `reconcile-entitlement` (true), `create-web-checkout` (true), `complete-web-checkout` (true), `revenuecat-webhook` (false), `stripe-webhook` (false). Read-only routes first, provider webhooks last. A route already at the planned source is left alone. | `plan-only`, `apply` |
| `purchase-functions-sync-settings` | Deploys `sync-settings` (verify_jwt true) alone. It serves the released 2.x apps' free sync, so it is a separate run with its own approval. | `plan-only`, `apply` |
| `purchase-secrets` | Copies each GitHub environment secret `PROD_<NAME>` to the function secret `<NAME>`, and sets `ACCESS_PROOF_ENVIRONMENT` to `production` itself. `apply` installs absent names and refuses if a name already holds a different value. `rotate` replaces only names that already hold a value. | `plan-only`, `apply`, `rotate` |
| `review-signin-function` | Deploys `review-signin` (verify_jwt false) alone, the same way as `sync-settings`: a sealed single-file bundle built from the planned commit and read back byte for byte, left alone if already at that source. It serves the App Review sign-in, so it is a separate run with its own approval. It never sets, rotates or changes a secret. | `plan-only`, `apply` |

`policy_mode` is always `none`; `migrations`, `functions`, `policy_expected_revision`,
`subjects_sha256` and `baseline_sha256` stay empty.

Each function step refuses before any write unless:

- the hosted migration history holds every migration in `supabase/migrations` at the planned commit
  (no pending migration; for `sync-settings` this includes `0024`, the released-app settings guard);
- the purchase configuration names in `ROUTE_SECRETS[purchase-functions]` all exist, including
  the live Stripe bindings, production access signer, Apple verification and RevenueCat mappings,
  plus `ENTITLEMENT_WRITER_DB_URL` and `PRODUCT_POLICY_READER_DB_URL`;
- `SETTINGS_WRITER_DB_URL` exists for the separate `sync-settings` deployment;
- `REVIEW_SIGNIN_EMAIL`, `REVIEW_SIGNIN_CODE` and `ENTITLEMENT_WRITER_DB_URL` exist for the separate
  `review-signin` deployment. This check is by name only: the operation reads only the names in the
  project's secret list, never a value or a digest of one, and it compares secret names (not digests)
  before and after the upload. A missing name stops the run with `missing_secret:<NAME>`. The
  `REVIEW_SIGNIN_*` values are set on the project outside these operations, and no operation here
  can write them.

Apply the reviewed production purchase secrets before deploying purchase functions. The gate checks
presence; a complete offline runtime-configuration check and provider read-back remain required
before enabling sales. Runtime handlers refuse incomplete or invalid configuration as a second check.

`purchase-secrets` refuses before any write if the Secrets-only token can read the project's
functions, a `PROD_*` name is unknown, a value has stray whitespace, a key group is incomplete, the
access-proof private key does not match its public key, or a product list is not a non-empty JSON
array. No value, and no digest of a value, appears in a plan, a log or a closing record.

## Secret names the owner creates

Create these in GitHub, **Settings, Environments, supabase-production, Environment secrets**. Values
come from the providers and never enter Git, a chat or a document.

| GitHub environment secret | Function secret | Needed |
|---|---|---|
| `PROD_ACCESS_PROOF_KEY_ID` | `ACCESS_PROOF_KEY_ID` | Required (group: access-proof key) |
| `PROD_ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64` | `ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64` | Required (group: access-proof key) |
| `PROD_ACCESS_PROOF_PUBLIC_KEY_HEX` | `ACCESS_PROOF_PUBLIC_KEY_HEX` | Required (group: access-proof key) |
| `PROD_ACCESS_APPLE_PRODUCTS_JSON` | `ACCESS_APPLE_PRODUCTS_JSON` | Required |
| `PROD_ACCESS_PROVIDER_PRODUCTS_JSON` | `ACCESS_PROVIDER_PRODUCTS_JSON` | Required (engineering builds it from the RevenueCat read-back, runbook V30; keep the legacy entries, see below) |
| `PROD_APP_STORE_SERVER_ISSUER_ID` | `APP_STORE_SERVER_ISSUER_ID` | Required |
| `PROD_APP_STORE_SERVER_KEY_ID` | `APP_STORE_SERVER_KEY_ID` | Required (group: App Store key) |
| `PROD_APP_STORE_SERVER_PRIVATE_KEY` | `APP_STORE_SERVER_PRIVATE_KEY` | Required (group: App Store key) |
| `PROD_APPLE_SANDBOX_REVIEW_ENABLED` | `APPLE_SANDBOX_REVIEW_ENABLED` | Optional; exact `true` or `false`, absent means off |
| `PROD_REVENUECAT_PROJECT_ID` | `REVENUECAT_PROJECT_ID` | Required |
| `PROD_REVENUECAT_ACCESS_SECRET_API_KEY` | `REVENUECAT_ACCESS_SECRET_API_KEY` | Required |
| `PROD_REVENUECAT_SECRET_API_KEY` | `REVENUECAT_SECRET_API_KEY` | Required, but already set since July: stage it only to replace it |
| `PROD_REVENUECAT_WEBHOOK_TOKEN` | `REVENUECAT_WEBHOOK_TOKEN` | Required, but already set since July: stage it only to replace it |
| `PROD_STRIPE_SECRET_API_KEY` | `STRIPE_SECRET_API_KEY` | Required |
| `PROD_STRIPE_ACCOUNT_ID` | `STRIPE_ACCOUNT_ID` | Required |
| `PROD_STRIPE_WEBHOOK_SECRET` | `STRIPE_WEBHOOK_SECRET` | Required |
| `PROD_STRIPE_API_VERSION` | `STRIPE_API_VERSION` | Required |
| `PROD_STRIPE_PRICE_ID` | `STRIPE_PRICE_ID` | Required |
| `PROD_STRIPE_PRODUCT_ID` | `STRIPE_PRODUCT_ID` | Required |
| `PROD_REVENUECAT_STRIPE_PUBLIC_API_KEY` | `REVENUECAT_STRIPE_PUBLIC_API_KEY` | Required |
| `PROD_WEB_RETURN_ORIGIN` | `WEB_RETURN_ORIGIN` | Required |
| `PROD_WEB_RETURN_PATHS_JSON` | `WEB_RETURN_PATHS_JSON` | Required |

"Required" means the name must hold a value after an `apply`: either staged now or already present.
A group's names are staged together or not at all. `ACCESS_PROOF_ENVIRONMENT` is not staged; the
operation writes `production`.

**`ACCESS_PROVIDER_PRODUCTS_JSON` keeps the legacy products.** The server recognises a RevenueCat
purchase only when its product has an entry in this list (`supabase/functions/_shared/revenuecat-access.ts`
skips every other product). Besides the 3.0 entries (`still_pro_v3` on the Apple apps and the live
Stripe price), the list must keep the legacy entries with store identifiers `still_sync` (the Apple
products, entitlement `still_sync`) and `still_sync_web` (RevenueCat Web Billing, entitlement
`still_sync`). Without them, no pre-3.0 paid purchase is recognised for anyone. Check this whenever
the list is built (runbook V30) and at the production read-back after `purchase-secrets` (runbook
V14), by product identifier only; never copy the setting's value into a document.

Apple review access requires migration 0027 and the matching native binding verifier. Enable the
separate review switch only after those gates pass. Apple sandbox transactions then issue local
device access from an isolated review ledger; they cannot link to an account or enter the live
payment ledger. Keep review purchases out of production conversion reporting. The RevenueCat
webhook configuration is unchanged. To turn review issuance off, stage `false` through the
protected secret rotation operation; already issued local proofs retain their existing deadlines.

**Not handled here, on purpose.** `ENTITLEMENT_WRITER_DB_URL`, `PRODUCT_POLICY_READER_DB_URL` and
`SETTINGS_WRITER_DB_URL` are database sign-ins: each URL's password must match its role's stored
verifier, so a staged copy would not work. The first is live since 2.x; the `qa-sandbox-secrets`
operation installs the other two with their logins. `purchase-secrets` only reports whether each is
present. `PRODUCT_POLICY_ADMIN_DB_URL` (and the `product-policy-admin` route) is needed only if
decision D1 picks the owner page.

**Production Managed Payments.** The closed route set includes `complete-web-checkout` with
JWT verification and `stripe-webhook` without gateway JWT verification (the handler verifies the raw
Stripe signature). Stripe configuration accepts live server keys only, pins the API version, and
checks provider identifiers and HTTPS return locations before staging. The runtime additionally
checks the complete mapping, signer and Apple configuration. All required configuration must exist
before the first purchase route upload. QA-prefixed values remain outside this operation.

The unused RevenueCat Web Billing checkout URL is no longer staged. Existing hosted values are
preserved; this operation never deletes an unrelated secret. The existing RevenueCat webhook
portal settings remain unchanged.

## Before the first run

1. Merge the release commit to `main` and note it. Every run below uses that one commit.
2. Confirm the hosted migration tail with DB-01 (read-only, no approval):
   `gh workflow run supabase-readonly-checks.yml --ref main -f check=DB-01 -f account=none -f account_b=none`
   ([read-only checks](qa-readonly-database-checks.md)). The tail must include `0024` and every
   later migration on the release commit. If not, apply the pending migrations first (runbook 2.2,
   `operation=migrations`). The function steps check this again for themselves and refuse with
   `history_missing:<version>`.
3. Stage and apply the reviewed production purchase secrets before deploying purchase functions.
   Confirm the `SUPABASE_QA_SECRETS_ACCESS_TOKEN` environment secret still exists and is a Supabase
   token limited to project secrets. `purchase-secrets` uses only this token and refuses
   (`secrets_token_too_broad`) if it can read functions.

## The operator sequence

Every operation follows the same three moves. Replace `<sha>` with the release commit.

1. **Plan-only run (no approval, no secret, nothing written).** Engineering starts it and reads the
   plan in the run summary: the digest, the routes and their bundle hashes, or the secret names.
2. **Owner approval.** Engineering starts the same command with `mode=apply` (or `rotate`) and sends
   the owner its link. The owner opens it, reads the plan in the summary, clicks **Review
   deployments**, ticks **supabase-production** and clicks **Approve and deploy**.
3. **Apply.** The approved job re-derives the plan, refuses if it differs from the one shown, checks
   that `main` has not changed a bound file, runs the gates, writes, verifies, and posts a closing
   record. Engineering reads the closing record before the next step.

| Step | Plan-only (move 1) | Apply after owner approval (moves 2 and 3) | Check after |
|---|---|---|---|
| 2.3 routes | `gh workflow run supabase-production-deploy.yml --ref main -f commit=<sha> -f operation=purchase-functions -f policy_mode=none -f mode=plan-only` | the same with `-f mode=apply` | V13: the closing record lists each route `created`, `deployed` or `unchanged`; the dashboard shows the new versions |
| 2.3 sync-settings (separate) | `... -f operation=purchase-functions-sync-settings -f policy_mode=none -f mode=plan-only` | the same with `-f mode=apply` | DB-01 matches all migrations at the pinned commit (foundation through 0027; final analytics integration also 0028/0029); a released 2.1 app still syncs settings |
| 2.4 secrets | `... -f operation=purchase-secrets -f policy_mode=none -f mode=plan-only` | the same with `-f mode=apply` | V14: every name appears in Edge Functions, Secrets (names only); the routes answer without `unavailable` |
| Replace a value later | `... -f operation=purchase-secrets -f policy_mode=none -f mode=plan-only` | the same with `-f mode=rotate`, with only the new `PROD_*` values staged | the closing record shows `replaced` for exactly those names |
| 2.7 review sign-in route (separate) | `... -f operation=review-signin-function -f policy_mode=none -f mode=plan-only` | the same with `-f mode=apply` | the closing record lists `review-signin` as `deployed` or `unchanged`; a request of about 3,000 bytes for an address that is not the review address gets 400 (not 404) |

Run the `sync-settings` step only when the route on production predates the commit (runbook V11) and
`0024` is applied. If its production version already equals the commit, the step reports `unchanged`
and writes nothing. The same holds for `review-signin-function`: if the deployed `review-signin`
already matches the commit, it reports `unchanged`.

## Undo and recovery

- A route: redeploy the previous reviewed commit through the same operation. A failed run stops at
  the attempted route and marks it `outcome-unknown`; the earlier routes in the record are verified.
- A secret: run `purchase-secrets` with `mode=rotate`. If a value leaked, rotate it at the provider
  first, then stage the new value and rotate here.
- Never retry a run that recorded `outcome-unknown` without reading its closing record first.

## How CI rehearses it

- Every plan job (and the pull-request **Supabase operation rehearsal**) compiles the real bundles,
  then rehearses all four operations on a throwaway database with the Management API and GitHub
  stubbed: refusals first, then routes, sync-settings, secrets apply, repeat, rotate, and
  review-signin (a pending migration, each missing review secret and an added route are refused;
  then only `review-signin` deploys and no secret changes), and a check that no value reaches any
  record.
- The pull-request **Supabase purchase function rehearsal** compiles the real routes, including
  `review-signin`, through the same compiler boundary and starts every sealed upload with no
  environment, no network and no write access. The `review-signin` upload must answer an oversized
  request with 400.
