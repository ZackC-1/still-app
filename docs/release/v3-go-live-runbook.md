# Still V3 go-live runbook

One ordered checklist from "release candidate built" to "live in the App Store, Chrome Web Store and
Firefox Add-ons, with real payments". Written 21 October 2026. Facts marked "verified" were checked
on 21 October 2026; everything else says how to confirm it. Check each portal live before acting: a
dated line here is not a claim of current state.

The original engineering scope and decisions are in the [V3 release enablement plan](../plans/2026-10-21-001-v3-release-enablement.md).
Use the [production activation plan](../plans/2026-10-21-002-production-activation-and-verification.md)
and [operational handoff](../handoffs/2026-10-21-production-payment-activation.md) for current evidence.
A merged implementation is not a hosted deployment or a completed customer purchase. Final screen
edits and images remain with the owner and Claude Code; final artifact checks follow those edits.
The requested obsolete-code/test audit follows backend and visual completion.

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

Product truths that hold at every step: free blocking never requires an account or purchase;
optional sign-in enables free settings sync; Still Pro never gates the free outcome; host access stays the four supported
services; copy says "every supported surface", never "everywhere"; no release copy promises Firefox
on Android.

## Values that must match across systems

A mismatch in any row breaks purchases or unlocks. Check them all again in V50 to V55.

| Value | App Store Connect | RevenueCat | Stripe | Server and apps |
|---|---|---|---|---|
| Product id `still_pro_v3` | In-app purchase Product ID | Product identifier in each Apple app | Separate live V3 price; lookup key optional | `ApplePurchaseCatalog` (Apple), `ACCESS_APPLE_PRODUCTS_JSON`, `ACCESS_PROVIDER_PRODUCTS_JSON` |
| Entitlement `still_pro_v3` (see G9) | — | Entitlement identifier the new products attach to | — | `entitlement_lookup_key` in `ACCESS_PROVIDER_PRODUCTS_JSON`; `entitlementID` in `ApplePurchaseCatalog` |
| Historical entitlement and product `still_sync` | Removed from sale; never edited | Entitlement and its old products left exactly as they are | — | Historical mapping; never renamed |
| Offering `still_pro_v3`, package `$rc_lifetime` | — | Offering identifier and its Lifetime package | — | `ApplePurchaseCatalog` (`offeringID`, `packageID`) |
| Stripe price id (`price_...`) | — | Store identifier of the Stripe product in RevenueCat | The price created in 4.3 | Stripe `store_identifier` in `ACCESS_PROVIDER_PRODUCTS_JSON` and the price-id secret G4 names |
| Price $9.99 USD | Base price, United States | Shown from the store | Unit amount 999, currency USD, one-time | What the apps show before purchase and the checkout shows |
| Bundle id `com.chartash.still` | The app | App Store app bundle id | — | `bundleId` in `ACCESS_APPLE_PRODUCTS_JSON` |
| Sales offer `still-pro-v3` (hyphen) | — | — | — | Production sales body `channels.*.offer`; granted package |
| RevenueCat webhook | — | Destination `/functions/v1/revenuecat-webhook` on the production project; Authorization equals `REVENUECAT_WEBHOOK_TOKEN` exactly, no `Bearer ` | — | `revenuecat-webhook` route and secret |
| Stripe webhook | — | — | Destination `/functions/v1/stripe-webhook`; the five events in 4.4 | That route and its signing-secret name |

## Release dependencies (check source and hosted evidence separately)

These rows supersede the original gap inventory. PR #522 supplies the backend foundation; the
linked operational handoff records deployments and later fixes. Keep the identifiers G1–G10 for
cross-references, but do not repeat completed provider setup or treat an open PR as deployed.

