---
title: "V3 release enablement: the engineering between a V3 release candidate and real payments"
status: draft
date: 2026-10-21
owner: "Engineering (coding agents), owner decisions D1 to D9"
branch: "docs/v3-go-live-runbook-20261021 (plan only); each work unit gets its own branch from origin/main"
related: docs/release/v3-go-live-runbook.md (gaps G1 to G10), PR #515
---

> Historical planning baseline. Current owner decisions and execution evidence are recorded in the
> [production activation plan](2026-10-21-002-production-activation-and-verification.md) and
> [go-live runbook](../release/v3-go-live-runbook.md). In particular, do not execute the original
> proposed real-money test/refund sequence, treat already-applied migrations as pending, or
> infer that a source PR is deployed. The current runbook supersedes those operational steps.


# V3 release enablement

## Outcome

Every engineering gap in the [V3 go-live runbook](../release/v3-go-live-runbook.md) (G1 to G10,
plus the pending migrations and the paid-flag flip) is closed by a reviewed PR on `main`, or is
explicitly waiting on a named owner decision. The owner can then run Phases 1 to 8 of the runbook
without engineering doing anything outside a protected workflow. Nothing in this plan changes free
blocking or free sync, and nothing switches sales on by itself: sales stay off until the owner
approves the production sales operation (runbook 2.6).

## Context and evidence

- Strategy and product truths: [`STRATEGY.md`](../../STRATEGY.md), [`AGENTS.md`](../../AGENTS.md)
  ("Product truths that must remain consistent").
- Runbook: [`docs/release/v3-go-live-runbook.md`](../release/v3-go-live-runbook.md), gap table
  lines 57 to 73.
- ADRs: [0003 entitlement authority](../adr/0003-entitlement-authority-receipt-and-server.md),
  [0005 Apple purchase starts with sign-in](../adr/0005-apple-still-pro-purchase-starts-with-sign-in.md).
- Prior plans whose patterns this reuses:
  [`2026-10-09-001-feat-qa-sandbox-activation-operations.md`](2026-10-09-001-feat-qa-sandbox-activation-operations.md)
  (pinned-SQL operations, decision D2 cutoff content for the sandbox),
  [`2026-10-08-001-feat-shared-hosted-paid-sandbox-qa.md`](2026-10-08-001-feat-shared-hosted-paid-sandbox-qa.md).
- Read-only checks runbook: [`docs/release/qa-readonly-database-checks.md`](../release/qa-readonly-database-checks.md).
- Verified against `main` at 745247fc (21 October 2026). Line numbers below are from that commit.

## Scope

### In scope

- Code, workflow, SQL and test changes that close G1 to G10.
- Running the existing protected `migrations` operation for 0022, 0023 and 0024.
- The release PR's code changes: both paid flags, the modern-sync marker, pinned production trust.
- Documentation fixes that make docs agree with the code (G9).

### Out of scope

- Portal work (App Store Connect, RevenueCat, Stripe, Chrome Web Store, AMO). That is the runbook's
  owner steps.
