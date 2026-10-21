# Still V3 go-live runbook

One ordered checklist from "release candidate built" to "live in the App Store, Chrome Web Store and
Firefox Add-ons, with real payments". Written 21 October 2026. Facts marked "verified" were checked
on 21 October 2026; everything else says how to confirm it. Check each portal live before acting: a
dated line here is not a claim of current state.

The engineering work behind the gaps below, and the nine owner decisions D1 to D9 it waits on, are in
the [V3 release enablement plan](../plans/2026-10-21-001-v3-release-enablement.md).

Scope of the first V3 release (owner decision, 20 October 2026): Chrome desktop, Firefox desktop and
the Apple apps (Safari on iPhone, iPad and Mac). Firefox on Android is deferred to a later update,
not removed. Still Pro is twelve optional extras for a one-time $9.99 US-base lifetime price (D514),
with a seven-day voluntary web refund window; Apple purchases follow Apple's refund process. The V3
marketing version is written as 3.0 below; the owner confirms it in step 0.3.

**This repository is public.** Never write a key, token, key id, password, project reference, email
address, customer detail, account id or test-account name into this file, a PR, an issue or a
workflow input. Refer to portals by name and to configuration by its variable name only. Credentials
the owner hands over for a read-back live outside the repository for that sitting only.

## How to read this runbook

Every step names **Who**, **Where**, **Verify** and **Undo**, and carries one state:

| State | Meaning |
|---|---|
| **Done** | Finished and recorded; re-check only if something changed. |
| **Owner** | The owner does it in a portal or decides it. |
| **Engineering** | A coding agent or engineer does it through a reviewed PR or a read-only check. |
| **Owner approval** | Engineering starts a protected GitHub workflow run; the owner reads its plan and approves it. Agents never approve. |

Portal steps are written click by click. Menu names follow each portal as of October 2026; if a label
has moved, the ids and values are what matter. Each portal section ends with **It should look like**
(the expected end state) and **Read-back** (independent checks engineering runs). Every verification
has a number (V01, V02, ...) so the QA companion can tick them one by one in a sitting.

Product truths that hold at every step: free blocking and free settings sync never gain a purchase or
account requirement; Still Pro never gates the free outcome; host access stays the four supported
services; copy says "every supported surface", never "everywhere"; no release copy promises Firefox
on Android.

## Values that must match across systems

A mismatch in any row breaks purchases or unlocks. Check them all again in V50 to V55.

| Value | App Store Connect | RevenueCat | Stripe | Server and apps |
|---|---|---|---|---|
| Product id `still_pro_v3` | In-app purchase Product ID | Product identifier in each Apple app | Price lookup key `still_pro_v3` | `ApplePurchaseCatalog` (Apple), `ACCESS_APPLE_PRODUCTS_JSON`, `ACCESS_PROVIDER_PRODUCTS_JSON` |
| Entitlement `still_pro_v3` (see G9) | — | Entitlement identifier the new products attach to | — | `entitlement_lookup_key` in `ACCESS_PROVIDER_PRODUCTS_JSON`; `entitlementID` in `ApplePurchaseCatalog` |
| Historical entitlement and product `still_sync` | Removed from sale; never edited | Entitlement and its old products left exactly as they are | — | Historical mapping; never renamed |
| Offering `still_pro_v3`, package `$rc_lifetime` | — | Offering identifier and its Lifetime package | — | `ApplePurchaseCatalog` (`offeringID`, `packageID`) |
| Stripe price id (`price_...`) | — | Store identifier of the Stripe product in RevenueCat | The price created in 4.3 | Stripe `store_identifier` in `ACCESS_PROVIDER_PRODUCTS_JSON` and the price-id secret G4 names |
| Price $9.99 USD | Base price, United States | Shown from the store | Unit amount 999, currency USD, one-time | What the apps show before purchase and the checkout shows |
| Bundle id `com.chartash.still` | The app | App Store app bundle id | — | `bundleId` in `ACCESS_APPLE_PRODUCTS_JSON` |
| Sales offer `still-pro-v3` (hyphen) | — | — | — | Production sales body `channels.*.offer`; granted package |
| RevenueCat webhook | — | Destination `/functions/v1/revenuecat-webhook` on the production project; Authorization equals `REVENUECAT_WEBHOOK_TOKEN` exactly, no `Bearer ` | — | `revenuecat-webhook` route and secret |
| Stripe webhook | — | — | Destination `/functions/v1/<production Stripe route from G4>`; the five events in 4.4 | That route and its signing-secret name |

## Gaps found while writing this runbook (close first)

True of `main` on 21 October 2026. Each needs a reviewed PR (and, where marked, an owner decision)
before the phases named can finish. Closing them is Phase 0's main work.