| Gap | Current requirement | Blocks | State |
|---|---|---|---|
| G1. Production sales operation | Closed `production-sales-policy` on/off operations merged in #522. Final build admission, compare-and-set revision and owner approval remain required. | 2.6 | Engineering, Owner approval |
| G2. Free cutoff | Owner approved `still-free-v2`: YouTube Shorts, Instagram Reels, Facebook Reels, TikTok website. #522 pins those four identifiers; first approved activation writes the immutable cutoff. | 2.6 | Owner approval |
| G3. Production deployment | #522 integrates #519: `purchase-secrets`, fixed nine `purchase-functions`, and separate `purchase-functions-sync-settings`. Follow the [closed operation runbook](purchase-routes-and-secrets.md). | 2.3, 2.4 | Owner approval |
| G4. Production Managed Payments | Owner selected the tested QA architecture with separate live configuration. #522 adds production ledger 0026, checkout/completion, Stripe webhook and canonical RevenueCat refresh. Hosted deployment and genuine fulfilment proof remain separate. | 4.4, 8.4 | Engineering, Owner approval |
| G5. Public build trust | Final integration #528 preserves #524/#520 native public Supabase configuration and trust. Check final integration CI; pin public trust only after hosted signer verification. Signed final artifacts remain pending. | 1.5, 1.6 | Engineering |
| G6. Declared paid build | #528 preserves #517 declaration/compiled-flag consistency guard. Verify the merged final tree before packaging; do not bypass the guard through manual upload. | 6.4 | Engineering |
| G7. Modern sync build | Configured V3 builds require `VITE_MODERN_SETTINGS_SYNC_ENABLED=true`. The one-way shipped marker and final production package configuration belong in the release build change. | 1.3 | Owner, Engineering |
| G8. Apple review access | #522 adds isolated device-only sandbox review access, migration 0027 and a separate default-off switch. It grants no production account rights or revenue. Final native review flow and sales admission must both be verified. | 5.9 | Engineering, Owner approval |
| G9. V3 entitlement | Owner/provider read-back confirms `still_pro_v3`; retain historical `still_sync` mappings. No rename or replacement of legacy products. | 3.4 | Done |
| G10. Production evidence | #522 integrates PROD-01 sales/cutoff summary via 0025. PROD-02 remains a proposed closed purchase check, not an executable existing check. Do not substitute arbitrary production SQL; retain protected deployment/provider evidence and label missing fulfilment evidence. | V17, V66–V69 | Engineering |

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