- Store listing copy, screenshots, website pages (runbook Phases 6 and 7).
- Firefox on Android (deferred; already omitted from store builds by PR #508).
- Any change that would let a purchase or an account gate free blocking or free sync.

## Gap verification (each against the code)

### G1. No production sales operation in the protected workflow

- Verified. `.github/workflows/supabase-production-deploy.yml:42-55` lists the operations: only
  `qa-sandbox-sales-policy` publishes a sales body. `scripts/backend/deploy/operations.mjs:182-200`
  pins templates with `environment: "sandbox"`; `:232-260` (`salesPolicy`) and `:362-385` define only
  the sandbox on and off operations; `:423-430` maps the workflow input to them. The SQL
  (`scripts/backend/deploy/operations/qa-sandbox-sales-policy-on.sql`) never names production, and
  `operations.test.mjs:1994` enforces that. The alternative path, the owner-only
  `product-policy-admin` route, needs an allowlisted owner and approved builds that nothing fills
  (`apps/owner-admin/README.md:28`, "Approved builds (known gap)"), and is not deployed to
  production through any protected path (G3).
- Smallest change: add one closed operation, `production-sales-policy`, with `policy_mode` `on` and
  `off`, built exactly like the sandbox pair: two pinned SQL files and two `.verify.sql` files with
  hashes in `OPERATIONS`, compare-and-set on `expected_revision`, the protected operator subject,
  a body rendered by `private.product_policy_render` and compared byte for byte with the plan, and
  `private.product_policy_body_valid('sales', 'production', ...)`. The `on` body lists only the 3.0
  builds (D9). It never names `sandbox`. Its `.verify.sql` proves the sandbox rows and cutoff are
  unchanged (the mirror image of the sandbox check at `qa-sandbox-sales-policy-on.verify.sql:39-40`).
- Depends on: D1 (path), D2 (cutoff content, written by the first `on`), D9 (exact build strings).
- Risk: high. The first `on` writes the write-once production cutoff (see G2) and turns on real
  sales for listed builds. From then on both sandbox sales switches refuse (`operations.mjs:254`),
  so QA purchase testing must be finished first.
- Tests and verification: `operations.test.mjs` cases mirroring the sandbox ones (pinned hash,
  body equality, stale revision refused, a sandbox body refused, cutoff inserted once and never
  again, the `off` body never writes a cutoff); the `supabase-operation-rehearsal.yml` local replay
  with the negative controls `operations.mjs:2040-2140` already runs for the sandbox pair, inverted;
  `deploy-workflow.test.mjs` for the new choice option. After apply: V16 (public `product-policy`
  read), V17 (PROD-01), V18 (DB-35 reports changed, as expected).
- Rollback: before apply, revert the PR. After apply, run `policy_mode off` (a new revision with
  `salesEnabled: false`). The cutoff cannot be undone.
- Estimate: 14 h engineering + 4 h review (shared with G2; one PR).

### G2. The production paid cutoff cannot be written

- Verified. `supabase/migrations/0016_product_policy.sql:434-436` raises "product policy cutoff not
  enabled" for any cutoff argument to `private.apply_product_policy`; `:480-481` answers
  `cutoff_required` for an activating body with no cutoff on record.
  `supabase/functions/product-policy-admin/cutoff.ts:26` holds `PAID_CUTOFF_SNAPSHOT = null`, and
  `handler.test.ts:127` pins it. The table itself accepts a production row:
  `0016:151-158` (`environment in ('sandbox','production')`, `product <> 'still-pro-v3'`, 1 to 32
  benefits), write-once by triggers at `0016:186-195`.
- Key finding: the protected sandbox operation already writes its cutoff directly as `postgres`
  inside its own transaction (`qa-sandbox-sales-policy-on.sql:38,73-76`), not through
  `apply_product_policy`. So on the protected-operation path (D1 default), the production cutoff
  needs no migration and no `cutoff.ts` change: the pinned `on` SQL carries the pinned product id
  and benefits, as the sandbox one does. A migration plus `cutoff.ts` (and binding the snapshot into
  the owner preview hash, as `cutoff.ts:5-6` requires) is needed only if D1 chooses the owner-page
  path.
- Open question, quoted from `cutoff.ts:8-10`: "Owner question 6 is open: which features count as
  'actually released free' at the first real paid activation, and which protected product id the
  snapshot carries (it must differ from `still-pro-v3`)."
- Evidence for the answer: at tag `v2.0.0` no Pro-extra feature id exists in `packages/`
  (`git grep` for `youtube.comments`, `youtube.endscreen`, `instagram.explore`,
  `facebook.sponsored` finds nothing). The 2.1 store builds have no tag; engineering must repeat the
  check on the recorded 2.1 release commits (extension and Apple build 9) before the owner answers.
  The current `packages/shared-types/src/feature-registry.ts` marks exactly `youtube.shorts`,
  `instagram.reels`, `facebook.reels` as `free` (plus the `tiktok.all` alias).
- Smallest change: the cutoff constants inside PR-G's pinned `on` SQL and in `operations.mjs`
  (a `PRODUCTION_CUTOFF` beside `QA_SANDBOX_CUTOFF` at `operations.mjs:207-215`).
- Risk: highest in this plan. The cutoff is permanent (runbook Phase 9). Wrong content cannot be
  corrected.
- Tests: as G1, plus a test that the pinned production cutoff equals the owner-approved list and
  that every benefit is a free-tier id in `FEATURE_REGISTRY` or the TikTok alias.
- Rollback: none after apply. Before apply, revert.
- Estimate: included in G1 (protected path). Owner-page path instead: about 24 h + 6 h review
  (migration 0025, preview-hash binding, `cutoff.ts`, approved-builds list, owner allowlist).

### G3. No protected path deploys production purchase routes or writes their secrets

- Verified. Function deploys are closed sets: `scripts/backend/deploy/qa-function-bundles.mjs:16-25`
  (`QA_FUNCTIONS`, eight `qa-sandbox-*` routes) and `:41-50` (`ANALYTICS_FUNCTIONS`: three production
  routes, bundled with the shared import map, `perRouteConfig` false). The workflow input says
  "Arbitrary Edge Function lists are unsupported" (`supabase-production-deploy.yml:83`). Secrets:
  only `QA_STAGE_*` (`:268-286`) and analytics secrets are wired. QA routes read the
  `STILL_QA_SANDBOX_*` namespace (`qa-functions.mjs:46-69`, `_shared/qa-sandbox-config.ts`), so
  production's unprefixed names (`ACCESS_PROOF_*`, `ACCESS_APPLE_PRODUCTS_JSON`,
  `ACCESS_PROVIDER_PRODUCTS_JSON`, `APP_STORE_SERVER_*`, `REVENUECAT_*`, `PRODUCT_POLICY_*_DB_URL`)
  do not collide with QA.