| Gap | What the repository shows | Blocks | State |
|---|---|---|---|
| G1. No production sales switch in the protected workflow | `supabase-production-deploy.yml` offers `qa-sandbox-sales-policy` (sandbox body only) and no production sales operation. Production sales are published only through the owner-only `product-policy-admin` route (the page in `apps/owner-admin`), which needs an owner on the server allowlist and an approved-build list that nothing fills yet (its README, "Approved builds (known gap)"). Decide the production path and land it. | 2.6 | Engineering, Owner |
| G2. Production paid cutoff content is undecided | On the protected-operation path (plan D1 default), the cutoff needs no migration and no `cutoff.ts` change: the sales operation writes its cutoff row directly inside its own transaction, as `scripts/backend/deploy/operations/qa-sandbox-sales-policy-on.sql` already does for the sandbox. Migration 0016's refusal of a cutoff snapshot and `PAID_CUTOFF_SNAPSHOT = null` in `supabase/functions/product-policy-admin/cutoff.ts` matter only if D1 picks the owner-page path. What remains is the content: owner question 6 (which features count as released free; a protected product id that is not `still-pro-v3`) is open for production (plan D2). The sandbox used `still-free-v2` with Facebook Reels, Instagram Reels, TikTok and YouTube Shorts. The answer is pinned in the production operation (plan PR-G). | 2.6 | Owner, Engineering |
| G3. No protected path deploys production paid routes or writes their secrets | The workflow refuses arbitrary function lists; it deploys only the three analytics routes and the fixed `qa-sandbox-*` routes, and writes only analytics and `QA_STAGE_*` secrets. Production `product-policy`, `product-policy-admin`, `reconcile-entitlement`, `verify-apple-access`, `link-apple-access`, `create-web-checkout`, `revenuecat-webhook`, `sync-settings` and `export-user-data`, and their secrets (2.4), have no protected path. Add closed, reviewed operations following the QA operations' pattern. Never deploy them with the Supabase CLI from a checkout. | 2.3, 2.4, 4.5 | Engineering |
| G4. Production web checkout is still the 2.x design | `packages/core/src/sync/backend-route-profile.ts` sends production checkout to `create-web-checkout` (a RevenueCat Web Purchase Link from `REVENUECAT_WEB_BILLING_CHECKOUT_URL`) with no completion route, and `packages/core/src/sync/profile.ts:39` turns managed checkout on only for the sandbox profile. The Stripe Managed Payments checkout, its Stripe webhook and the RevenueCat import exist only as `qa-sandbox-*` routes, which refuse live mode, and the purchase-operation ledger accepts sandbox rows only (migration 0021, around lines 40 to 46: `environment = 'sandbox'`, test-mode session ids). So the Stripe path needs a new migration (a production ledger), production routes and a client change (plan PR-E). The owner chooses in plan D3: option B, Stripe Managed Payments (the QA-tested design this runbook's Phase 4 assumes, the larger change), or option A, the RevenueCat Web Billing link (smaller, untested in V3, and not a merchant of record, so the owner handles sales tax). | 3.3, 4.4 to 4.6, 8.4 | Owner, Engineering |
| G5. Store packages cannot carry production access-proof trust | `scripts/release/package.mjs` lists `VITE_ACCESS_ENVIRONMENT` and `VITE_ACCESS_PUBLIC_KEYS` as deliberately unpackaged ("store packages retain production empty-key defaults"). Decide how production public verification keys reach the Chrome, Firefox, Safari and Apple web-view builds, paired with the server's `ACCESS_PROOF_*` secrets. | 1.5, 1.6 | Engineering |
| G6. The Chrome release workflow refuses a paid build | `scripts/release/chrome-package.mjs` stops with `paid-flag-on` when `PAID_TIER_ENABLED` is true. Change that guard for V3 in a reviewed PR, or upload by hand. | 6.4 | Engineering |
| G7. V3 screens need modern sync on in configured builds | `runsV3Interface` in `packages/ext-chromium/wxt.config.ts` shows V3 screens on a configured build only with `VITE_MODERN_SETTINGS_SYNC_ENABLED=true`, so the configured V3 store builds must set it. `apps/apple/scripts/modern-sync-shipped` says `not-shipped`; `release-env-guard.sh` (around line 125) accepts that without refusing, so the marker does not block the V3 archive today. Flipping it to `shipped` is a one-way commitment: every later archive must then keep modern sync on. Decide the flip in plan D7 and make it in the release PR. | 1.3 | Owner, Engineering |
| G8. App Review buys in the sandbox | Apple reviewers buy with sandbox accounts against the production app. Confirm production `verify-apple-access` accepts an App Review sandbox transaction for `still_pro_v3`, or the review purchase fails. | 5.9 | Engineering |
| G9. Which RevenueCat entitlement V3 uses | The release brief says attach the new products to `still_sync`. The code says otherwise: `ApplePurchaseCatalog.swift` gives `still_pro_v3` its own entitlement `still_pro_v3` ("so the historical entitlement can never be mistaken for a new purchase"), and `supabase/functions/_shared/revenuecat-access.ts` requires `entitlement_lookup_key` `still_pro_v3` for the new products and `still_sync` only for the historical one. This runbook follows the code. The owner and engineering confirm before Phase 3; changing it means a reviewed code change, not a dashboard choice. | 3.4 | Owner, Engineering |
| G10. No read-only check shows production sales, cutoff or purchases | The read-only catalogue never prints production: DB-01 turns production rights, policy revisions and cutoff into a keyed digest, and rights are visible only for QA accounts. Add two reviewed checks (privacy-reviewed, closed SQL, same workflow): a production sales and cutoff summary, and a production purchase summary for one owner-registered label (right present, provider, active or revoked, keyed reference only). Working names below: PROD-01 and PROD-02. | V17, V66 to V69 | Engineering, Owner |

## Phase 0 — Prerequisites on main

**0.1 Release candidate QA sign-off** · Owner
- Where: the owner QA programme's issues log for the V3 candidate.
- V01: no open issue the owner rates as a release blocker; physical iPad stays owner-accepted
  skipped/unverified.

**0.2 Close gaps G1 to G10** · Engineering (G1, G2, G4, G9 and G10 also Owner)
- Where: one reviewed PR per gap, merged to `main`.
- V02: each gap row updated to Done with its PR number.
- Undo: revert the PR before any package is built from it.

**0.3 Owner decisions recorded** · Owner
- Plan decisions D1 to D9 (sales path, cutoff content, web path, sandbox purchases in review,
  entitlement, public keys, modern-sync flip, PROD-02 privacy, exact 3.0 build strings), plus the V3
  marketing versions, Family Sharing for the IAP (5.2), store order (8.1) and iOS/macOS phased
  release (5.8).
- V03: each recorded as a decision in the [V3 release record](history/v3/README.md).

**0.4 Firefox store builds omit Android** · Done
- `FIREFOX_ANDROID_RELEASE_DEFERRED = true` in `packages/ext-chromium/wxt.config.ts` (PR #508).
  Checked again in V07.

**0.5 Full gate green on the release commit** · Engineering
- Where: CI on `main`, plus `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm exec playwright test --project=fixtures` (both lanes), `pnpm test:release`,
  `swift test --package-path apps/apple/StillKit`.
- V04: every required check green on the exact commit that will be packaged.

## Phase 1 — Release build and signing

**1.1 Flip both paid flags together** · Engineering
- Where: one PR setting `PAID_TIER_ENABLED = true` in `packages/shared-types/src/entitlement.ts` and
  `paidTierEnabled = true` in `apps/apple/StillKit/Sources/StillKit/MonetizationConfig.swift`, and
  updating the tests that pin the shipped value (`MonetizationConfigTests` enforces that the two
  match; `ProductPolicyRuntimeTests.testShippedSwitchKeepsSalesOffWithoutARequest` asserts false).
- V05: both true in the merged commit; StillKit and TypeScript suites green. The core evaluator ANDs
  this flag with the remote `salesEnabled`, so nothing sells until 2.6.
- Undo: before packaging, revert. After publication only a new store version takes it back; stop
  sales with the remote switch (2.6) instead.

**1.2 Versions and the Apple build number** · Engineering
- Where: `node scripts/release/version.mjs set extension 3.0.0`, `set apple 3.0`, `bump-build`, then
  `check` ([versioning and packages](versioning-and-packages.md)); exact strings per 0.3.
- V06: `check` exits 0, and `appleBuild` (10 on `main` today; live apps are build 9) is higher than
  every uploaded build: App Store Connect, Apps, Still, TestFlight, iOS Builds and macOS Builds.
- Undo: versions only go up; a wrong number is fixed by a higher one.

**1.3 Release configuration** · Engineering
- Set `VITE_MODERN_SETTINGS_SYNC_ENABLED=true` for every configured store build (G7). Set
  `apps/apple/scripts/modern-sync-shipped` to `shipped` only if the owner approves it in plan D7: the
  flip is one-way, and every later archive must keep modern sync on.
- Public build values only, by name: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`, `VITE_MODERN_SETTINGS_SYNC_ENABLED`, plus whatever G5 adds.
  Apple also needs `REVENUECAT_PUBLIC_API_KEY` from the production Apple app in RevenueCat (not Test
  Store) and the Apple-only `VITE_REVIEW_SIGNIN_EMAIL`.
- Verify as part of V08: `release-env-guard.sh` passes; no `VITE_PACKAGE_IDENTITY`, no route profile
  other than `production`, no QA value in any store build.

**1.4 Freeze the release commit** · Engineering
- Record the full SHA on `main` every package below is built from. Later commits never change what
  was submitted.

**1.5 Chrome and Firefox packages** · Engineering (Owner approval for the Chrome workflow build)
- Where: `node scripts/release/package.mjs --out <dir> --env <NAME>=...`, or `release-chrome.yml` in
  `package-only` mode (after G6) for Chrome.
- V07: `SHA256SUMS.json` written; Firefox `manifest.json` has no `gecko_android`; both manifests list
  only the documented permissions and the four supported hosts, no `<all_urls>`; the exact zips
  installed and smoke-tested (free blocking signed out, sign-in, Get Still Pro shown).
- Undo: discard and rebuild; nothing has reached a store.

**1.6 Apple archives** · Engineering
- Where: `apps/apple/scripts/archive.sh` for iOS and `xcodebuild archive` for the macOS scheme
  ([Apple build helpers](../../apps/apple/scripts/README.md)).
- V08: marketing version and build match `version.json`; nested bundle ids, App Group and
  entitlements correct; web resources from the frozen commit; release env guard passed.

**1.7 Upload Apple builds** · Owner approval
- Where: `UPLOAD=1` on `archive.sh`, or Xcode, Window, Organizer, Archives, the archive, Distribute
  App, App Store Connect, Upload.
- V09: App Store Connect, Apps, Still, TestFlight shows each build as "Ready to Submit" (processed).
  Install from TestFlight on iPhone and Mac: free blocking, sign-in, and a sandbox Still Pro purchase.
- Undo: TestFlight, the build, Expire Build. The build number stays used.

## Phase 2 — Backend production (Supabase)

All writes go through the protected **Supabase production deploy** workflow
(`supabase-production-deploy.yml`, environment `supabase-production`). Never use the Supabase CLI,
the dashboard SQL editor or a linked checkout against production. There is no automatic rollback; a
failed apply is fixed forward with a reviewed change.

**How the owner approves a run (every "Owner approval" step in this phase):**
1. Open the run link engineering sends (GitHub, the repository, Actions, "Supabase production deploy").
2. Open the **plan** job's summary. Check the commit, the operation name and, for migrations, the
   exact file names. Engineering always runs `mode=plan-only` first, then `mode=apply`.
3. On the apply run, click **Review deployments**, tick **supabase-production**, click **Approve and
   deploy**.
4. It should look like: the apply job turns green and its closing record says the read-only checks
   passed. Engineering reads the closing record before starting the next run.

**How the owner reads Supabase without changing anything:** Supabase dashboard, the production
project, **Edge Functions** (each route's version and last deploy time), **Edge Functions, Secrets**
(names only; never reveal a value), **Project Settings, API, Exposed schemas** (`net` must not be
listed).

**2.1 Inventory production** · Owner approval
- Where: `gh workflow run supabase-readonly-checks.yml --ref main -f check=DB-01 -f account=none -f account_b=none`
  ([read-only checks](qa-readonly-database-checks.md)), plus the dashboard read above.
- V10: DB-01 reports the hosted migration tail (last recorded 0021, 10 October).
- V11: the owner lists, from Edge Functions, which production routes predate the 7 to 20 October
  merges (scoped purchase ownership #353/#354, sandbox ledger boundary #362, payment records kept on
  deletion #395, sandbox sync fixes #440/#441, Apple OCSP verification, the QA reconcile/link
  "unavailable" answers). None has a production deploy record.

**2.2 Apply pending migrations** · Owner approval
- Where: `operation=migrations`, `migrations=<exact comma-separated names from V10's gap>` (on
  21 October, `main` holds 0022 to 0024 past the recorded tail), `policy_mode=none`, `commit=<sha>`.
- V12: closing record passes; DB-01 re-run shows the new tail.
- Undo: fix forward with a reviewed migration.

**2.3 Deploy production paid routes** · Owner approval (blocked by G3)
- Where: the production-routes operation G3 adds, from the frozen commit.
- V13: each route reads back at the planned source; the dashboard shows the new versions.
- Undo: redeploy the previous reviewed commit through the same operation.

**2.4 Production function secrets** · Owner approval (blocked by G3, G4, G5)
- Names only: `ACCESS_PROOF_ENVIRONMENT`, `ACCESS_PROOF_KEY_ID`, `ACCESS_PROOF_PRIVATE_KEY_PKCS8_BASE64`,
  `ACCESS_PROOF_PUBLIC_KEY_HEX`, `ACCESS_APPLE_PRODUCTS_JSON`, `ACCESS_PROVIDER_PRODUCTS_JSON`,
  `APP_STORE_SERVER_ISSUER_ID`, `APP_STORE_SERVER_KEY_ID`, `APP_STORE_SERVER_PRIVATE_KEY`,
  `REVENUECAT_PROJECT_ID`, `REVENUECAT_ACCESS_SECRET_API_KEY`, `REVENUECAT_SECRET_API_KEY`,
  `REVENUECAT_WEBHOOK_TOKEN` (set in July), `PRODUCT_POLICY_READER_DB_URL`,
  `PRODUCT_POLICY_ADMIN_DB_URL`, and the live Stripe names G4 defines (the QA lane's equivalents:
  Stripe secret key, account id, webhook signing secret, API version, price id, product id, the
  RevenueCat Stripe public key, return origin and return paths).
- `ACCESS_PROVIDER_PRODUCTS_JSON` is built by engineering from the RevenueCat read-back (V30): one
  entry per RevenueCat product, with that product's RevenueCat id, app id, store identifier,
  entitlement lookup key and store.
- V14: every name appears in Edge Functions, Secrets; the routes answer without `unavailable`.
- Undo: rotate through the same operation; a leaked value is rotated at its provider first.

**2.5 Signed-in analytics switch-on** · Owner approval
- Where: the four steps in [analytics subjects switch-on](analytics-subjects-switch-on.md). Step 4
  waits until the V3 builds send `projectKeySha256`.
- V15: each closing record passes; a production-channel build gets an identity; a deleted test
  account's person is removed after the next worker run.
- Undo: `operation=analytics-subjects-switch policy_mode=disable mode=apply`.

**2.6 Paid cutoff and production sales on** · Owner, Owner approval (blocked by G1, G2)
- Order: after Phases 3 and 4 and the cross-system check (V50 to V55), after QA purchase tests are
  finished, and before the Apple submission (reviewers must see Get Still Pro).
- Where: the production path G1 lands (plan D1; by default a protected production sales operation,
  plan PR-G). Body: `salesEnabled: true`; channels `apple` and `web`
  enabled with offer `still-pro-v3`; approved builds only the 3.0 builds (plan D9). The first
  activation writes the one write-once cutoff with the content the owner chose (G2, plan D2).
- V16: engineering posts `{"namespace":"sales","environment":"production"}` to the public
  `product-policy` route (public anon key only; no secret) and reads the new revision, `salesEnabled`
  true, both offers `still-pro-v3`, and only 3.0 builds listed.
- V17 (needs G10's PROD-01): the production cutoff is present with the approved product id.
- V18: DB-35 reports "production unchanged since baseline: no", as expected after this step.
- V19: a released 2.1 app still shows no Still Pro.
- Undo: publish `salesEnabled: false` (owner page "Undo last change", or the G1 operation). New
  sales stop on every build; free blocking and existing Pro rights are untouched. The cutoff stays.
- Note: once production has a cutoff, `qa-sandbox-sales-policy` refuses both directions; stop QA
  purchases with `pause-qa-sandbox`.

**2.7 Review sign-in configuration** · Engineering, Owner
- Where: [account and reviewer reference](extension-purchase-deploy-checklist.md), section 1c.
- V20: `review-signin` and its `REVIEW_SIGNIN_*` secrets match the private App Review fields and the
  Apple build's `VITE_REVIEW_SIGNIN_EMAIL`. Do not rotate while any review references it.

## Phase 3 — RevenueCat production

Set up and validated in July 2026 ([RevenueCat runbook](04-revenuecat.md)): entitlement `still_sync`,
the Apple `still_sync` product, an offering, and the production webhook to the Supabase
`revenuecat-webhook` route. QA used a separate sandbox configuration; nothing carries over. Leave
everything named `still_sync` exactly as it is. Steps 3.2 to 3.5 follow G9 (entitlement
`still_pro_v3`); confirm G9 first.

**Owner, click by click** (RevenueCat dashboard, the production Still project, not the QA one):

3.1 **Check the Apple app.** Left menu **Apps & providers**, open the App Store app. Bundle ID reads
`com.chartash.still`; **In-app purchase key configuration** reads valid. Note whether a separate Mac
App Store app is listed; if so, repeat 3.2 for it. State: Owner (confirm).

3.2 **Add the Apple product.** **Product catalog**, **Products** tab, **+ New product**. App: the App
Store app. Identifier: `still_pro_v3` (must match App Store Connect). Type: Non-consumable. Display
name: `Still Pro`. **Save**. State: Owner.

3.3 **Add the web product.** (Blocked by G4 and 4.3.) If G4 keeps the QA design (Stripe app import):
**Apps & providers**, confirm the Stripe app is connected to the live Stripe account; then
**Products**, **+ New product**, App: the Stripe app, Identifier: the live Stripe price id from 4.3
(must match Stripe), Type: Non-consumable, Display name `Still Pro`, **Save**. State: Owner.

3.4 **Create the entitlement and attach.** **Product catalog**, **Entitlements** tab, **+ New
entitlement**. Identifier: `still_pro_v3`. Description: `Still Pro`. **Save**. Open it, **Attach**,
tick the App Store `still_pro_v3` (and Mac, if listed) and the Stripe product, **Attach**. Do not open
or change `still_sync`. State: Owner.

3.5 **Create the offering.** **Product catalog**, **Offerings** tab, **+ New offering**. Identifier:
`still_pro_v3`. Display name: `Still Pro`. **Save**. Open it, **+ New package**, Identifier
**Lifetime** (`$rc_lifetime`), Description `Still Pro lifetime`, attach the same products as 3.4,
**Save**. Do not make it the default offering; the apps ask for it by id. State: Owner.

3.6 **Check the webhook.** **Integrations**, **Webhooks**, the existing production configuration.
URL ends `/functions/v1/revenuecat-webhook` on the production project; **Authorization header value**
is set (the exact `REVENUECAT_WEBHOOK_TOKEN`, no `Bearer `); **Environment**: Production; app filter:
all apps; events: all, or at least initial purchase, non-renewing purchase, cancellation (refund) and
transfer. The account's plan includes webhooks. State: Owner (confirm).

3.7 **Record restore behaviour.** **Project settings**, **General**, **Restore behavior**. Write the
value in the release record; do not change it ([ADR 0003](../adr/0003-entitlement-authority-receipt-and-server.md)).

3.8 **Check data exports.** **Integrations** and **Scheduled Data Exports**: nothing the privacy label
and policy do not disclose.

3.9 **Create the read-back key.** **Project settings**, **API keys**, **+ New secret API key**. Name:
`Still read-only verification`. Version: V2. Permissions: Project configuration **Read only**,
Customer information **Read only**, everything else **No access**. **Generate**, copy once, hand it to
engineering privately for the sitting. Never put it in the repository.

**It should look like:** one entitlement `still_pro_v3` with the Apple `still_pro_v3` product(s) and
the Stripe product attached; one offering `still_pro_v3` with a Lifetime package holding the same
products; `still_sync` and its products unchanged; the production webhook enabled with recent
successful deliveries.

**Read-back** (engineering, with the 3.9 key, against RevenueCat REST API v2; project id held privately):

| # | Request | Expect |
|---|---|---|
| V21 | `GET /v2/projects/{project_id}/apps` | The App Store app has bundle id `com.chartash.still`; note the Stripe app |
| V22 | `GET /v2/projects/{project_id}/products` | `still_pro_v3` on each Apple app, one-time non-consumable; the Stripe product's store identifier equals the Stripe price id (V31). Also check the historical web product: if its store identifier is `still_sync_web` and it would go into `ACCESS_PROVIDER_PRODUCTS_JSON`, `revenuecat-access.ts` (around lines 57 to 60) rejects it, and with it the whole product list, so every purchase check answers unavailable. Leave it out of the list, or resolve it with engineering, before 2.4 |
| V23 | `GET /v2/projects/{project_id}/entitlements` | `still_pro_v3` exists; `still_sync` still exists |
| V24 | `GET /v2/projects/{project_id}/entitlements/{still_pro_v3 id}/products` | Exactly the new Apple and Stripe products |
| V25 | `GET /v2/projects/{project_id}/entitlements/{still_sync id}/products` | The same historical products as before; nothing new |
| V26 | `GET /v2/projects/{project_id}/offerings` then `/offerings/{id}/packages` with products expanded | Offering `still_pro_v3`, package `$rc_lifetime`, the new products |
| V27 | The v2 webhook-integration read if the key can reach it; otherwise the owner reads 3.6 on screen and engineering reads `revenuecat-webhook` logs | Production URL, production environment, recent deliveries 2xx |
| V28 | Owner confirms 3.7 and 3.8 on screen | Values recorded |
| V29 | Engineering compares V22 and V24 with `revenuecat-access.ts` | Every mapping it would build passes that file's validation |
| V30 | Engineering builds `ACCESS_PROVIDER_PRODUCTS_JSON` from V21 and V22 (kept private) | Handed to 2.4 |

Undo: detach a product or delete the new offering or entitlement while nothing has sold. Never delete
or rename `still_sync`, and never delete a product that has purchases.

## Phase 4 — Stripe live

Nothing exists in live mode yet. All steps are owner actions in the Stripe Dashboard with **Test
mode off**. Live keys reach production only through the protected secrets run (2.4).

**Owner, click by click:**

4.1 **Activate the account.** **Settings**, **Business**: complete business details; **Settings**,
**Payouts**: add the bank account. It should look like: no "Activate payments" banner on Home;
payouts enabled.

4.2 **Turn on Managed Payments.** **Settings**, **Managed Payments** (or **Payments**, **Managed
Payments**), **Get started**, accept the terms, choose the digital software category. It should look
like: Managed Payments shows Active. If the product or country is ineligible, stop: G4 changes.

4.3 **Create the product and price.** **Product catalog**, **+ Add product**. Name: `Still Pro`.
Description: owner-approved one line. Pricing: **One-off**, `9.99`, `USD`. Open **More pricing
options**, set **Lookup key** to `still_pro_v3` (must match the product id elsewhere). Tax: as
Managed Payments requires for digital software. **Add product**. Copy the price id (`price_...`) for
3.3 and 2.4, privately.

4.4 **Add the live webhook.** (Blocked by G4.) **Developers**, **Webhooks**, **+ Add endpoint** (or
**Add destination**). Endpoint URL: `https://<production project>.supabase.co/functions/v1/<production Stripe route from G4>`
(the project is the one in the `SUPABASE_PRODUCTION_PROJECT_REF` repository variable). API version:
the one G4 pins. Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded` (the QA
route's set; adjust only if G4 changes it). **Add endpoint**, then **Reveal** the signing secret and
hand it to the 2.4 run. Do not send a test event to production.

4.5 **Create the server key.** (Blocked by G4.) **Developers**, **API keys**, **Create restricted
key**, with only the permissions G4 lists. Hand it to the 2.4 run privately.

4.6 **Connect RevenueCat.** (Blocked by G4.) Install the RevenueCat app from the Stripe App
Marketplace on the live account and link it to the production RevenueCat project, as G4 requires.
It should look like: RevenueCat, Apps & providers, the Stripe app shows the live account connected.

4.7 **Create the read-back key.** **Developers**, **API keys**, **Create restricted key**. Name:
`Still read-only verification`. **Read** on Products, Prices, Checkout Sessions, Charges, Refunds and
Webhook Endpoints; **None** on everything else. Hand it to engineering privately.

4.8 **Refund procedure.** **Payments**, open the payment, **Refund**, full amount, reason "Requested
by customer", **Refund**. Under Managed Payments, confirm on screen whether refunds run through
Stripe's managed flow. Write the result into the support page (7.3).

**It should look like:** live mode active with payouts; Managed Payments Active; one product "Still
Pro" with one active one-off USD 9.99 price whose lookup key is `still_pro_v3`; one enabled live
webhook endpoint pointing at the production route with the five events.

**Read-back** (engineering, with the 4.7 key, `Stripe-Version` set to G4's pinned version):

| # | Request | Expect |
|---|---|---|
| V31 | `GET /v1/prices?lookup_keys[]=still_pro_v3&expand[]=data.product` | One active price: `unit_amount` 999, `currency` usd, `type` one_time; product name "Still Pro", active; `livemode` true |
| V32 | `GET /v1/products?active=true` | No second "Still Pro" product or stray live price |
| V33 | `GET /v1/webhook_endpoints` | One enabled endpoint at the production route path, `enabled_events` exactly the five, `livemode` true |
| V34 | Owner reads Managed Payments status on screen (no read-only API for it) | Active |
| V35 | After 8.4's purchase: `GET /v1/checkout/sessions/{id}` | `livemode` true, `managed_payments.enabled` true, `amount_total` 999, `currency` usd, `payment_status` paid |
| V36 | After 8.4's refund: `GET /v1/refunds?charge={charge}` | One full refund, `status` succeeded |

Undo: archive the price (an amount cannot be edited; create a new price), disable the endpoint, roll
or delete keys. A charged customer can only be refunded.

## Phase 5 — App Store Connect

Verified 21 October 2026: `still_pro_v3` ("Still Pro", non-consumable) exists in state
`MISSING_METADATA` (no price, localization or review screenshot; never submitted); the old
`still_sync` IAP is removed from sale; iOS and macOS are live at 2.1.0 (build 9) with no new version
and nothing pending. Paid Apps agreement, tax and banking were in force for the July 2026 sales. The
IAP must go to review with the first V3 submission.

**Owner, click by click** (appstoreconnect.apple.com):

5.1 **Agreements.** **Business** (formerly Agreements, Tax, and Banking). Paid Apps agreement:
Active; tax forms: Active; bank account: Active. Nothing expiring. State: Owner (confirm).

5.2 **Complete the IAP.** **Apps**, **Still**, left menu **Monetization**, **In-App Purchases**,
**Still Pro** (`still_pro_v3`).
- a. **Availability**, **Set Up Availability**: all countries or regions where the app is available,
  **Confirm**.
- b. **Price Schedule**, **Add Pricing**: Base Country or Region **United States (USD)**, Price
  **$9.99** (Apple retired numbered tiers in 2023; this is the old Tier 10 price point), **Next**,
  keep Apple's equalized prices for other regions, **Next**, **Confirm**.
- c. **App Store Localization**, **+**: English (U.S.); Display Name `Still Pro`; Description (55
  characters at most, owner-approved; draft: `Twelve extra controls. One-time purchase.`); **Add**.
- d. **Review Information**: Screenshot, upload the Get Still Pro screen from the 3.0 build. Review
  Notes: `One-time, non-consumable purchase. Open Still and tap Get Still Pro. Sign-in is offered
  first and can be skipped with "Buy without an account". Restore purchase works without signing in.`
- e. **Family Sharing**: leave off unless the owner decides otherwise in 0.3 (once on, it cannot be
  turned off; the apps keep a family-shared purchase on the device only).
- f. **Tax Category**: leave "Match to parent app".
- g. **Save**. It should look like: status "Ready to Submit".
- Undo: everything is editable until submitted.

5.3 **Create the 3.0 versions.** On the app page, **+** next to **iOS App**, version `3.0`,
**Create**. In **Build**, **Add Build**, choose the 1.7 build, **Done**. Repeat with **+** next to
**macOS App**. Undo: delete an unsubmitted version.

5.4 **Listing and screenshots.** On each version: Promotional Text, Description, Keywords, What's
New and screenshots from the approved V3 copy and set (6.1, 6.2). State: Owner (not yet written).

5.5 **App Privacy.** Left menu **App Privacy**, **Edit**. Keep the analytics types (ADR 0004). Make
sure **Purchases, Purchase History** is ticked, purpose **App Functionality** covering Still Pro,
linked to the user: Yes, used for tracking: No. The release brief says Purchase History must be
added; [listing copy section 4](store-listing-copy.md#4-apple--app-privacy-the-label) records it as
already declared for historical purchases, so confirm on screen. **Publish**. The label must match
`PrivacyInfo.xcprivacy` and the published privacy policy (7.1).

5.6 **App Review Information** (each version). Sign-in required: Yes; review account only in the
private username and password fields (2.7). Notes: the V3 Still Pro text in the
[Apple runbook](01-apple-app-store.md#review-instructions).

5.7 **Attach the IAP** (each version). Section **In-App Purchases and Subscriptions**, **+** (or
**Select In-App Purchases or Subscriptions**), tick **Still Pro**, **Done**. Undo: remove it before
submission.

5.8 **Release options** (each version). **App Store Version Release**: **Manually release this
version**. **Phased Release for Automatic Updates**: per 0.3. Save.

5.9 **Submit** (after 2.6 and G8). **Add for Review**, then **Submit to App Review**, once per
platform. Undo before review starts: open the submission, **Remove from Review**.

**It should look like:** both 3.0 versions "Waiting for Review" with the 1.7 builds, Still Pro
"Waiting for Review", App Privacy published with Purchase History.

**Read-back** (engineering, with an App Store Connect API key the owner creates in **Users and
Access**, **Integrations**, **App Store Connect API**, **Team Keys**, **+**, role App Manager, and
hands over privately with its issuer and key id; a short script signs an ES256 JWT, valid 20
minutes or less, and calls these endpoints; ids are looked up at run time, never written down):

| # | Request | Expect |
|---|---|---|
| V40 | `GET /v1/apps/{app}/inAppPurchasesV2?filter[productId]=still_pro_v3` | `inAppPurchaseType` NON_CONSUMABLE; `state` READY_TO_SUBMIT before 5.9, WAITING_FOR_REVIEW after; `familySharable` per 0.3 |
| V41 | `GET /v2/inAppPurchases/{iap}/inAppPurchaseLocalizations` | en-US name "Still Pro" and the approved description |
| V42 | `GET /v2/inAppPurchases/{iap}/iapPriceSchedule` with `include=baseTerritory,manualPrices`, then the price point | Base territory USA, customer price 9.99 |
| V43 | `GET /v2/inAppPurchases/{iap}/appStoreReviewScreenshot` | Present, asset delivery state COMPLETE |
| V44 | `GET /v2/inAppPurchases/{iap}/inAppPurchaseAvailability` | Territories match the app's |
| V45 | `GET /v1/apps/{app}/appStoreVersions?include=build` | iOS and macOS `versionString` 3.0, state WAITING_FOR_REVIEW, each with the 1.7 build number |
| V46 | `GET /v1/reviewSubmissions?filter[app]={app}` then `/v1/reviewSubmissions/{id}/items` | One submission per platform holding its 3.0 version; if the IAP is not listed as an item, V40's WAITING_FOR_REVIEW at the same time is the proof it went with this submission |
| V47 | Owner reads App Privacy on screen | Purchase History and analytics declared as above |
| V48 | Owner reads Business on screen | Agreements, tax and banking Active |

## Cross-system consistency (before 2.6 and 5.9)

Engineering compares the read-backs side by side; the owner ticks each.

| # | Check | Sources |
|---|---|---|
| V50 | Product id `still_pro_v3` identical in App Store Connect, RevenueCat (each Apple app) and the Stripe lookup key | V40, V22, V31 |
| V51 | The RevenueCat Stripe product's store identifier equals the live Stripe price id, and the server's price-id secret holds the same value (compared by engineering privately) | V22, V31, 2.4 |
| V52 | Entitlement and offering ids in RevenueCat equal those in `ApplePurchaseCatalog.swift` and `ACCESS_PROVIDER_PRODUCTS_JSON` | V23, V26, V30 |
| V53 | Price: Apple US base 9.99, Stripe 999 USD, and the amount the 3.0 builds show before purchase (Apple sheet in the US storefront; the web checkout page) all read $9.99 | V42, V31, TestFlight and the 1.5 package |
| V54 | Production sales body offers `still-pro-v3` on both channels and lists only the 3.0 builds | V16 |
| V55 | Webhook destinations point at production routes, not `qa-sandbox-*` | V27, V33 |

## Phase 6 — Chrome Web Store and Firefox Add-ons

| Step | Chrome Web Store | Firefox Add-ons (AMO) | Who | State |
|---|---|---|---|---|
| 6.1 Listing copy | Add the V3 Still Pro wording to [listing copy](store-listing-copy.md#6-chrome-web-store) (currently 2.1, free only) | Same, [AMO section](store-listing-copy.md#7-firefox-add-ons-amo); describe the optional purchase | Engineering drafts, Owner approves | Owner |
| 6.2 Screenshots | No V3 Pro set exists; capture with `screenshots/source/v3` tooling into [store-ready](screenshots/store-ready/README.md) | Same | Engineering, Owner approves | Engineering |
| 6.3 Privacy | Developer Dashboard, Still, **Privacy practices**: data categories match V3 (account, settings, purchase status, analytics); privacy URL | Developer Hub, Still, **Edit Product Page**: privacy text matches the manifest's `data_collection_permissions` | Owner | Owner (confirm) |
| 6.4 Upload | `release-chrome.yml`: `package-only`, test the zip, then `upload-and-submit` with `confirm_submit` `submit <version>` (after G6); or **Package**, **Upload new package** in the dashboard | Developer Hub, Still, **Upload New Version**: the Firefox zip, then the source zip and build instructions | Owner approval (Chrome); Owner (AMO) | Owner |
| 6.5 Compatibility | Desktop only by nature | On the upload's platform step, **untick Firefox for Android**; the build has no `gecko_android` | Owner | Owner |
| 6.6 Reviewer notes | Free blocking signed out; Pro optional; no purchase needed to review; private access only in private fields | Same, plus reproducible-source instructions | Owner | Owner |
| 6.7 Publication | Goes live to everyone on approval | **Continue** after validation can publish before **Submit Version**; have everything ready first ([AMO lesson](../solutions/conventions/amo-continue-can-publish-an-update.md)) | Owner | Owner |

- V56: Chrome `release-chrome.yml` in `status` mode (or the dashboard) shows 3.0 in review, then published.
- V57: the AMO version page lists Firefox only, no Android; the public AMO API shows the version once public.
- Undo: Chrome, cancel review in the dashboard, or ship a higher version later. AMO, **Manage
  Status & Versions**, disable the version, or ship a higher one.

## Phase 7 — Website publishes

The site publishes from `gh-pages`, separately from `main`. All publishes are owner actions; undo is
reverting the `gh-pages` commit.

- **7.1 Privacy policy for Still Pro** · Owner. Merge PR #477 (source, `main`), then PR #478
  (publish, `gh-pages`); both drafts on 21 October. Before any store submission, because every
  listing links it. V58: `https://stillapp.fit/privacy/` shows the Still Pro purchase sections.
- **7.2 Setup guide** · Owner. PR #484 (`main`, draft, includes the Firefox on Android deferral)
  plus a matching `gh-pages` publish. V59: the live guide promises no Firefox on Android.
- **7.3 Support page** · Owner. The ISS-0110 change (confirm its PR), published to `gh-pages`. V60:
  states the seven-day web refund request, Apple refunds through Apple, and Restore.
- **7.4 Site-wide wording** · Owner. No page says Still is free-only or promises permanent free
  pricing; download links point to the right stores; "every supported surface".

## Phase 8 — Order, production proof and monitoring

**8.1 Order** · Owner decides (0.3). Recommended:
1. Phases 2 to 5 and 7.1 done; V50 to V55 ticked; production sales on for 3.0 builds only (2.6).
2. Submit Apple iOS and macOS with the IAP, manual release (5.9).
3. When Apple approves, submit Chrome and Firefox (Chrome goes live on approval; AMO can publish on
   Continue).
4. Release Apple manually when Chrome and Firefox are public. Do not announce yet: real-money
   purchases need public store builds, so the proof below runs between release and announcement.

**8.2 Per-surface smoke test (store-installed 3.0 builds)** · Owner

| # | Check | Chrome | Firefox desktop | Mac Safari | iPhone Safari |
|---|---|---|---|---|---|
| V61 | Installed version is 3.0 | | | | |
| V62 | Free blocking signed out (Shorts, Reels, TikTok website) | | | | |
| V63 | Email-code sign-in and settings sync | | | | |
| V64 | Get Still Pro shows $9.99 (or the local equivalent) | | | | |

Physical iPad stays owner-accepted skipped/unverified.

**8.3 Apple real-money purchase and refund** · Owner (Engineering reads results)
1. On iPhone (or Mac), signed in to Still, buy Still Pro for $9.99 with the owner's own Apple
   Account.
2. V65: the extras unlock on that device; on a second device (Mac Safari, or Chrome) signed in to the
   same Still account, they unlock too.
3. V66: RevenueCat customer read (`GET /v2/projects/{project_id}/customers/{customer_id}/active_entitlements`,
   with the customer id held privately) shows `still_pro_v3` active from the App Store; the
   `revenuecat-webhook` delivery succeeded; PROD-02 (G10) shows one active Apple right for the owner
   label.
4. Request a refund at Apple's reportaproblem.apple.com. Apple decides, and it can take up to two
   days or be declined; record the outcome.
5. V67: when Apple refunds, RevenueCat records the refund, the entitlement is inactive, PROD-02 shows
   the right revoked, the extras switch off on both devices, and free blocking still works.

**8.4 Stripe real-money purchase and refund** · Owner (Engineering reads results)
1. On the store Chrome build, signed in, buy Still Pro for $9.99 with the owner's own card.
2. V68: the extras unlock on Chrome; on Firefox or iPhone signed in to the same account, they unlock
   too. V35 passes for the session. The live webhook delivery succeeded. RevenueCat shows
   `still_pro_v3` active from Stripe. PROD-02 shows one active web right.
3. Refund it in Stripe (4.8) within the seven-day window.
4. V69: V36 passes; `charge.refunded` delivered; RevenueCat entitlement inactive; PROD-02 shows the
   right revoked; extras off on every surface; free blocking still works.

V70: only after V61 to V69 pass does the owner announce. If either path fails, switch sales off (2.6
Undo) and fix before announcing.

**8.5 48-hour monitoring** · Engineering, Owner

| # | Signal | Where | Act when |
|---|---|---|---|
| V71 | Purchase routes (`verify-apple-access`, `link-apple-access`, `reconcile-entitlement`, web checkout, Stripe webhook): errors and 5xx | Supabase dashboard, Edge Functions, Logs | Repeated 5xx or `unavailable` |
| V72 | RevenueCat webhook deliveries | RevenueCat, Webhooks; `revenuecat-webhook` logs | Any failing streak |
| V73 | Stripe webhook deliveries | Stripe, Webhooks, the live endpoint | Any failure |
| V74 | Sales policy unchanged | V16 re-run | Revision not the approved one |
| V75 | Analytics identity and erasure | `analytics-identify` 5xx; erasure worker ([PostHog runbook](posthog-analytics.md)) | 5xx to released apps; overdue jobs |
| V76 | Store state and reviews | App Store Connect, Chrome dashboard, AMO Developer Hub | Rejection, takedown, reviews saying a free feature is gated |
| V77 | Support inbox and refund requests | The public support address | A repeated complaint |

Stop rule: if anything suggests free blocking or sync is gated, or a payment does not grant Still
Pro, switch sales off first (2.6 Undo), then investigate.

## Phase 9 — Rollback map

| What | Can it be undone? | How | What cannot be undone |
|---|---|---|---|
| Production sales on | Yes, in minutes | Publish `salesEnabled: false` (2.6) | Purchases already made stay valid |
| Paid cutoff | No | — | The write-once cutoff stays forever |
| Compiled paid flag in a published build | Only by a new version | Ship a higher version; meanwhile sales off | Installed copies keep the flag |
| Migrations | Fix forward only | Reviewed migration through the protected workflow | No automatic down-migration |
| Function deploys | Yes | Redeploy the previous commit through the same operation | — |
| Function secrets | Yes | Rotate through the protected run, provider first | A leaked value stays exposed until rotated |
| Analytics switch | Yes | `analytics-subjects-switch` `disable` | Events already sent remain until erased |
| RevenueCat products, entitlement, offering | Yes while nothing has sold | Detach, or delete the new items | `still_sync`, and any product with purchases |
| Stripe price, webhook, keys | Partly | Archive the price, disable the endpoint, roll keys | A charged customer can only be refunded |
| Submitted IAP | No, once approved | Remove from sale | It cannot be deleted, and its product id cannot be reused |
| Apple version | Before review only | Remove from review; after release, pause phased release and ship a new build | A released version cannot be withdrawn to the old one |
| Chrome listing | Before approval only | Cancel review; afterwards ship a higher version | A published version reached users |
| AMO version | Partly | Disable the version; ship a higher one | Users who updated keep it until the next update |
| Website pages | Yes | Revert the `gh-pages` commit | Cached copies and search snippets |

## Related references

[Apple](01-apple-app-store.md) · [Chrome](02-chrome-web-store.md) ·
[Chrome release workflow](chrome-publish-workflow.md) · [Firefox AMO](03-firefox-amo.md) ·
[RevenueCat](04-revenuecat.md) · [Account and reviewer reference](extension-purchase-deploy-checklist.md) ·
[Versioning and packages](versioning-and-packages.md) · [Analytics switch-on](analytics-subjects-switch-on.md) ·
[Read-only database checks](qa-readonly-database-checks.md) · [Listing copy](store-listing-copy.md) ·
[V3 release record](history/v3/README.md) · [ADR 0003](../adr/0003-entitlement-authority-receipt-and-server.md) ·
[ADR 0004](../adr/0004-first-party-usage-analytics.md) · [ADR 0005](../adr/0005-apple-still-pro-purchase-starts-with-sign-in.md) ·
[Product behaviour](../PRODUCT.md)