**1.1 Declare the paid release and flip both flags together** · Engineering
- Where: one PR setting `PAID_TIER_ENABLED = true` in `packages/shared-types/src/entitlement.ts` and
  `paidTierEnabled = true` in `apps/apple/StillKit/Sources/StillKit/MonetizationConfig.swift`,
  `paidTier: true` in `version.json`, and updating the tests that pin the shipped value (`MonetizationConfigTests` enforces that the two
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

**1.5 Chrome and Firefox packages** · Engineering
- Where: a local build from the frozen commit (1.4), with public values by name only and never a
  secret:
  `node scripts/release/package.mjs --out <dir> --env VITE_SUPABASE_URL=<value> --env VITE_SUPABASE_ANON_KEY=<value> --env VITE_POSTHOG_KEY=<value> --env VITE_POSTHOG_HOST=<value> --env VITE_MODERN_SETTINGS_SYNC_ENABLED=true --server-secrets-json <path to the server digests file>`.
  These five `--env` names are the script's whole public list (`PUBLIC_ENV_KEYS`). Access trust comes
  from the committed `scripts/release/production-access-keys.json`, never an `--env` value.
  `--server-secrets-json` (the digest-only output of `supabase secrets list -o json`) is required
  because 3.0 declares the paid tier: the build refuses unless the server's public key, key id and
  environment match a pinned row. The script also refuses a `PAID_TIER_ENABLED` that does not match
  `version.json`. Never pass `--allow-dirty` for a store package.
- Record on the RC card: the build receipt (the frozen commit SHA, the `--env` names passed and the
  written `SHA256SUMS.json`) and the Chrome zip's sha256. Install and test that exact zip.
- For 3.0, `release-chrome.yml` is not used; moving the Chrome build and upload to the workflow is a
  post-launch follow-up.
- V07: `SHA256SUMS.json` written; Firefox `manifest.json` has no `gecko_android`; both manifests list
  only the documented permissions and the four supported hosts, no `<all_urls>`; the exact zips
  installed and smoke-tested (free blocking signed out, sign-in, Get Still Pro shown).
- Undo: discard and rebuild; nothing has reached a store.

**1.6 Apple archives** · Engineering
- Where: `apps/apple/scripts/archive.sh` for iOS and `xcodebuild archive` for the macOS scheme
  ([Apple build helpers](../../apps/apple/scripts/README.md)).
- V08: marketing version and build match `version.json`; nested bundle ids, App Group and entitlements correct; web resources from the frozen commit; release env guard passed. Inspect the signed app and extension plists and web resources in both archives for the exact production public Supabase binding, access-trust key IDs/environment and privacy manifests. Match the committed public trust artifact to hosted signer evidence before packaging; see [production access trust](versioning-and-packages.md#production-access-trust-still-pro-verification-keys). Unsigned Debug compilation is not archive/device proof.

**1.7 Upload Apple builds** · Owner approval
- Where: `UPLOAD=1` on `archive.sh`, or Xcode, Window, Organizer, Archives, the archive, Distribute
  App, App Store Connect, Upload.
- V09: App Store Connect, Apps, Still, TestFlight shows each build as "Ready to Submit" (processed).
  Install from TestFlight on iPhone and Mac for free blocking, sign-in and sales-off refusal checks.
  The positive sandbox purchase follows 2.6 sales admission plus the verified separate review switch;
  review-proof issuance alone does not open the purchase flow.
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

**2.1 Inventory production** · Engineering (standing read-only authorization)
- Where: `gh workflow run supabase-readonly-checks.yml --ref main -f check=DB-01 -f account=none -f account_b=none`
  ([read-only checks](qa-readonly-database-checks.md)), plus the dashboard read above.
- V10: DB-01 reports the hosted migration tail. Fresh run `39704032899` on 21 October found 0024;
  verify again before deployment rather than replaying 0022–0024.
- V11: the owner lists, from Edge Functions, which production routes predate the 7 to 20 October
  merges (scoped purchase ownership #353/#354, sandbox ledger boundary #362, payment records kept on
  deletion #395, sandbox sync fixes #440/#441, Apple OCSP verification, the QA reconcile/link
  "unavailable" answers). Compare exact deployed source with the selected commit; do not infer deployment from merge status.

**2.2 Apply pending migrations** · Owner approval
- Where: `operation=migrations`, `migrations=<exact comma-separated names from V10's gap>` (
  the verified 0024 baseline requires 0025–0027), `policy_mode=none`, `commit=<sha>`. If PR528 is merged before route deployment, keep the already-planned foundation apply unchanged, then apply 0028/0029 under a separate exact plan at the final merged SHA before secrets/functions. Route gates require every migration at their pinned SHA; there is no need to deploy intermediate route versions twice.
- V12: closing record passes; DB-01 re-run shows the new tail.
- Undo: fix forward with a reviewed migration.

**2.3 Deploy production paid routes** · Owner approval
- Run 2.4 first. Then use `operation=purchase-functions` from the frozen commit. Deploy
  `purchase-functions-sync-settings` separately with its own approval. Each operation verifies
  all migrations at its pinned commit and exact uploaded bundle bytes. See [route gates](purchase-routes-and-secrets.md).
- V13: each route reads back at the planned source; the dashboard shows the new versions.
- Undo: redeploy the previous reviewed commit through the same operation.

**2.4 Production function secrets** · Owner approval
- Run before 2.3 using `operation=purchase-secrets`. The [secret-name table and gates](purchase-routes-and-secrets.md)
  are authoritative. Stage values privately; `apply` installs absent names and refuses conflicts;
  `rotate` is a separately reviewed replacement, never a blind retry after a partial result.
- Preserve the existing RevenueCat webhook URL, authorization and filters. The authorized server
  handler update does not change those portal settings.
- Database writer URLs must match actual role passwords and are not copied from QA or staged as
  arbitrary purchase secrets. Existing legacy configuration remains intact.
- V14: inspect names and the closing receipt, then verify runtime configuration without printing secrets.
- Undo: reviewed rotation; leaked credentials are rotated at their provider first.

**2.5 Signed-in analytics switch-on** · Owner approval
- Where: the four steps in [analytics subjects switch-on](analytics-subjects-switch-on.md). Step 4
  waits until the V3 builds send `projectKeySha256`.
- V15: each closing record passes; a production-channel build gets an identity; a deleted test
  account's person is removed after the next worker run.
- Undo: `operation=analytics-subjects-switch policy_mode=disable mode=apply`.

**2.6 Paid cutoff and production sales on** · Owner, Owner approval
- Order: after Phases 3 and 4, final package verification and the cross-system check (V50 to V55), after existing QA purchase tests are finished, and before Apple submission. The operation still refuses production apply until a reviewed release change removes its provisional final-version hold. Check actual packaged strings first. Positive production-bound TestFlight/review purchase proof follows this admission plus the separate review switch while store publication remains held; it cannot be required before admission.
- Where: `operation=production-sales-policy policy_mode=on` with the verified current
  `policy_expected_revision` and reviewed exact build strings; [procedure](production-sales-policy.md). Body: `salesEnabled: true`; channels `apple` and `web`
  enabled with offer `still-pro-v3`; approved builds only the 3.0 builds (plan D9). The first
  activation writes the one write-once cutoff with the content the owner chose (G2, plan D2).
- V16: engineering posts `{"namespace":"sales","environment":"production"}` to the public
  `product-policy` route (public anon key only; no secret) and reads the new revision, `salesEnabled`
  true, both offers `still-pro-v3`, and only 3.0 builds listed.
- V17 (needs G10's PROD-01): the production cutoff is present with the approved product id.
- V18: DB-35 reports "production unchanged since baseline: no", as expected after this step.
- V19: a released 2.1 app still shows no Still Pro.
- Undo: protected `production-sales-policy policy_mode=off` with the current revision. New
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

3.2 **Verify the existing Apple product.** Inspect the existing product first. Only if absent: **Product catalog**, **Products** tab, **+ New product**. App: the App
Store app. Identifier: `still_pro_v3` (must match App Store Connect). Type: Non-consumable. Display
name: `Still Pro`. **Save**. State: Owner.

3.3 **Verify the imported web product.** The owner already imported the production price. Confirm its exact live mapping; do not create a duplicate. Only if absent, after G4 and 4.3:
**Apps & providers**, confirm the Stripe app is connected to the live Stripe account; then
**Products**, **+ New product**, App: the Stripe app, Identifier: the live Stripe price id from 4.3
(must match Stripe), Type: Non-consumable, Display name `Still Pro`, **Save**. State: Owner.

3.4 **Verify the entitlement and attachments.** The owner already attached the production product to `still_pro_v3`. Inspect it first. Only if absent: **Product catalog**, **Entitlements** tab, **+ New entitlement**. Identifier: `still_pro_v3`. Description: `Still Pro`. **Save**. Open it, **Attach**,
tick the App Store `still_pro_v3` (and Mac, if listed) and the Stripe product, **Attach**. Do not open
or change `still_sync`. State: Owner.

3.5 **Verify the offering.** The owner already saved the production product in the Lifetime package. Inspect it first. Only if absent: **Product catalog**, **Offerings** tab, **+ New offering**. Identifier:
`still_pro_v3`. Display name: `Still Pro`. **Save**. Open it, **+ New package**, Identifier
**Lifetime** (`$rc_lifetime`), Description `Still Pro lifetime`, attach the same products as 3.4,
**Save**. The current offering was already selected by the owner; preserve that setting and verify explicit app lookup by identifier. State: Owner.

3.6 **Check the webhook.** **Integrations**, **Webhooks**, the existing production configuration.
URL ends `/functions/v1/revenuecat-webhook` on the production project; **Authorization header value**
is set (the exact `REVENUECAT_WEBHOOK_TOKEN`, no `Bearer `). Preserve the existing environment
**Both Production and Sandbox**, **All apps**, **All events**, authorization and URL. The server
handler enforces environment isolation. Read back settings without changing them. A Sent/2xx
delivery alone does not establish a persisted purchase or entitlement. State: Engineering, Owner (confirm).

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
| V22 | `GET /v2/projects/{project_id}/products` | `still_pro_v3` on each Apple app, one-time non-consumable; the Stripe product's store identifier equals the Stripe price id (V31). Preserve historical web SKU `still_sync_web` mapped to entitlement `still_sync`; product and entitlement identifiers can differ. Validate the complete mapping against the selected source before staging |
| V23 | `GET /v2/projects/{project_id}/entitlements` | `still_pro_v3` exists; `still_sync` still exists |
| V24 | `GET /v2/projects/{project_id}/entitlements/{still_pro_v3 id}/products` | New Apple product and live Stripe product attached; preserve the separate QA mapping and existing products |
| V25 | `GET /v2/projects/{project_id}/entitlements/{still_sync id}/products` | The same historical products as before; nothing new |
| V26 | `GET /v2/projects/{project_id}/offerings` then `/offerings/{id}/packages` with products expanded | Offering `still_pro_v3`, package `$rc_lifetime`, the new products |
| V27 | The v2 webhook-integration read if the key can reach it; otherwise the owner reads 3.6 on screen and engineering reads `revenuecat-webhook` logs | Production URL with the preserved Both Production and Sandbox / All apps / All events filters; recent delivery status, with canonical persistence verified separately |
| V28 | Owner confirms 3.7 and 3.8 on screen | Values recorded |
| V29 | Engineering compares V22 and V24 with `revenuecat-access.ts` | Every mapping it would build passes that file's validation |
| V30 | Engineering builds `ACCESS_PROVIDER_PRODUCTS_JSON` from V21 and V22 (kept private) | Handed to 2.4 |

Undo: detach a product or delete the new offering or entitlement while nothing has sold. Never delete
or rename `still_sync`, and never delete a product that has purchases.

## Phase 4 — Stripe live

The owner has prepared the separate live product, provider connection and restricted key; the new webhook exists disabled. Verify the current state before making changes. Owner account/terms decisions happen in the Stripe Dashboard with **Test mode off**; authorized engineering can perform available read-backs and endpoint operations. Live keys reach production only through the protected secrets run (2.4).

**Owner, click by click:**

4.1 **Activate the account.** **Settings**, **Business**: complete business details; **Settings**,
**Payouts**: add the bank account. It should look like: no "Activate payments" banner on Home;
payouts enabled.

4.2 **Turn on Managed Payments.** **Settings**, **Managed Payments** (or **Payments**, **Managed
Payments**), **Get started**, accept the terms, choose the digital software category. It should look
like: Managed Payments is ready for use; the owner observed that Active follows the first transaction. If the product or country is ineligible, stop: G4 changes.

4.3 **Verify the separate V3 product and price.** The owner already created it; inspect it before creating anything. If absent, use **Product catalog**, **+ Add product**. Name: `Still Pro`.
Description: owner-approved one line. Pricing: **One-off**, `9.99`, `USD`. Open **More pricing
options** only if needed; a lookup key is optional and does not have to equal the Apple product identifier. Tax: as
Managed Payments requires for digital software. **Add product**. Copy the price id (`price_...`) for
3.3 and 2.4, privately.

4.4 **Verify the separate live webhook.** A disabled endpoint has already been created and its signing secret saved privately. Reuse it; enable only after the hosted handler and signature configuration are verified. If absent, **Developers**, **Webhooks**, **+ Add endpoint** (or
**Add destination**). Endpoint URL: `https://<production project>.supabase.co/functions/v1/stripe-webhook`
(the project is the one in the `SUPABASE_PRODUCTION_PROJECT_REF` repository variable). API version:
the one G4 pins. Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded` (the QA
route's set; adjust only if G4 changes it). **Add endpoint**, then **Reveal** the signing secret and
hand it to the 2.4 run. Do not send a test event to production.

4.5 **Verify the existing server key.** A live restricted key is already saved privately. Create a replacement only if needed: **Developers**, **API keys**, **Create restricted
key**, with only the permissions G4 lists. Hand it to the 2.4 run privately.

4.6 **Verify RevenueCat connection.** The production Stripe app is already linked and its product attached to the V3 entitlement/offering. If absent, Install the RevenueCat app from the Stripe App
Marketplace on the live account and link it to the production RevenueCat project, as G4 requires.
It should look like: RevenueCat, Apps & providers, the Stripe app shows the live account connected.

4.7 **Read-back permissions.** Reuse an existing approved restricted key with sufficient read permissions. If a separate key is needed: **Developers**, **API keys**, **Create restricted key**. Name:
`Still read-only verification`. **Read** on Products, Prices, Checkout Sessions, Charges, Refunds and
Webhook Endpoints; **None** on everything else. Hand it to engineering privately.

4.8 **Refund procedure.** **Payments**, open the payment, **Refund**, full amount, reason "Requested
by customer", **Refund**. Under Managed Payments, confirm on screen whether refunds run through
Stripe's managed flow. Write the result into the support page (7.3).

**It should look like:** live mode active with payouts; Managed Payments ready; a distinct V3
product with its active one-off USD 9.99 tax-exclusive price, alongside the preserved legacy product.
The separate webhook stays disabled during staging and is enabled only after hosted verification.

**Read-back** (engineering, with the 4.7 key, `Stripe-Version` set to G4's pinned version):

| # | Request | Expect |
|---|---|---|
| V31 | `GET /v1/prices/{configured_price_id}?expand[]=product` | One active price: `unit_amount` 999, `currency` usd, `type` one_time; product name "Still Pro", active; `livemode` true |
| V32 | `GET /v1/products?active=true` | The configured V3 product is active and distinct from the preserved legacy product; identical display names are valid |
| V33 | `GET /v1/webhook_endpoints` | One enabled endpoint at the production route path, `enabled_events` exactly the five, `livemode` true |
| V34 | Owner reads Managed Payments status on screen | Ready to use before the first genuine transaction; record actual status |
| V35 | After a genuine purchase: `GET /v1/checkout/sessions/{id}` | `livemode` true, `managed_payments.enabled` true, configured USD999 base price and quantity, tax/currency treatment reconciled to actual total, `payment_status` paid |
| V36 | After a genuine full refund: `GET /v1/refunds?charge={charge}` | One full refund, `status` succeeded |

Undo: archive the price (an amount cannot be edited; create a new price), disable the endpoint, roll
or delete keys. A charged customer can only be refunded.

## Phase 5 — App Store Connect

Owner screenshots on 21 October show `still_pro_v3` with a USD 9.99 base price, English localization and availability configured; its review screenshot was still missing. The owner also accepted the updated agreement and its warning disappeared. RevenueCat’s earlier `MISSING_METADATA` label is not a current App Store Connect inventory. Re-read current IAP state, agreements, uploaded build numbers and version submissions before acting. The old `still_sync` remains removed from sale. The IAP must go to review with the first V3 submission.

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
- c. **App Store Localization**, **+**: English (U.S.); Display Name `Still Pro`; Description (45
  characters at most in App Store Connect, owner-approved; draft in
  [listing copy](store-listing-copy.md#30-still-pro-in-app-purchase)); **Add**.
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
New from the approved [3.0 release listing](store-listing-copy.md#30-release-listing-minimal-update-of-the-21-copy)
(a minimal update of the 2.1 copy; the 2.1 screenshots stay, owner ruling 22 October 2026). State:
Owner (draft written, awaiting owner approval).

5.5 **App Privacy.** Left menu **App Privacy**, **Edit**. Keep the analytics types (ADR 0004). Make
sure **Purchases, Purchase History** covers **App Functionality** for Still Pro and **Analytics**
for the consented canonical purchase events sent to PostHog,
linked to the user: Yes, used for tracking: No. The release brief says Purchase History must be
added; the [V3 App Privacy label](store-listing-copy.md#v3-apple-app-privacy-label) records it as
already declared for historical purchases, so confirm on screen. **Publish**. The label must match
`PrivacyInfo.xcprivacy` and the published privacy policy (7.1).

5.6 **App Review Information** (each version). Sign-in required: Yes; review account only in the
private username and password fields (2.7). Notes: the V3 Still Pro text in the
[Apple runbook](01-apple-app-store.md#review-instructions).

5.7 **Attach the IAP** (each version). Section **In-App Purchases and Subscriptions**, **+** (or
**Select In-App Purchases or Subscriptions**), tick **Still Pro**, **Done**. Undo: remove it before
submission.

5.8 **Release options** (each version). **App Store Version Release**: **Manually release this
version**. **Phased Release for Automatic Updates**: **Release update over 7-day period using
phased release** (ON; owner decision, 22 October 2026). Save.
- Apple's fixed schedule for people with automatic updates: day 1 1%, day 2 2%, day 3 5%, day 4 10%,
  day 5 20%, day 6 50%, day 7 100%. Anyone can still download 3.0 manually from the App Store at any
  time, and new downloads get 3.0 at once; phasing only paces automatic updates. Day 1 starts when the
  owner releases the approved version.
- The owner wants a 4-day rollout: on **day 4**, the owner releases to everyone. App Store Connect,
  **Apps**, **Still**, in the sidebar under **iOS App** the version **3.0** (status "Ready for
  Distribution", marked "Phased Release"), then **Release to All Users** at the top right of the page,
  and confirm. Repeat under **macOS App**, version **3.0**. Until then, **Pause Phased Release** in
  the "Phased Release for Automatic Updates" section stops the rollout if monitoring (Phase 8) finds
  a problem (pauses total at most 30 days).
  ([Apple reference](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/))
- Verify: the version page shows "Ready for Distribution" without "Phased Release" after day 4.
- Undo: before release, switch back to **Release update to all users immediately**.

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
| V50 | Apple product `still_pro_v3` and its RevenueCat mapping agree; the separate live Stripe price ID matches its RevenueCat production mapping and server configuration | V40, V22, V31 |
| V51 | The RevenueCat Stripe product's store identifier equals the live Stripe price id, and the server's price-id secret holds the same value (compared by engineering privately) | V22, V31, 2.4 |
| V52 | Entitlement and offering ids in RevenueCat equal those in `ApplePurchaseCatalog.swift` and `ACCESS_PROVIDER_PRODUCTS_JSON` | V23, V26, V30 |
| V53 | Apple US base 9.99 and Stripe base 999 USD match the offer; displayed total accounts for applicable tax and local currency | V42, V31, TestFlight and the 1.5 package |
| V54 | Production sales body offers `still-pro-v3` on both channels and lists only the 3.0 builds | V16 |
| V55 | Webhook destinations point at production routes, not `qa-sandbox-*` | V27, V33 |

## Phase 6 — Chrome Web Store and Firefox Add-ons

| Step | Chrome Web Store | Firefox Add-ons (AMO) | Who | State |
|---|---|---|---|---|
| 6.1 Listing copy | Minimal update of the 2.1 copy: [3.0 Chrome changes](store-listing-copy.md#30-chrome-web-store-changes) | [3.0 Firefox changes](store-listing-copy.md#30-firefox-add-ons-changes), plus the [manifest declarations](store-listing-copy.md#firefox-manifest-declarations-before-the-amo-upload) that must land in the build first | Engineering drafts, Owner approves | Owner |
| 6.2 Screenshots | No V3 Pro set exists; capture with `screenshots/source/v3` tooling into [store-ready](screenshots/store-ready/README.md) | Same | Engineering, Owner approves | Engineering |
| 6.3 Privacy | Developer Dashboard, Still, **Privacy practices**: data categories match V3 (account, settings, purchase status, analytics); privacy URL | Developer Hub, Still: the data-collection entries match the 3.0 manifest exactly (AMO rejects a mismatch): tick **Authentication information**, **Personally identifying information** and **Financial and payment information** as **required**, and **Technical and interaction data** as **optional**; privacy text in **Edit Product Page** describes the same data ([listing copy](store-listing-copy.md#firefox-manifest-declarations-before-the-amo-upload)) | Owner | Owner (confirm) |
| 6.4 Upload | The locally built zip from 1.5, the one whose sha256 is on the RC card and which was tested. The owner uploads it in the Chrome Web Store Developer Dashboard (Still, **Package**, **Upload new package**), then submits for review with automatic publication unchecked. `release-chrome.yml` is not used for 3.0 | Developer Hub, Still, **Upload New Version**: the Firefox zip, then the source zip and build instructions. Before continuing, confirm the data-collection entries shown for the version match the manifest (required: authentication information, personally identifying information, financial and payment information; optional: technical and interaction data). New installers see the three required types in Firefox's install prompt; existing users are asked to accept the two newly added types (personally identifying, financial and payment) when they update | Owner | Owner |
| 6.5 Compatibility | Desktop only by nature | On the upload's platform step, **untick Firefox for Android**; the build has no `gecko_android` | Owner | Owner |
| 6.6 Reviewer notes | Free blocking signed out; Pro optional; no purchase needed to review; private access only in private fields. The package is a local reproducible build of the frozen commit (the release tests prove two builds are byte-identical), not a workflow build | Same, plus reproducible-source instructions | Owner | Owner |
| 6.7 Publication | Choose deferred publication before submission; approval then waits for the owner to publish | **Continue** after validation can publish before **Submit Version**; have everything ready first ([AMO lesson](../solutions/conventions/amo-continue-can-publish-an-update.md)) | Owner | Owner |

- V56: the Chrome Web Store dashboard shows 3.0 in review, then approved and held; verify publication only after the owner explicitly publishes.
- V57: the AMO version page lists Firefox only, no Android; the public AMO API shows the version once public.
- Undo: Chrome, cancel review in the dashboard, or ship a higher version later. AMO, **Manage
  Status & Versions**, disable the version, or ship a higher one.

## Phase 7 — Website publishes

The site publishes from `gh-pages`, separately from `main`. All publishes are owner actions; undo is
reverting the `gh-pages` commit.

The owner scheduled the technical SEO changes for the V3 website release on October 22, 2026.
Merge their source into `main` first, then reconcile the final setup/support copy with the
SEO navigation, metadata and canonical links before publishing. The setup guide work in PR #484
also edits `docs/setup.html`; retain both its reviewed instructions and the SEO improvements.
Use `pnpm build:website` and `pnpm test:website` to prepare and validate the public tree, including
the directory aliases. See the [SEO audit](../research/2026-10-22-website-seo-audit.md) and
[website publication checklist](../../scripts/website/README.md). Merging the source PR does not
publish `gh-pages` or alter store artifacts.

- **7.1 Privacy policy for Still Pro** · Owner publication checkpoint. PR478 has already merged to `gh-pages`, publishing the older policy; source PR477 remains open. Reconcile that publication with the final reviewed source, including PR528 canonical purchase analytics and V3 no-notice wording. A new reviewed publication is still required; do not overwrite the newer policy with the older source. Publish matching `gh-pages` content before store submission and analytics activation. V58: `https://stillapp.fit/privacy/` matches the approved purchase, analytics and deletion disclosures.
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
3. Use Chrome deferred publication to hold an approved submission; verify the current portal setting
   ([Chrome publication controls](https://developer.chrome.com/docs/webstore/publish#deferred-publishing-option)).
   AMO can publish on Continue, so its submission remains a separate owner-controlled step.
4. Coordinate manual publication after final artifact, backend and analytics gates. Record readiness,
   store approval, public availability and genuine customer delivery as separate facts.

**8.2 Per-surface smoke test (store-installed 3.0 builds)** · Owner

| # | Check | Chrome | Firefox desktop | Mac Safari | iPhone Safari |
|---|---|---|---|---|---|
| V61 | Installed version is 3.0 | | | | |
| V62 | Free blocking signed out (Shorts, Reels, TikTok website) | | | | |
| V63 | Email-code sign-in and settings sync | | | | |
| V64 | Get Still Pro shows $9.99 (or the local equivalent) | | | | |

Physical iPad stays owner-accepted skipped/unverified.

**8.3 Apple purchase and refund evidence** · Engineering, Owner
- Credit completed sandbox purchase, restore, duplicate and refund tests. Verify isolated production-bound
  review/TestFlight access with the final build; sandbox proofs must not become live rights or revenue.
- V65: record final-device purchase/restore behavior and account linking under the approved test scope.
- V66: when a genuine production purchase is available, compare provider entitlement, successful webhook
  and permitted backend evidence. PROD-02 is not implemented yet; do not invent its output.
- V67: observe genuine full refunds/revocations when available, preserve unrelated rights, and verify
  free blocking still works. Label production transaction evidence pending until observed.

**8.4 Stripe purchase and refund evidence** · Engineering, Owner
- Do not create a live charge/refund solely to test: [Stripe prohibits live-mode testing with real
  payment details](https://docs.stripe.com/testing). Use sandbox evidence and live configuration read-back.
- V68: observe a genuine sale when available: V35 reconciles the actual amount, the live webhook
  succeeds, RevenueCat has the expected entitlement, and permitted backend evidence confirms ownership.
- V69: observe a genuine requested full refund when available: V36, webhook, canonical rights and
  access removal agree while free blocking and unrelated valid rights remain intact.
- Provider configuration, synthetic tests and an HTTP success do not prove customer fulfilment.

V70: the owner decides publication/announcement after reviewing readiness and explicitly recorded
pending customer-delivery evidence. Do not mark V66–V69 passed because sales are enabled. Any observed
fulfilment failure triggers the reviewed stop-sales procedure (2.6) and investigation.

**8.4a Final production analytics acceptance** · Engineering, Owner
- Use the final edited production packages on Chrome, Firefox desktop, Apple app iPhone/Mac and
  Safari extension iPhone/Mac. Physical iPad remains explicitly unverified.
- Verify offer view/start/outcome delivery, original-device canonical sale/refund attribution, stable
  deduplication, production project/version/channel and internal/test exclusions.
- Verify consent off, Firefox optional permission, sign-in/out and deletion through actual worker/provider completion. An active subject or queued deletion is not proof of current consent or completed erasure. Record the initial deletion acceptance separately from the existing confirmation at least eight days after the last provider deletion, and follow-up through 35 days; do not compress that elapsed-time evidence into a same-day pass.
- Canonical conversion is a consented subset with documented delivery/retention limits, not a financial
  ledger or an account-deduplicated funnel. Supabase holds payments/entitlements; PostHog holds usage.
- See the [production evidence matrix](../plans/2026-10-21-002-production-activation-and-verification.md#production-evidence-matrix).

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
| Chrome listing | Before publication | Cancel review or retain deferred publication; after publication ship a higher version | A published version reached users |
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