- Smallest change: two operations following the analytics precedent.
  1. `purchase-functions`: a `PURCHASE_BUNDLE_SET` (`perRouteConfig` false) with a fixed ordered
     list and `verify_jwt` matching `supabase/config.toml`: `product-policy` (false, `:468-472`),
     `verify-apple-access` (false, `:479-481`), `link-apple-access` (true), `reconcile-entitlement`
     (true), `revenuecat-webhook` (false), `create-web-checkout` (true), `export-user-data` (true),
     `sync-settings` (true), and the production Stripe routes once PR-E lands. `product-policy-admin`
     only if D1 picks the owner page. Deploy order: read-only routes first, webhooks last.
  2. `purchase-secrets`: `plan`, `apply`, `rotate` modes like `analytics-subjects-secrets`; GitHub
     environment secrets named `PROD_*`, mapped to the unprefixed function names; never printed.
- Depends on: no owner decision for the Apple, RevenueCat and policy routes. The Stripe route names
  and secret names wait for D3. The owner creates the environment secrets (values outside Git).
- Risk: medium-high. `sync-settings` serves released 2.x apps' free sync. Redeploying it from `main`
  changes free-sync behaviour for every user. Keep it in a separate step of the operation, require
  0024 applied first (the released-app guard), and confirm with DB-01 and a 2.1 smoke test (V19).
  If its production version already equals `main`'s, leave it out.
- Tests: `qa-function-bundles.test.mjs`-style tests for the new set (names, order, `verify_jwt`
  equal to config.toml, no `qa-sandbox-*` route, no route outside the list); secrets op tests like
  `qa-secrets-operation.test.mjs` (closed names, no value in any output, rotate requires a current
  value); a rehearsal in `supabase-qa-functions-rehearsal.yml` style with the compiler boundary.
  After apply: V13, V14; each route answers without `unavailable` (runbook 2.4).
- Rollback: redeploy the previous reviewed commit through the same operation; rotate secrets
  through `purchase-secrets` (provider first if leaked).
- Estimate: functions op 12 h + 4 h review; secrets op 12 h + 4 h review.

### G4. Production web checkout is still the 2.x RevenueCat link

- Verified. `packages/core/src/sync/backend-route-profile.ts:23` sets production
  `createCheckout: "create-web-checkout", completeCheckout: null`.
  `packages/core/src/sync/profile.ts:39` turns managed checkout on only for
  `shared-hosted-sandbox`. `supabase/functions/create-web-checkout/index.ts` builds a RevenueCat Web
  Purchase Link from `REVENUECAT_WEB_BILLING_CHECKOUT_URL`. The Managed Payments code refuses live
  mode throughout (`_shared/qa-sandbox-managed-checkout.ts:83,97-99,228,253,266,318,323`,
  `_shared/qa-sandbox-stripe-webhook.ts:137,140,145`). The operation ledger is sandbox-only by
  constraint (`0021_qa_sandbox_access.sql:40-46`: `environment = 'sandbox'`, session id
  `^cs_test_`). No production Stripe webhook or completion route exists.
- Options (owner decision D3):
  - B, Stripe Managed Payments (runbook Phase 4 assumes it; the QA programme tested it end to end
    in test mode). Change: migration 0025 adding a production purchase-operation ledger (or an
    `environment` widening of the QA one, which touches a QA-proven table; a separate table is
    safer), production routes `complete-web-checkout` and `stripe-webhook` plus a live
    `create-web-checkout` mode, parameterising the shared managed-checkout and webhook code by a
    closed environment config (`livemode` true only for production, `cs_live_` only for
    production) without changing the sandbox paths, new secret names, the production route profile
    and `profile.ts:39` enabling managed checkout for production. Estimate 44 to 56 h + 12 h review.
  - A, RevenueCat Web Billing link (the 2.x design). Change: an `rc_billing` product for
    `still_pro_v3` (the parser already accepts it, `revenuecat-access.ts:57-60`), the link URL for
    the new offering, and V3 UI tests of the production link path, which the QA programme never
    exercised. Estimate 8 to 12 h + 3 h review, plus a QA pass. Tax handling differs: RevenueCat
    Billing is not a merchant of record, so the owner owns sales-tax registration.
- Risk: B is large and touches money, but repeats a tested design. A is small but untested in V3
  and changes who handles tax.
