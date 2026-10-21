---
title: "V3 production activation and verification"
date: 2026-10-21
status: active
owner: "Codex production session; owner performs provider account actions and protected approvals"
---

# V3 production activation and verification

## Outcome and ownership

Prepare the production database, backend, Apple and web payments, and product analytics for a
coordinated V3 release on Chrome desktop, Firefox desktop, and Safari on iPhone/iPad and Mac.
The owner confirmed on 21 October that this session owns production backend/payment code as well
as activation and verification. The other session owns the app build and final screen/visual edits.

The owner's exhaustive functional QA remains credited. This work checks production configuration,
deployments, payment delivery and analytics delivery. Repeat functional checks only when a
production-specific code change creates a concrete regression risk. Physical iPad keeps its accepted
unverified exception. Firefox on Android remains deferred.

Use the [V3 go-live runbook and release enablement plan in PR #515](https://github.com/ZackC-1/still-app/pull/515)
as the release procedure. This document records the production session's sequence and evidence;
it does not replace the runbook. Preserve free blocking and free sync throughout.

## Initial evidence, checked 21 October 2026

| Area | Evidence | Conclusion and limit |
|---|---|---|
| Hosted migrations | [Fresh DB-01 run](https://github.com/ZackC-1/still-app/actions/runs/39675242930), privately decrypted report lists 0024, 0023, 0022 as newest migrations | The runbook's 0021 snapshot is stale. Do not replay 0022–0024 as missing. DB-01's `needs-review` verdict requires interpretation; it is not a production readiness pass. |
| Migration verification | [0024 apply](https://github.com/ZackC-1/still-app/actions/runs/39042434395) records 24 history entries, clean invariant and unchanged row counts | Historical deployment proof; not proof of every route's current source. |
| Analytics prerequisites | [Secrets apply](https://github.com/ZackC-1/still-app/actions/runs/38102144609) and [functions apply](https://github.com/ZackC-1/still-app/actions/runs/38114230394) succeeded | These two stages have run. No erasure-schedule or subjects-switch run was found in the retrieved deployment history. Treat current activation as unverified until the protected gates inspect it. |
| PostHog production | Read-only project inspection: IP discard on; autocapture off; session recording off. Recent aggregate query found released 2.x product events | Production ingestion exists. This does not certify V3 configuration, V3 signed-in identities, Firefox delivery, or account erasure. No customer identifiers were queried. |
| Analytics exclusions | Existing internal-user cohort and project filter inspected | Need explicit verification that V3 QA markings and build channels are excluded in the actual launch dashboards. Do not change the filter based only on its name. |
| Payment and store configuration | Not inspected live in this session | Apple product approval, live Stripe eligibility, RevenueCat mapping, production webhook delivery and real customer fulfilment remain unverified. |

Private database reports remain outside Git. Record only pass/fail, source versions and run links
here; never store keys, customer identities, payment references, raw logs or production metrics.

## Existing engineering dependencies

Reuse these in-flight changes; do not edit their worktrees or duplicate their implementations.
Their presence as PRs does not mean they are merged, deployed or configured.

| Dependency | PR |
|---|---|
| Explicit paid setting for store packaging | [#517](https://github.com/ZackC-1/still-app/pull/517) |
| Production sales/cutoff read-only check, migration 0025 | [#518](https://github.com/ZackC-1/still-app/pull/518) |
| Production purchase deployment and secrets operations | [#519](https://github.com/ZackC-1/still-app/pull/519) |
| Production public verification keys in store builds | [#520](https://github.com/ZackC-1/still-app/pull/520) |

Before claiming the remaining release-enablement units, reconcile their latest branch/PR state.
Remaining areas in the plan include production Stripe checkout/completion/webhooks and ledger,
App Review sandbox handling, production sales activation, production purchase verification,
entitlement documentation, and final release configuration. Record accepted decisions from the
owner; an earlier session's assumption that defaults were accepted is not approval of an
irreversible cutoff or provider agreement.

## Guided execution order

Each stage supplies the owner the exact page/run, one action at a time, its expected result and
its recovery step. Provider configuration and code must agree before sales are activated.

1. **Confirm the live payment route.** Check Managed Payments in the real Stripe business account,
   outside the QA sandbox. The tested Managed Payments route is the proposed production path.
   Owner chose this path explicitly on 21 October: production must match the working sandbox
   architecture (D3 option B). Do not substitute RevenueCat Web Billing or ordinary Stripe
   Checkout. After the guided setup, the owner screenshot shows Ready to use; Stripe says Active follows
   the first Managed Payments transaction. Per-session enablement remains required.
2. **Inventory Apple and RevenueCat.** Read Apple agreements/product status and RevenueCat's
   production apps, products, entitlement, offering and webhook. Compare `still_pro_v3` mappings
   with the release code; preserve historical `still_sync` purchases. Generate any mapping JSON
   privately from actual provider identifiers rather than asking the owner to assemble it.
3. **Finish production engineering.** Integrate the reviewed dependencies above, complete the
   remaining production-specific payment/Apple-review/sales work, and run proportional unit,
   integration and deployment rehearsals. Keep new sales off. Record changes that require a
   focused regression check in the final package.
4. **Prepare and deploy the backend.** On a pinned reviewed commit, inventory current secrets by
   name and verify migration history. Apply only missing migrations through the protected path.
   Stage production secrets privately, deploy the fixed route sets, verify uploaded source and
   check free-sync compatibility. Never replace production with a sandbox database, migrate test
   purchases into production, or copy QA secrets into live configuration.
5. **Activate production analytics.** Reconcile the two completed stages with the selected source;
   deploy any needed updates. Enable the erasure worker, wait for an actual successful run, prove
   its PostHog project/deletion permissions, then enable signed-in device identities through
   [the protected analytics procedure](../release/analytics-subjects-switch-on.md).
6. **Bind final production packages.** Give the build session the frozen backend contract, public
   trust keys and production build configuration. Check final package hashes, production routes,
   real PostHog project, release channel, product IDs and compiled paid flags. Public keys may
   ship; private keys must not. A sandbox package is not converted by changing a dashboard switch.
7. **Verify production customer delivery.** Use the compact evidence matrix below. Keep sandbox
   transaction/retry/refund tests credited and repeat only where production code differs. Observe
   genuine production transactions and fulfilment when available; label live transaction proof
   pending until it actually exists. Enable sales only for approved V3 build strings, with the
   concrete policy/cutoff and stop-sales procedure reviewed before the owner's protected approval.
8. **Coordinate release readiness.** Give the build/store session one go/no-go record for every
   supported store and backend dependency. Use available hold/manual-publication controls; verify
   each store's current behavior before submission. Record readiness, submission, approval,
   public availability and customer-delivery proof separately. Store propagation is not atomic.

## Production evidence matrix

| Gate | Required evidence |
|---|---|
| Database | Current history and invariants match the selected commit; no unintended pending migration; production purchase storage and historical rights preserved. |
| Backend | Exact deployed route source; production configuration valid; authenticated account and sync flow works; unauthorized requests refused. |
| Apple | Correct real product, agreements, offering and verification credentials; review sandbox behavior works without contaminating real purchase ownership; genuine purchase/restore delivery observed when available. |
| Web payments | Correct live product/price and Managed Payments activation; authenticated server creates checkout; live-mode checks and webhook signature handling; payment reconciles to exactly the intended account; entitlement delivery observed for a genuine sale. |
| Refund/reversal | Retain sandbox proof for retry, duplicate and refund behavior; monitor genuine production refunds through provider, backend and access removal. Do not manufacture a live charge/refund solely to test. |
| Release analytics | In the production project, observe allowed events from Chrome, Firefox desktop, Apple app iPhone/Mac and Safari extension iPhone/Mac, with the final app version and release channel. Physical iPad remains the declared exception. |
| Signed-in analytics | Production-channel build obtains a device identity; events arrive before and after sign-in under the approved identity model; no customer email in client event payloads. |
| Consent | Sharing off suppresses later product activity; Firefox sends only with its optional permission; Safari follows its host permission. Observe after normal delivery windows, not immediately after a click. |
| Deletion | Disposable designated account/device is used; worker successfully removes the expected person and queues event erasure; follow-up verifies provider completion. Do not equate a queued deletion with completed erasure. |
| Reporting | Actual launch dashboards exclude test builds and designated internal/QA activity; absence of a marker on older releases is not silently treated as proof of release-channel correctness. |
| Paywall conversion | Production dashboard shows offer views, purchase starts, verified purchases, abandonment and purchase outcomes by supported surface, app version and available entry point. Validate actual delivery and deduplication; schema definitions alone are not proof. |
| Monitoring/recovery | Named checks for webhook failures, entitlement failures, sync errors and overdue erasure; stop-sales operation prepared and verified without revoking existing rights. |

## Paywall measurement requirement

The owner explicitly requires visibility into who opens/clicks the paywall and how effectively it
converts. Reuse the approved closed event contract: `locked_switch_tapped`, `paywall_viewed`,
`paywall_dismissed`, `purchase_started`, purchase outcome events and `checkout_returned`. Audit
the producers on each supported surface before treating an event as wired. Distinguish opening
the offer from pressing its purchase action and from completing a verified payment.

Use the canonical server `purchase_recorded` event for verified sale reporting, and
`purchase_refunded` for reversals, with functional idempotency and the approved attribution rules.
Report offer-to-purchase-start and offer-to-verified-sale conversion with explicit denominators,
time windows and identity scope. Trace supported cross-surface handoffs before joining them into
a funnel; do not fabricate missing attribution or count retries/restores as new sales.

Identity follows ADR 0004: signed-out activity is anonymous; permitted signed-in activity can
be associated with the account, but device subjects remain separate PostHog persons. Do not
promise account-deduplicated funnels without implementing and verifying that reporting. Respect
original and current consent, ownership lifecycle and withdrawal for purchase attribution.
Financial fulfilment must succeed independently of optional analytics. Provider totals and
consented analytics totals can differ; display this limitation rather than presenting analytics
as complete financial accounting. No browsing history or unapproved event properties are needed.

## Production database verification requirement

The owner clarified that the existing storage split must be verified: payments and entitlements
in production Supabase, usage/paywall analytics in production PostHog. Verify database evidence
independently of provider dashboard success:

- A verified purchase records the correct provider, product, transaction reference, environment
  and ownership in the intended V3 payment/rights records, with idempotent delivery and retry.
- The app's effective paid access derives from the intended authoritative records; an older
  entitlement projection alone is not sufficient evidence of V3 fulfilment.
- Refund/revocation changes the relevant right while preserving legitimate other rights and the
  necessary audit record. Restores, account links and replayed webhooks do not create new sales.
- Sandbox events cannot create production payment rights or appear as live revenue. App Review
  sandbox support must follow its explicit separate policy rather than silently broadening access.
- Verify user/account relationships, client access restrictions, and deletion/export handling
  through proportional checks without printing production customer data.

Keep the approved ADR 0004 storage model: consented activity events go to PostHog and Supabase
coordinates identity/lifecycle. The owner explicitly confirmed this split; do not add a duplicate
raw-usage event store in Supabase.

The 14:56 PT RevenueCat webhook screen shows an authorization header configured, HMAC disabled,
Both Production and Sandbox, All apps, All events, paywall UI events enabled, and recent Sent
deliveries. Keep settings unchanged pending the backend audit. The inspected local
`revenuecat-webhook` handler claims minimized audit events and refreshes the legacy entitlement
projection from RevenueCat subscriber state; it does not itself reject sandbox environments.
This is local-source evidence, not deployed-source proof. Inspect deployed source and V3
reconciliation before making readiness claims. RevenueCat paywall forwarding does not establish
instrumentation of Still's custom paywall or compliance with its approved usage-data contract.

## Corrections to carry into the shared runbook

- The database is already at 0024, verified by a fresh read-only run. Analytics secrets and the
  three routes were deployed earlier; activation still needs separate evidence.
- Add the per-surface production analytics, consent, identity, erasure and reporting gates above.
- Replace the Stripe owner buy/refund test in step 8.4: Stripe explicitly prohibits testing in
  live mode with real payment details. Use completed sandbox tests, live configuration inspection
  and observation of genuine sales/refunds, or obtain Stripe's written guidance for another
  verification method. [Stripe testing guidance](https://docs.stripe.com/testing).
- Do not require every live checkout total to equal 999: verify the approved price and quantity,
  currency, tax treatment and any configured currency conversion against the resulting charge.
- Chrome supports deferred publication after review; the runbook must not assume automatic
  publication is mandatory. [Chrome publication controls](https://developer.chrome.com/docs/webstore/publish#deferred-publishing-option).

## Current checkpoint

Implementation authorization: the owner authorized autonomous work on the remaining production
backend/payments and analytics tasks. The owner explicitly approved isolated device-only Apple
App Review/TestFlight sandbox access behind a separate server switch (D4), and the four-benefit
`still-free-v2` cutoff (D2): `youtube.shorts`, `instagram.reels`, `facebook.reels`, `tiktok.all`.
Neither decision activates sales or permits sandbox account rights in production.

The first implementation unit extracts the tested Stripe provider transport into a shared,
explicit sandbox/production implementation. QA composition remains fixed to sandbox; production
checks live credentials and live Session/Price/Product/PaymentIntent/Charge objects. Its initial
dispatch uses a separate idempotency namespace; recovery stays GET-only. Red evidence: the new
production test failed on the absent module before implementation. Green evidence: 6 production
transport tests, all 47 unchanged QA transport tests, and all 53 QA checkout-runtime/webhook
regression tests passed locally. No deployment, production purchase ledger or production route
activation is implied by this leaf implementation.

Initial read-only inventory completed. The owner subsequently completed the Stripe portal changes
recorded below; this session has made no production backend writes or customer-record changes.
The DB-01 workflow used the existing `standing-v1` authorization; production write approvals remain
in force. Owner selected Stripe Managed Payments matching the sandbox (D3 option B) and completed its
onboarding. Screenshot at 14:09 PT shows Ready to use; Stripe says Active follows the first
Managed Payments transaction. Managed Payments remains disabled by default and must be enabled
per checkout. At that checkpoint one eligible product existed and no Managed Payments transactions
were recorded.
Email me for approval is the selected refund setting. The owner clarified that the existing
$4.99 Still Pro product is legacy: V3 is a new version of Still Pro with a separate product,
entitlement and pricing. Do not add a V3 price to or repurpose that legacy product. Create a
separate live counterpart to the sandbox V3 product, keeping the customer-facing name Still Pro
and using distinct live provider IDs. Sandbox product and default-price screenshots confirm:
Still Pro; description "Lifetime access to Still Pro’s additional blocking features across
supported surfaces"; Downloadable Software – non-recreational – personal use, tax code
`txcd_10202001`; Managed Payments eligible; active default USD $9.99 one-time flat-rate price.
The other price is archived and must not be copied. The 14:16 PT edit view shows Include tax in
price = Use default (no), with blank price description and lookup key. No other currency options
or metadata appeared in the supplied price detail. The live price must preserve the intended
tax-exclusive behavior; do not assume the live account default matches the sandbox default.
The owner created the separate live V3 product. The 14:22 PT live catalog screenshot confirms
Still Pro at USD $9.99, Active, `txcd_10202001`, and Managed Payments Eligible, alongside the
unchanged separate legacy $4.99 listing. The submitted form showed One-off and Include tax in
price = No. The 14:23 PT product and price detail screenshots confirm the full matching product
category/description and the saved USD $9.99 One-time price, Tax behavior Exclusive, Default price
Yes, no other currencies and no metadata. The screenshots expose the new live identifiers;
validate their exact strings against provider data before applying production configuration.
Stripe catalog creation is complete. Next: inventory the Still RevenueCat project, its V3
entitlement, attached Apple products and offering, then reconcile production configuration.
Catalog creation does not prove checkout wiring or fulfilment.
RevenueCat entitlement screenshots at 14:25–14:26 PT show historical `still_sync` separate from
`still_pro_v3`. At that checkpoint the latter had two associated products: Apple `still_pro_v3` under
Still App (App Store), and the sandbox USD $9.99 one-time Stripe price under Still Payments QA.
The newly created live Stripe price was not yet attached. The Web page showed only RevenueCat Billing
and Still Payments QA. The owner created Still Payments Production; its saved 14:30 PT page shows
the live Still App Stripe account selected and Use Managed Payments checked. Existing providers
were retained. The owner imported the new live USD $9.99 one-time price. The 14:35 PT entitlement
detail verifies its attachment to `still_pro_v3` alongside the existing Apple and QA products.
The offering edit showed a separate production-provider slot in `still_pro_v3` / `$rc_lifetime`.
The owner selected the matching live USD $9.99 price and reported saving, preserving the existing
Apple, QA, Test Store and RevenueCat Billing selections. Saved offering readback remains to be
included in final configuration verification. Purchase tracking inspection shows automatic new
purchase tracking disabled, no Stripe webhook notifications received, paid-invoice recognition,
and rejection of incomplete/delinquent/paused subscriptions. Default currency uses each price's
base currency. Keep automatic import disabled: the verified QA implementation explicitly posts
verified paid Checkout Sessions to RevenueCat `/v1/receipts` with the bound account holder ID.
Its production counterpart and production webhook delivery still require implementation and
verification. The Checkout tab shows promotion codes and automatic tax disabled; its controls
apply to RevenueCat-created sessions, not the chosen backend-created checkout. Production code
must explicitly require and verify Managed Payments rather than infer it from portal toggles.
The Products page reports Missing Metadata for Apple `still_pro_v3`; verify and
resolve its actual App Store Connect status before release.
The 14:42 PT Appearance screen shows customer-facing name Still Pro and no visible warning.
Support email save was not directly verified. Generic appearance previews do not verify real
checkout behavior. Direct App Store Connect inspection at 14:44 PT shows `still_pro_v3` in
Prepare for Submission, with English name/description, all-region availability selected and a US
base price schedule covering 175 countries/regions. The 14:46 PT Current Price dialog confirms
the United States price is USD $9.99, with localized prices elsewhere. Family
Sharing is off. Review Information screenshot is empty; the separate promotional image and
review notes are optional and blank. Tax category matches the parent app, whose category has not
yet been inspected. Record the actual V3 purchase-screen review screenshot as a build/visual
release dependency. No Add for Review action has been taken. Next: verify Current Price and
continue Apple agreement/credential checks; do not assume the screenshot is the only remaining
submission requirement or the confirmed cause of RevenueCat's earlier Missing Metadata label.
US price verification is complete. The 14:46 PT Apple Business overview shows Paid Apps Agreement,
banking, tax form and Digital Services Act status all Active. The banner says the updated Apple
Developer Program License Agreement must be reviewed and accepted by the Account Holder before
updating or submitting apps. The owner subsequently reports accepting the updated terms and
confirming the warning disappeared. This clears that agreement blocker; it does not constitute
approval of the V3 In-App Purchase. The 14:49 PT RevenueCat Apple settings show bundle
`com.chartash.still`, Valid credentials for both the In-App Purchase key and App Store Connect
API key, and No notifications received beside the Apple Server Notification URL. This does not
prove that Apple has no configured URL or that delivery has failed. Next: inspect App Store
Connect production and sandbox notification destinations before using the Apply button, to avoid
overwriting an existing endpoint. The 14:51 PT Apple screenshot confirms both destinations are
unset. After the owner used RevenueCat's Apply in App Store Connect, the 14:52 PT refreshed Apple
page confirms both destinations point to the same RevenueCat endpoint. The 14:53 PT production
Edit dialog exposes only the URL and no version selector. Do not mark Version 2 verified from
this UI; confirm via supported configuration readback or notification payload evidence later.
URL configuration and actual notification delivery remain separate gates. Next: inspect the
RevenueCat-to-production-backend webhook in Integrations.
[RevenueCat setup instructions](https://www.revenuecat.com/docs/platform-resources/server-notifications/apple-server-notifications)
confirm the Apply action sets both environments and recommend V2 for one-time refund detection.
Store only validation/completion status, no credentials,
financial account identifiers or tax documents.
This evidence proves provider configuration/catalog association only,
not Apple approval, valid credentials, webhook identity mapping or production fulfilment.
Live customer fulfilment remains unverified.
No release go/no-go has been issued.

Sources for the guided portal steps: [Stripe Managed Payments setup](https://docs.stripe.com/payments/managed-payments/set-up),
[eligibility](https://docs.stripe.com/payments/managed-payments/eligibility),
[PostHog project analytics runbook](../release/posthog-analytics.md),
[PostHog filtering documentation](https://posthog.com/docs/product-analytics/trends/filters),
and [read-only database checks](../release/qa-readonly-database-checks.md).

## Checkout foundation review, 21 October

A separate production purchase-operation table and five fixed writer RPCs are prepared in migration
0026. Admission requires a confirmed, non-banned account, the current enabled production web
policy, an approved desktop build, and the exact approved four-benefit cutoff. One-way creation
claims retain ambiguous attempts. Known payments remain recoverable after sales stop; account
deletion detaches the holder while retaining the payment record for canonical refunds.

The shared SQL adapter retains fixed sandbox composition and all QA error contracts. Local
verification: 127 targeted Deno tests passed, Deno lint/check passed, and repository lint/typecheck
passed. SQL/PLpgSQL syntax parsed successfully. The [real PostgreSQL rehearsal](https://github.com/ZackC-1/still-app/actions/runs/39686385368)
passed actual role permissions, concurrent claims, stop-sales recovery, deletion and catalog drift.

Review used the ce-code-review lenses sequentially under the repository's main-thread mapping.
The attempted independent Claude review did not run: its acpx transport package failed to resolve
before code egress. No independent corroboration is claimed. Review tightened the index gate to
verify the holder key and exact open-state predicate, and added a wrong-predicate drift probe.

This is a draft foundation unit. Production route composition, Apple device-only review access,
deployment and analytics verification remain open. Reconcile migration 0025 from PR #518 before
production deployment. Rollback disables new callers and keeps the ledger for recovery; do not
drop payment records. No production database or webhook configuration was changed.

## Shared production runtime, 21 October

Checkout request processing, canonical payment recovery and raw-signature Stripe notification
handling now share the tested QA implementation through fixed environment wrappers. Production
configuration requires live credentials, a production signer and the narrow writer role; it
cannot borrow QA secrets. New checkout admission carries the desktop surface/build to the SQL
policy gates. Existing paid attempts remain recoverable after new sales are disabled.

A composition test exposed the previous deliberate sandbox-only Stripe restriction in the
RevenueCat reader. An explicit server-side production binding now supports live purchase and
refund observations without relaxing default QA isolation. The production composition test uses
real adapters, synthetic provider responses and a real signed production access proof; it verifies
that only production RPCs are called and import acknowledgement alone never grants access.
All 96 targeted checkout, webhook and RevenueCat tests passed, including unchanged QA tests.
These tests do not contact production providers or deploy routes.

Owner clarified that production must match tested sandbox functionality and the app's database
contracts. Final verification must cover settings sync, purchase/restore/recovery, refund and
account deletion, with isolated provider environments. Route/client composition and protected
deployment are still pending; do not infer database or deployed parity from these source tests.

## Production app contract, 21 October

The browser client now uses the existing durable managed-operation flow on production create and
completion routes. It sends its compiled desktop surface and manifest build, accepts only a bound
live Stripe checkout URL, retains uncertain operations, and never treats import status as access.
The browser platform lookup completes asynchronously without delaying free settings reads.
Production and QA settings storage/realtime remain selected by their route profiles independently
of payment transport. Paid builds ask the matching environment's fresh sales policy before offering
a new checkout; restore/recovery remains separate from new-sales admission.

Production create/completion and signed Stripe webhook entrypoints are wired in source. Production
reconciliation now binds Stripe mappings to the configured live price while preserving legacy
mapping support. These routes are not deployed and the protected deployment allowlist still needs
its reviewed extension from PR #519. No RevenueCat webhook portal setting was changed.

Verification: Deno lint and all entrypoint checks passed; repository lint/typecheck/build passed.
The broad core/browser runs found only two obsolete sandbox-only source assertions; both were
updated and their suites passed. Other results were 5,700 core tests and 843 browser tests passed,
39 core tests skipped. Targeted production transport, settings, recovery and policy checks passed,
including a later 24-test checkout rerun. The fixture suite passed: 367 passed, 37 skipped (7.8 minutes).

## Protected purchase deployment extension, 21 October

Integrated PR #519's existing protected operations into this branch, preserving its commits.
The closed production function set now includes completion and the raw-signed Stripe webhook.
Staging accepts the live Stripe/RevenueCat/return bindings, rejects test/public keys and unsafe
return locations, and requires the complete configuration inventory before the first route upload.
The unused Web Billing URL is no longer staged; existing hosted secrets remain preserved.
Secrets now precede function deployment in the executable rehearsal and runbook.

Verification: 42 deployment/bundle/workflow tests passed, 2 unrelated QA bundle integration tests
skipped. This includes compilation, sealing and isolated startup of all ten purchase/sync handlers
with no credentials or network access. These are local rehearsals, not production deployment.

## Apple review implementation boundary

D4 requires a distinct signed native binding that records sandbox transaction provenance while the
issuer remains the production backend. Retain the ordinary production local-proof trust boundary;
never reinterpret a sandbox receipt as a live purchase. The review verifier uses Apple's sandbox
verification/API explicitly, and a separate private review ledger holds only device-local rights.
It has no account holder/link/transfer or revenue records and cannot enter account reconciliation.
A server switch defaults Off. Link requests never invoke the review fallback.

Native installation must independently match the current StoreKit sandbox transaction, refuse an
account proof alongside a review binding, and hide the link-to-account affordance. Existing binding
schema 1 remains unchanged; review binding schema 2 uses a separate signing domain. Final analytics
verification must exclude this review path from production purchase conversion/revenue reporting.
Implemented in source: versioned binding/signing purpose, native sandbox match and no-account
installation/link eligibility, isolated migration 0027 and writer adapter, default-off runtime
composition, protected optional switch staging, and disposable SQL rehearsal. Verification:
510 StillKit tests passed; 358 shared-backend Deno tests/115 steps passed (1 ignored); 17 protected
purchase-operation tests passed; changed Deno sources lint and entry points typecheck.
The new PostgreSQL rehearsal, production deployment, review-build device journey and analytics
exclusion remain pending. D4 is not enabled in production.

Analytics audit checkpoint: approved event names exist for paywall views and purchase stages, but
literal producer searches in current core/webview/native sources found schema/validation references
only. Treat funnel instrumentation and delivery as unverified; do not infer them from event schemas.