- Tests (B): Deno tests mirroring `qa-sandbox-managed-checkout.test.ts` and
  `qa-sandbox-stripe-webhook.test.ts` for live mode, plus tests that the sandbox routes still refuse
  live objects and the production routes refuse test objects; migration invariant SQL; core tests for
  the production route profile. Live proof is runbook 8.4 (V35, V36, V68, V69) with the owner's card.
- Rollback: sales off (2.6 undo) stops new checkouts; redeploy the previous routes; the migration
  is forward-only (additive table, unused if reverted).

### G5. Store packages cannot carry production access-proof trust

- Verified. `scripts/release/package.mjs:42-45` lists `VITE_ACCESS_ENVIRONMENT` and
  `VITE_ACCESS_PUBLIC_KEYS` as deliberately unpackaged. Without keys,
  `packages/core/src/entitlement/packaged-access-trust.ts:17` returns empty trust, and StillKit
  `NativeAccessConfiguration.swift:41-60` does the same when `StillAccessTrustKeys` is absent, so no
  production proof can verify and Still Pro never unlocks. Only the QA script writes the Apple plist
  keys (`apps/apple/scripts/paid-sandbox-qa.mjs:19,123`).
- Smallest change (D6 default): commit the production public verification keys (public material
  only: kid, 32-byte Ed25519 public key hex, environment `production`, purpose `access`) as one
  pinned source used by store builds: a JSON file read by `package.mjs` and the Chrome workflow as
  the value of `VITE_ACCESS_PUBLIC_KEYS` with `VITE_ACCESS_ENVIRONMENT=production`, and the same
  rows written into the four Apple Info.plists (`StillAccessTrustKeys`, `StillAccessEnvironment`).
  Add a guard: a store build refuses any key row whose environment is not `production`. Pin a
  current key and one standby key so rotation does not need a new store version. The private key is
  generated by the owner offline and set only as `ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64` through
  `purchase-secrets`.
- Depends on: D6. The plumbing and guard can land now with a test-only key fixture. The real public
  key lands in the release PR.
- Risk: medium. A mismatch between the pinned public key and the server's private key means no
  purchase unlocks. Note the runbook's rule against writing a "key id" into the repository: a
  self-chosen access-proof kid is not a provider credential, but the owner should confirm (D6).
- Tests: `package.mjs` tests (production env only, keys present, sandbox rows refused);
  `packaged-access-trust` tests with the pinned file; a StillKit test that the shipped plists parse
  to non-empty production trust; a CI check that the pinned public key equals
  `ACCESS_PROOF_PUBLIC_KEY_HEX`'s published hash (compared privately during 2.4).
- Rollback: revert before packaging; after release, rotate to the standby key.
- Estimate: 8 h + 2 h review.

### G6. The Chrome release workflow refuses a paid build

- Verified. `scripts/release/chrome-package.mjs:34-36` throws `paid-flag-on` when
  `PAID_TIER_ENABLED` is true; `scripts/release/chrome-store.test.mjs:563-564,620` pin it.
- Smallest change: replace "must be false" with "must equal the value the release line declares":
  add `paidTier: true|false` per line to the version record that `scripts/release/version.mjs`
  manages (or a required workflow input confirmed in `confirm_submit`), and refuse a mismatch either
  way (`paid-flag-mismatch`). Firefox packaging has no such guard; add the same check to
  `package.mjs` so both stores refuse an accidental flip.
- Depends on: nothing. Lands now with the declared value `false` for 2.x; the release PR sets 3.x to
  `true`.
- Risk: low.
- Tests: the existing tests, rewritten for both directions.
- Rollback: revert.
- Estimate: 3 h + 1 h review.

### G7. V3 screens need modern sync on in configured builds

- Verified, with a correction to the brief. `packages/ext-chromium/wxt.config.ts:41-45`
  (`runsV3Interface`) shows V3 screens on a configured build only with
  `VITE_MODERN_SETTINGS_SYNC_ENABLED=true`; `release-chrome.yml:106` already passes the repository
  variable through. `apps/apple/scripts/modern-sync-shipped` says `not-shipped`, but
  `apps/apple/scripts/release-env-guard.sh:125` accepts `not-shipped` without refusing. The guard
  refuses only mixed builds (`:102-116`) and, once the marker says `shipped`, any archive without
  modern sync on and configured (`:126-135`). So the marker does not block the V3 archive. The
  real change is a one-way commitment: once V3 ships with modern sync, the marker must say
  `shipped` in that commit (`:17-20`), and every later archive must keep modern sync on.
- Smallest change: in the release PR, set `VITE_MODERN_SETTINGS_SYNC_ENABLED=true` for every store
  build (repository variable for Chrome, `--env` for Firefox, Safari and app-webview builds) and set
  the marker to `shipped`.
- Depends on: D7 (owner approval for the one-way flip, as the marker comment requires). Production
  `sync-settings` must support modern sync (G3, step 1; DB-01 confirms 0015 and later are applied).
- Risk: medium. Conversion of saved settings is one-way, so a bad V3 cannot be fixed by going back
  to 2.x settings behaviour.
- Tests: `release-env-guard` tests already cover both marker states; V08; the fixtures Playwright
  lane with the configured V3 profile.
- Rollback: before upload, revert. After release, forward fixes only.
- Estimate: 2 h + 1 h review (inside PR-I).

### G8. App Review buys in the sandbox; production refuses sandbox transactions

- Verified. `supabase/functions/_shared/apple-access.ts:58-59` rejects a transaction whose
  `environment` differs from the route's (`production`), and
  `_shared/apple-edge-verifier.ts:224-225` queries only `api.storekit.apple.com` in production. So
  an App Review sandbox purchase against the production `verify-apple-access` returns nothing and
  the purchase fails in review. Client trust is single-environment (StillKit
  `AccessProof.swift`, `claims.environment == trust.environment`), so issuing a sandbox proof does
  not help either.
- Smallest change (D4 default): the production route keeps a second, sandbox Apple verifier (same
  products, Apple's sandbox host) used only when production verification fails with a sandbox
  environment. A sandbox transaction yields only a `paid_apple_local` right (device only, never
  linked to an account, never transferred), keyed with `sandbox` in its identity hash so it can
  never collide with a real purchase, and reported separately by PROD-02. Guarded by an explicit
  server switch (a secret such as `ACCESS_APPLE_ACCEPT_SANDBOX_LOCAL`) so the owner can turn it off.
- Open question for the owner, in plain words: TestFlight testers also buy in the sandbox, so
  anyone given a TestFlight build gets Still Pro on that device for free. Is that acceptable? Apple
  expects production servers to accept sandbox receipts for review.
- Unknown: how the Apple app behaves when a signed-in reviewer's purchase cannot attach to their
  account (the ADR 0005 sign-in-first flow calls `link-apple-access`). The rehearsal must show the
  device unlocks and the reviewer sees no error.
- Risk: medium-high (free-Pro leak to sandbox users; App Review rejection if wrong).
- Tests: Deno tests with sandbox and production transaction fixtures (production accepted as
  today; sandbox only local, only with the switch on; never account-linked; key includes
  `sandbox`); a TestFlight sandbox purchase against production before submission (runbook 1.7, V09).
- Rollback: turn the switch off (rotate the secret); redeploy the previous route.
- Estimate: 12 h + 4 h review.

### G9. Which entitlement Still Pro uses

- Verified. The code is consistent on `still_pro_v3`:
  `apps/apple/StillKit/Sources/StillKit/ApplePurchaseCatalog.swift:45-52` (`entitlementID:
  "still_pro_v3"`, offering `still_pro_v3`, package `$rc_lifetime`) and
  `supabase/functions/_shared/revenuecat-access.ts:16,23,55-59` (new products must use lookup key
  `still_pro_v3`; `still_sync` only for the historical product). Docs disagree:
  `docs/ARCHITECTURE.md:76` ("The immutable internal entitlement id remains `still_sync`"),
  `docs/PRODUCT.md:125`, `docs/monetization-design.md:33-34`, `docs/release/README.md:81-82`,
  `docs/release/04-revenuecat.md:80-138`.
- Smallest change (D5 default `still_pro_v3`): a docs-only PR saying: new V3 products use the
  `still_pro_v3` entitlement and offering; `still_sync` remains the historical entitlement, never
  renamed. No code change. Choosing `still_sync` instead would be a code change in both files and
  their tests, and would weaken the separation the catalog comment gives as its reason.
- Unknown worth checking at V22: the historical web product is documented as `still_sync_web`
  (`04-revenuecat.md:135`), but `parseAccessProductMappings` accepts only `still_pro_v3` or
  `still_sync` as a non-Stripe `store_identifier` and rejects the whole list on one bad row
  (`revenuecat-access.ts:57-60`). If RevenueCat reports `still_sync_web`, either leave that product
  out of `ACCESS_PROVIDER_PRODUCTS_JSON` (unmapped purchases are skipped, `:164-165`; historical web
  buyers then rely on their legacy entitlement rows) or widen the parser in a reviewed change.
- Risk: low (docs). The unknown above is medium.
- Tests: none for docs; V23, V24, V29, V52 for the portal.
- Rollback: revert docs.
- Estimate: 2 h + 1 h review (plus 2 h if the parser needs widening).

### G10. No read-only check shows production sales, cutoff or purchases

- Verified. `scripts/backend/qa-checks/catalogue.mjs:125-147` reads production only into a keyed
  digest ("Production counts, revisions and fingerprints are never printed or stored in the
  clear"). Labels in `.github/workflows/supabase-readonly-checks.yml:67-82` are QA accounts only.
  The views live in `scripts/backend/sql/qa-readonly-checks-candidate.sql` (for example
  `still_qa_checks.policy_heads` at `:229`, `paid_cutoff_environments` at `:233`).
- Smallest change:
  - PROD-01 (production sales and cutoff summary): newest production sales revision number,
    `salesEnabled`, both channel offers, the build list (all already public through
    `product-policy`), whether a production cutoff exists, its product id and benefits. It also
    gives the operator the `expected_revision` for G1. Needs one new view (the existing ones expose
    counts only), so the candidate SQL changes and must be re-installed.
  - PROD-02 (production purchase summary for one owner-registered label): right present, provider
    (Apple, web), active or revoked, Apple environment (production or sandbox, from G8), and a keyed
    reference only. Needs a production label in the owner-filled registry, which today holds QA
    accounts only.
- Depends on: PROD-01 none. PROD-02 waits on D8 (privacy review of printing a production account's
  purchase state, even keyed).
- Risk: low for PROD-01; medium for PROD-02 (privacy, public logs: keep the one-line log and the
  age-encrypted report pattern).
- Honest caveat: the candidate SQL is installed by pasting into the Supabase SQL editor
  (`qa-readonly-database-checks.md:105-108`), which sits awkwardly with the go-live runbook's
  "never the dashboard SQL editor against production". Either accept that documented exception for
  read-only views or install the new views as a reviewed numbered migration (0025 or 0026) through
  the protected workflow. Recommended: the migration.
- Tests: `qa-checks.test.mjs` (closed SQL, `sql-guard.mjs` passes, fields typed, no free-form
  input); the `rehearse-qa-readonly-checks.sh` replay.
- Rollback: revert; the views are read-only.
- Estimate: PROD-01 6 h + 2 h review; PROD-02 10 h + 3 h review.

### Also in scope

- Migrations 0022 to 0024 past the recorded tail 0021. Verified files exist
  (`supabase/migrations/0022_*`, `0023_*`, `0024_*`, each with a `verify/*.invariant.sql`). 0022's
  header says "Deploy ALONE through the protected migration operation after 0021 is verified", so
  run three separate `operation=migrations` runs in order, `plan-only` then `apply`, DB-01 after
  each (runbook 2.1, 2.2, V10, V12). 0023 is QA-only and additive. 0024 changes the released-app
  legacy settings error code, which directly helps 2.x users, so apply it before any
  `sync-settings` redeploy. Unknown: whether any of these were applied without a record; DB-01
  answers that first. No code. About 1.5 h operator time per run. Rollback: forward-fix migration.
- Paid flags. `packages/shared-types/src/entitlement.ts:15` (`PAID_TIER_ENABLED = false`) and
  `apps/apple/StillKit/Sources/StillKit/MonetizationConfig.swift:15` (`paidTierEnabled = false`)
  flip together in the release PR. Pinned by `MonetizationConfigTests` (the two must match) and
  `ProductPolicyRuntimeTests.swift:191-192` (asserts false); core tests that read the constant
  include `packages/core/src/ui/__tests__/access-recheck.paid-on.test.ts` and
  `paid-tier-*.test.ts`. Safe before sales: the evaluator ANDs the flag with remote
  `salesEnabled`. 3 h + 1 h review. Rollback after publication: only a new store version; stop
  sales remotely instead.
- Firefox store build omits Android: done (`wxt.config.ts:63`, `FIREFOX_ANDROID_RELEASE_DEFERRED =
  true`, PR #508). Re-checked at V07.

## Assumptions and decisions

| Item | State | Evidence or owner |
|---|---|---|
| D1 production sales path | Open. Recommended: protected `production-sales-policy` operation (on/off), owner page not used for V3 | Owner |
| D2 cutoff content (0016 question 6) | Open. Recommended: product `still-free-v2`, benefits `facebook.reels`, `instagram.reels`, `tiktok.all`, `youtube.shorts` (the sandbox's D2), after engineering confirms no Pro extra shipped free in the 2.1 release commits | Owner |
| D3 production web path | Open. Recommended: Stripe Managed Payments (option B), the QA-tested design; fall back to option A only if the date cannot absorb about two engineer-weeks | Owner |
| D4 App Review and TestFlight sandbox purchases in production | Open. Recommended: accept as device-only rights behind a server switch | Owner |
| D5 entitlement | Open. Recommended: `still_pro_v3` (the code) | Owner and engineering |
| D6 production public keys in the repository | Open. Recommended: commit public keys (current and standby); private key only in the secrets run | Owner |
| D7 modern-sync marker flip to `shipped` in the release commit | Approved: yes (owner, 21 Oct 2026, with D1 to D9 all at their defaults). Applied in the release branch, PR #544 | Owner |
| D8 PROD-02 privacy | Open. Recommended: one owner-registered label for the owner's own account, keyed reference only, age-encrypted report | Owner |
| D9 exact 3.0 build strings in the sales body | Open (runbook 0.3). Recommended: `chrome_desktop` and `firefox_desktop` `3.0.0`, `apple_mobile_host` and `apple_macos_host` `3.0`; no `firefox_android` | Owner |
| Production `sync-settings` already serves modern sync | Unknown | V11 owner read of Edge Functions; DB-01 |
| 0022 to 0024 not yet applied in production | Inferred from the recorded tail | V10 |
| Historical web product identifier in RevenueCat | Unknown (`still_sync_web` in docs) | V22 |

## Work units (PR-sized) and order

Can start now (no owner decision):

1. PR-A: PROD-01 read-only check (G10 part 1), with its views as a numbered migration.
   Verification: `qa-checks.test.mjs`, the replay rehearsal, CI. After merge and install, the
   owner approves one run; it shows production sales off and no cutoff (expected today).
2. PR-B: Chrome and Firefox paid-flag guard declares the line's value (G6). Verification:
   `node --test scripts/release/*.test.mjs`, `pnpm test:release`.
3. PR-C: production trust plumbing and store-build guard with a test key fixture (G5 part 1).
   Verification: `pnpm test`, `pnpm test:release`, `swift test --package-path apps/apple/StillKit`.
4. PR-D: `purchase-functions` and `purchase-secrets` operations for the Apple, RevenueCat, policy and
   account routes (G3 part 1). Verification: `node --test scripts/backend/deploy/*.test.mjs`, the
   functions rehearsal workflow, `deploy-workflow.test.mjs`.
5. Operator runs, no PR: migrations 0022, then 0023, then 0024 (`plan-only`, then `apply` with owner
   approval, DB-01 after each). Then `purchase-functions` and `purchase-secrets` apply once PR-D is
   merged and the owner has created the environment secrets.

Waits on a decision:

6. PR-H (D5): docs agree with `still_pro_v3`. Smallest; can go the day D5 is answered.
7. PR-E (D3): production web checkout (option B or A). Then extend PR-D's route list in a small
   follow-up and run the functions and secrets operations again.
8. PR-F (D4): Apple sandbox acceptance in production `verify-apple-access`.
9. PR-G (D1, D2, D9): `production-sales-policy` on/off with the pinned cutoff. Merge any time;
   apply `on` only at runbook 2.6 (after QA purchase tests end, Phases 3 and 4, V50 to V55, and
   before the Apple submission).
10. PR-J (D8): PROD-02.
11. PR-I, the release PR (D6, D7, D9): both paid flags true, store-build modern sync on, marker
    `shipped`, real production public keys pinned, versions and build number (runbook 1.1 to 1.3),
    G6's declared value `true` for 3.x. Verification: the full gate (`pnpm lint`, `pnpm typecheck`,
    `pnpm test`, `pnpm build`, both Playwright fixtures lanes, `pnpm test:release`,
    `swift test --package-path apps/apple/StillKit`) green on the exact commit that will be frozen
    (runbook 0.5, 1.4).

Critical path: D3, then PR-E (the largest unit), then the functions and secrets runs, then the
runbook's Phase 3 and 4 portal work, then V50 to V55, then the PR-G apply. PR-F and PR-I must be
done before the Apple upload.

## Acceptance scenarios

1. Given PR-A is installed, when the owner approves PROD-01, then it shows the production sales
   revision, `salesEnabled` false and no cutoff, and the public log has one line.
2. Given PR-G is merged and QA purchases are finished, when the owner approves
   `production-sales-policy` `on`, then V16 reads `salesEnabled` true with offer `still-pro-v3` on
   both channels and only 3.0 builds, PROD-01 shows the approved cutoff, and a 2.1 app still shows
   no Still Pro (V19).
3. Given sales are on, when the owner approves `off`, then new sales stop on every build, free
   blocking and existing rights are untouched, and the cutoff remains.
4. Given PR-F is deployed with the switch on, when App Review buys with a sandbox account on a 3.0
   build, then the device unlocks Still Pro, no account right is created, and PROD-02 shows a
   sandbox device-only right only for registered labels.
5. Given PR-C and PR-I, when a store-built Chrome package is installed and the owner buys with a
   real card, then the proof verifies with the pinned production key and the extras unlock on the
   second surface (V68).
6. Given any store build, when someone signs out and uses Still, then free blocking works with no
   purchase or account (V62).

## Risks and recovery

| Risk | Prevention | Recovery |
|---|---|---|
| Wrong cutoff content written forever | Owner answers D2 in writing; engineering checks the 2.1 release commits; pinned content reviewed in PR-G; plan-only shown before apply | None; the cutoff stays. Correct entitlement behaviour with a forward code change |
| Sales on before QA finishes | Order in runbook 2.6; PR-G apply is the last backend step | `off` operation; `pause-qa-sandbox` for QA |
| `sync-settings` redeploy changes free sync for 2.x users | 0024 first; separate step; 2.1 smoke test | Redeploy the previous commit through the same operation |
| Pinned public key does not match the server private key | Compare the hash privately during 2.4; a TestFlight purchase before submission | Rotate to the standby key |
| Free Pro for TestFlight sandbox testers (G8) | Device-only rights, separate key space, server switch | Turn the switch off |
| Live Stripe code refuses or accepts the wrong mode | Mode-symmetric tests; sandbox routes still refuse live objects | Sales off; redeploy the previous routes |
| Historical web product mapping breaks every RevenueCat read | V22 before building `ACCESS_PROVIDER_PRODUCTS_JSON`; V29 validation | Rebuild the JSON without the row; rotate the secret |
| Modern-sync flip is one-way | D7 explicit; the configured V3 Playwright lane | Forward fixes only |

## External and human gates

- Owner decisions D1 to D9 (above).
- Owner approval of every protected run (migrations, functions, secrets, sales, read-only checks).
  Agents never approve.
- The owner creates the GitHub environment secrets and generates the production access-proof key
  pair offline.
- The portal steps in runbook Phases 3 to 5 (RevenueCat, Stripe live, App Store Connect).
- Irreversible: the production cutoff; a submitted IAP; the modern-sync flip once shipped.

## Time estimate (one engineer plus review)

| Unit | Engineering | Review |
|---|---|---|
| PR-A PROD-01 | 6 h | 2 h |
| PR-B G6 | 3 h | 1 h |
| PR-C G5 | 8 h | 2 h |
| PR-D G3 (two operations) | 24 h | 8 h |
| PR-E G4 option B (option A: 8 to 12 h) | 44 to 56 h | 12 h |
| PR-F G8 | 12 h | 4 h |
| PR-G G1 and G2 | 14 h | 4 h |
| PR-H G9 docs (+2 h if the parser needs widening) | 2 h | 1 h |
| PR-I release PR (flags, G7, versions, keys) | 5 h | 2 h |
| PR-J PROD-02 | 10 h | 3 h |
| Operator runs (migrations, functions, secrets, sales) | 8 to 10 h | owner time |
| Total (option B) | about 136 to 150 h | about 39 h |

These are planning estimates for code that follows existing patterns. They exclude the owner's
portal and QA time, and they will move once D3 and D4 are answered.

## Completion evidence

- [ ] Each gap row in the runbook updated to Done with its PR number (runbook V02).
- [ ] CI green on each PR; the rehearsal workflows named above green for PR-A, PR-D, PR-G.
- [ ] Closing records of every protected run read and recorded (no values).
- [ ] V10 to V19 and V50 to V55 ticked in the runbook sitting.
- [ ] Decisions D1 to D9 recorded in the [V3 release record](../release/history/v3/README.md).
- [ ] A `docs/solutions/` note for the production-operation pattern (cutoff written by the
      protected operation, not the owner route), or recorded as unnecessary.

## Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-10-21 | Plan drafted; recommends the protected-operation path for sales and cutoff | The sandbox pair already proves the pattern, and it removes the need for a cutoff migration and the owner allowlist |
| 2026-10-21 | D2 precondition verified: no Still Pro extra existed in any released tree (tag v2.0.0, the 2.1.0 and 2.1.1 extension releases, Apple 2.1.0 build 9); with the paid tier off every packaged surface applied, and every surface was a YouTube Shorts, Instagram Reels, Facebook Reels or TikTok surface, so the four free ids are exactly what shipped free | Git read of the release commits and the packaged rule sets (seed 1.1.9 to 1.1.11); the hosted rule sets could not be read from Git but carried the same surface ids |
| 2026-10-21 | Owner ruled D1 to D9 at their defaults, including D7 (flip `modern-sync-shipped` to `shipped` in the release commit) | Owner, 21 Oct 2026 |
| 2026-10-22 | D7 applied in the release branch (PR #544): `modern-sync-shipped` says `shipped` | Owner ruling of 21 Oct 2026 |
| 2026-10-22 | Firefox data collection: the sign-in email address and the Still Pro purchase status become optional data collection, requested at runtime (at sign-in and at purchase), in a separate pull request. Until it lands, the manifest keeps main's declaration (required `authenticationInfo`, optional `technicalAndInteraction`) | Owner ruling on 22 October, reversing an earlier same-day choice of "required"; the required declaration was reverted from PR #544 |
