---
title: "V3 production activation and verification"
date: 2026-10-21
status: active
owner: "Codex production session; owner performs provider account actions and protected approvals"
---

## Latest checkpoint: checkout repair verified, Stripe enabled; final-build activation gates remain

PR522 merged after all 32 checks passed. PR525 corrected the preservation-output contract and
merged after all 30 checks at `bc728bcabad9ef383906571206becd3f46b1377f`. This is the pinned foundation
revision. The failed earlier plan39704528557 performed no hosted write.

[Plan39707517059](https://github.com/ZackC-1/still-app/actions/runs/39707517059) now passes for exactly
0025–0027: disposable history 24→27, clean structural checks, unchanged existing row snapshots.
Matching [apply39707838333](https://github.com/ZackC-1/still-app/actions/runs/39707838333) completed
in production at the pinned foundation revision: history 24→27, all 18 structural checks clean,
all three preservation snapshots unchanged, verified at 02:07 UTC. Post-apply [DB-01 run39709691391](https://github.com/ZackC-1/still-app/actions/runs/39709691391)
completed and its private report confirms migration tail 0027/0026/0025; its expected `needs-review`
verdict is not a failure. No sales activation is included.

[purchase-secrets apply39709986466](https://github.com/ZackC-1/still-app/actions/runs/39709986466)
completed after plan39709662125, verified at 02:16 UTC: 21 installed, two legacy RevenueCat values
kept, three role URLs present/not managed, no issues. [PROD-01 run39710042569](https://github.com/ZackC-1/still-app/actions/runs/39710042569)
confirms no production sales-policy row, expected revision 0, no admitted builds and no cutoff;
enabled/offer fields are null rather than a false-valued policy row.

[sync-settings apply39711029849](https://github.com/ZackC-1/still-app/actions/runs/39711029849)
completed and verified at 02:26 UTC with no issue/recovery; its bundle is identical to final
integration `589341f1`, and an unauthenticated production POST subsequently returned 401. Public trust pin
[PR530](https://github.com/ZackC-1/still-app/pull/530), commit `08a37fc2`, passed all three genuine
hosted-metadata comparisons and independent review, but runtime-signed proof remains unverified.
Privacy [PR529](https://github.com/ZackC-1/still-app/pull/529) was published after the source checks
and merge, at gh-pages `e8a34d815aa7b0a7919bd20365d96e3d201ea4a0`, 03:38:24 UTC October 22
(20:38:24 PDT October 21). Pages built successfully; both live `/privacy.html` and `/privacy/`
returned HTTP 200 with the exact approved source hash recorded below. The October 21 policy date
matches the local publication day. App Privacy portal declarations remain separate.

Web and Apple canonical analytics plus build trust/declaration changes merged through
[PR528](https://github.com/ZackC-1/still-app/pull/528) at
`c24a246da9607a069337d1a80c0b4cc0224f10c5`, 02:54 UTC October 22 (19:54 PT October 21).
Required main, Deno and Playwright checks passed, including all three browser fixture phases.
The optional preview remained unverified after dependency installation timed out twice.
Disposable PostgreSQL CI is separate from production verification; a source merge does not prove deployment. Their source tests do not establish hosted deployment or final-device
delivery. Later 0028/0029 analytics migrations were applied through the separate exact plan recorded below. Use the
[current handoff](../handoffs/2026-10-21-production-payment-activation.md) for source ownership,
verification and remaining gates. Final screen/image edits, signed packages and device acceptance
remain owner-dependent; the requested obsolete-code/test audit follows backend and visual completion.

Owner screenshots now confirm the scoped PostHog key has project read plus person write, and
Supabase exposes only `public`/`graphql_public`, with `net` absent. Hosted provider proof remains
pending. Fresh hosted metadata shows `ANALYTICS_SUBJECTS_ENABLED` absent; no switch was activated.

The owner authorized resuming after the model-switch checkpoint. PR527 merged at
`2bad3028d8b9d8c6fd403c8ae5fd2327534ec4f3`, 03:37:59 UTC October 22 (20:37:59 PDT October 21),
after all three required checks passed and independent final-head review found no blockers. It
preserves main `c24a246d`, PR530 `08a37fc2`, PR515 and PR477 ancestry; GitHub marked all three
component PRs merged. Combined privacy source `55f09c43` remains byte-identical (SHA256
`991671790232ac4cccfdec37a64d2ff21c3910f1b85702a2f9b2d8cf0c9e4154`). This merged main SHA
was the initial rollout pin; repaired main `26bf5a947de9fef70102c9be87f1e69806cbce46` now controls
new operations. Existing deployment receipts above retain their original revisions.

Combined local validation passed: lint, workspace typecheck, all 137 release tooling/package tests,
18 final public-trust tests, 96 local documentation links, privacy HTML nesting and exact approved
source hash, and `git diff --check`. Existing Svelte build warnings remain. Final
[CI39714941729, attempt 2](https://github.com/ZackC-1/still-app/actions/runs/39714941729/attempts/2)
retained green main/Deno results (649 Deno tests, 147 steps, one gated test ignored). The first
browser attempt was canceled before tests after a six-minute pnpm self-installation stall; its
retry passed 367/37 skips, 212/192 conditional skips and 96/one skip across the three phases,
without failed or flaky cases. See the handoff for local log paths.

Exact [migration plan39718015533](https://github.com/ZackC-1/still-app/actions/runs/39718015533)
passed for only 0028/0029 at `2bad3028d8b9d8c6fd403c8ae5fd2327534ec4f3`. Downloaded plan and
disposable replay match digest `264438fba4729a8e962e3ab73d9c37fac92508d5dbacf87287b9152cf033cb9b`:
history 27→29, all 14 checks clean, both preservation snapshots unchanged, no issues or warnings.
Private evidence is under `/tmp/still-rollout-39718015533/`. Matching
[apply39718256847](https://github.com/ZackC-1/still-app/actions/runs/39718256847) completed after
the owner's personal approval. Its actual production receipt was verified at 03:47:24 UTC October 22
(20:47:24 PDT October 21): exact source and digest, production history 27→29, all 14 checks clean,
both preservation snapshots unchanged, no issues or warnings, no recovery needed. The closing
`/tmp/still-rollout-39718015533/production-receipt.json` targets `production`; the earlier log
envelope is disposable replay evidence and does not prove the hosted apply. Fresh
[DB-01 run39718854455](https://github.com/ZackC-1/still-app/actions/runs/39718854455) succeeded;
its private report confirms hosted tail 0029/0028/0027, narrow read-only transaction/rollback proof
and nothing withheld, with the expected `needs-review` catalogue verdict. Private evidence is under
`/tmp/still-db01-39718854455/`; no identity details were output. Exact-revision
[settings/GoTrue rehearsal39717958292](https://github.com/ZackC-1/still-app/actions/runs/39717958292)
passed on the pinned revision using disposable infrastructure; it is not hosted deployment or
final-device acceptance.

The exact nine-route [purchase-functions plan39718857548](https://github.com/ZackC-1/still-app/actions/runs/39718857548)
passed on `2bad3028`, digest `8f7ccf06e1a627a7c73fa85e68ca8ced2d17d59c4a5d81f9ce7902f682b51f9f`.
It pins all nine routes, JWT settings, fixed order and all 29 migration prerequisites; eight rehearsal
proofs passed, including negative cases, source read-back, repeat application and settings-sync
isolation. Evidence is under `/tmp/still-purchase-functions-39718857548/`. Matching
[apply39719229501](https://github.com/ZackC-1/still-app/actions/runs/39719229501) completed
successfully after personal approval: five routes created, four deployed, source/JWT
read-back for all nine, no issues or recovery needed, settings sync untouched. The plans match in
source, bundles, JWT settings and prerequisites; only mode and its bound digest differ. Apply digest:
`75b14af991dd1c0844555d724ac4068ab3d4b1279e5f3f4755709e93ea7ee0b5`. Private closing record:
`/tmp/still-purchase-functions-39718857548/production-closing-record.md`. Settings sync remains
deployed with unchanged source and needs no repeated deployment.

Initial safe probes passed eleven of thirteen cases: Stripe unsigned and invalid-signature POSTs
returned 503 instead of 400; GET returned the expected 405. Read-only diagnosis confirmed hosted
configuration matches the existing local writer configuration and all 21 prepared payment values.
The strict parser rejects the valid pooler username form containing the role and project suffix.
Boolean-only evidence is in `/tmp/still-purchase-functions-39718857548/runtime-config-readonly-proof.json`;
no SQL or provider write was used for diagnosis. Pre-enablement Stripe inventory confirmed the disabled
endpoint's intended URL, pinned API version and five events. The later deployment and enablement
proofs below resolve this historical 503 blocker and supersede that disabled state.

Repair [PR531](https://github.com/ZackC-1/still-app/pull/531), head
`55e12172de053139a8ac9b02a1f33d464d3b7089`, contains the narrow parser/security tests and plan 006.
Seventeen focused tests, 651 Deno tests/147 steps (one gated test ignored), lint and checks pass;
independent final review found no blockers. Actual private writer configuration plus all 21 prepared
values compose the runtime with zero SQL. [CI39723705611](https://github.com/ZackC-1/still-app/actions/runs/39723705611)
passed all 12 checks. PR531 merged at `26bf5a947de9fef70102c9be87f1e69806cbce46`,
05:07:50 UTC October 22. Only `create-web-checkout`, `complete-web-checkout` and `stripe-webhook`
upload bundles changed; the other six purchase and five analytics bundles were unchanged. The separately
approved repair deployment and hosted signature rejection are verified below.
New exact-revision [settings/GoTrue rehearsal39726287757](https://github.com/ZackC-1/still-app/actions/runs/39726287757)
passed at repaired main `26bf5a947de9fef70102c9be87f1e69806cbce46` on disposable infrastructure;
hosted repair and final-device acceptance remain separate.

Five-route [analytics functions apply39722863701](https://github.com/ZackC-1/still-app/actions/runs/39722863701)
completed after personal approval, with actual closing status verified: `analytics-purchase` and
`analytics-apple-purchase` created; `analytics-erasure`, `analytics-identify` and `delete-user`
deployed; all five source/JWT read-backs passed, no issues or recovery needed. Plan digest:
`3ffd97b1b88638bfa779cffebb4201d7f713d4d918a25f1cc041a07992dfd9d7`. Existing secret, eraser
and Vault readiness gates passed, so no secret rotation or replay is needed. Private closing record:
`/tmp/still-analytics-functions-39722863701/production-closing-record.md`.

Direct [erasure-schedule apply39728922800](https://github.com/ZackC-1/still-app/actions/runs/39728922800)
completed after the owner's approval at `26bf5a947de9fef70102c9be87f1e69806cbce46`, policy `enable`.
Actual closing status is verified: one `still-analytics-erasure-worker` job scheduled, no issues or
recovery needed. Exact plan digest: `be45dff44dbf23babddd30a9c8a46881733348031379ab587e7b8d035ac33df6`.
Private closing record: `/tmp/still-erasure-schedule-39728922800/production-closing-record.md`.
Cron installation does not establish an actual successful worker run; that proof remains pending.

Checkout-repair [purchase-functions apply39729361809](https://github.com/ZackC-1/still-app/actions/runs/39729361809)
completed after personal approval at exact `26bf5a947de9fef70102c9be87f1e69806cbce46`. Actual
closing status verified: `create-web-checkout`, `complete-web-checkout` and `stripe-webhook` deployed,
six routes unchanged, source/JWT read-backs passed, no issues or recovery needed. Exact plan digest:
`37c53dc48d7d8b74660a415ed9ab51f48cdb8ec622a11a1e28cb3fd59661268b`. Migration/secret
prerequisites and settings sync were unchanged. Closing record:
`/tmp/still-checkout-repair-plan-39729361809/production-closing-record.md`.

All 13 safe hosted probes passed after repair, including both Stripe POSTs returning
`400 invalid_webhook`; evidence is `/tmp/still-checkout-repair-39729361809/postdeploy-negative-probes.json`.
Fresh boolean-only comparison confirms all 21 prepared payment values match hosted metadata,
including the signing secret; no raw values were output. Previously approved conditional Stripe
endpoint enablement then completed with actual verified proof: live enabled status, intended URL,
pinned version and five events unchanged, all other endpoints exactly unchanged, no synthetic
delivery. Evidence is `/tmp/still-checkout-repair-39729361809/stripe-endpoint-enable-proof.json`.
RevenueCat portal settings remain unchanged. No real purchase/refund or positive webhook delivery
is claimed.
The owner wants earlier approvals: use the direct apply's built-in plan/rehearsal instead of
duplicate plan-only runs, preserving global sequential concurrency and every personal approval gate.

The future analytics-subjects switch must pin the merged PR531 repair SHA, not `2bad3028`, because
it refreshes checkout. Settings/GoTrue rehearsal39726287757 passed at exact repaired main `26bf5a94`;
the earlier `2bad3028` rehearsal does not satisfy the new pin. Analytics
subjects switch-on and final-device acceptance remain deferred until the owner's final production-channel
packages satisfy client-configuration gates; source and privacy publication do not satisfy them.
Actual successful worker proof remains pending through the protected switch gates; arbitrary
production SQL/CLI reads or writes must not bypass them. Three planned approvals remain after the
final build gates: analytics identity switch, production sales and Apple review access. None is ready
now, so no owner permission is needed at this checkpoint. The deep obsolete-code/test audit still
follows backend and final visual completion.

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
The [PostgreSQL rehearsal](https://github.com/ZackC-1/still-app/actions/runs/39692621515)
passed production checkout and isolated Apple review ledger checks. Production deployment,
review-build device journey and analytics exclusion remain pending. D4 is not enabled in production.

Analytics audit checkpoint: approved event names exist for paywall views and purchase stages, but
literal producer searches in current core/webview/native sources found schema/validation references
only. Treat funnel instrumentation and delivery as unverified; do not infer them from event schemas.

Read-only PostHog inspection on 21 October confirmed project 624923 (Still App) receives `opened`
events. Typed trends over the prior 30 days, including test activity, returned no `paywall_viewed`,
`purchase_started`, `purchase_completed`, `purchase_recorded`, `purchase_refunded` or
`checkout_returned` events. The instrumentation gap is confirmed; no production conversion claim
or dashboard is ready. Add client action/outcome producers through the existing consent-aware
analytics port; retain canonical server sales and review-transaction exclusions as separate gates.

### Purchase interaction instrumentation and privacy review

Browser checkout attempts/failures and restore outcomes now use the existing page analytics port.
An already-open checkout tab does not create another start. Apple settings offer openings,
deliberate dismissals, StoreKit dispatch, cancellation and unresolved/failure outcomes use the
existing app analytics client. Native context supplies iOS/Mac origin; no receipt or identifier
is included in these event properties. Generic accepted access never emits a new-sale event:
it can represent an existing right, restore, cross-device purchase or isolated review right.

The inline browser offer needs a truthful view denominator even when Settings opened directly.
Privacy review: extend only `paywall_viewed.trigger` with the fixed value `settings_card`.
This describes Still's own UI, uses the existing consent/identity/envelope and Product Interaction
declaration, and introduces no browsing, free-text, provider or customer data. Report once per page
only when the sellable card intersects a visible viewport. Do not invent `locked_switch` or
`upgrade_button` attribution for an unknown navigation path. No new event name or data category.

Browser visibility return after a pending checkout emits `checkout_returned` with `unknown`:
navigation and even a changed access snapshot cannot prove a new payment or a cancellation.

Still pending: canonical sale/refund attribution with durable deduplication and withdrawal checks,
remaining entry-point attribution, actual production event delivery,
review exclusions in reporting, and the final conversion dashboard. Interaction events are not
financial records and must not be presented as verified sales.

Source verification: lint, typecheck and build passed. Browser action/host/consent suites passed
139 tests, with the final checkout-return test bringing the action suite to 83. Apple host/app
suites passed 240 tests, privacy validation 109, and the actual default-on factories passed 37
browser and 29 Apple tests. Full browser fixtures passed 367 tests, with 37 intentional skips.
These checks use mocked analytics sinks and do not prove hosted PostHog delivery.

The served access rehearsal exposed its old sandbox issuer setting against the now production-only
reconciliation route. Its disposable fixture now uses production composition with generated keys,
synthetic provider ports and local PostgreSQL. Production source is unchanged by this correction;
QA routes retain their separate sandbox rehearsal. All 17 runtime-closure tests and four proof/
readiness tests passed locally; the actual CLI/database rerun remains required on the disposable CI runner.

### Provider read-back and reporting checkpoint — 21 October, 17:05 PT

The owner saved the live Stripe and replacement RevenueCat V2 credentials locally. Read-only calls
returned HTTP 200 for the expected live Stripe account, active prices, RevenueCat project, apps,
entitlements, offerings, lifetime package and app public-key inventory. The live V3 price is USD
9.99, one-time, tax-exclusive; its exact imported product is attached to `still_pro_v3` and the
current offering's lifetime package. The QA price belongs to a separate app. A random nonexistent
customer purchase-list request returned the documented customer-missing response rather than an
authorization error; no customer was created or customer data queried. This proves permission to
reach the purchase read, not positive purchase fulfilment.

The catalog exposed a historical compatibility gap: RevenueCat Billing's `still_sync_web` SKU
uses the `still_sync` entitlement, but the verifier previously required equal identifiers. The
verifier now accepts only that exact historical web alias and retains its `still_sync` benefit;
it cannot grant V3, substitute an Apple SKU or accept a different catalog product. Positive and
refund tests cover the actual legacy naming, alongside the existing store mappings.

The served access-route rehearsal now passes on head `6dfde1a0`:
[backend rehearsal](https://github.com/ZackC-1/still-app/actions/runs/39695948607).
The same head's production/review PostgreSQL ledger check and protected operation rehearsals pass.
One main-CI test timed out because it advanced fake time before real crypto initialization completed.
The test now awaits readiness and verifies that the account-wait timer exists before advancing time;
its 29-test suite passes locally. This changes the test's synchronization, not production behavior.

[Still Pro Conversion Readiness](https://us.posthog.com/project/624923/dashboard/2242729) contains
three native charts: offer-to-checkout-start within seven days, views/starts by surface, and purchase
interaction outcomes. All three were rerun successfully. The dashboard explicitly says producers
are not deployed and canonical sale/refund attribution is still pending. It excludes test/dev build
channels and the existing internal/test cohort; unlabelled events are not treated as evidence of a
verified release build. Counts represent device identities, not unique accounts or total revenue.

Local preparation validates the production Ed25519 signer pair, Apple verifier composition,
closed provider mappings and Managed Payments bindings using the runtime parsers. Private inputs
are stored outside the repository; the build handoff has a separate public-key-only JSON file.
The historical Web Billing mapping remains distinct from V3. `docs/purchase/success.html` and
`cancel.html` prepare production return pages; website publication and HTTP verification are pending.
Cancellation copy does not claim that no charge occurred, since the backend owns that decision.
The owner updated Stripe key permissions, but creation still returned 403 `webhook_write`; no new
Stripe endpoint was created. The exact missing permission has been requested.

### Protected production sales operation

Added the fixed production on/off operation, preserving the QA path's opposite-environment guard.
Both use the existing planner, compare-and-set transaction and rehearsal. The production rehearsal
starts with a sandbox cutoff and policy so coexistence is checked. First on writes only the four
owner-approved free benefits; off preserves cutoff, rights and recovery. Candidate browser versions
are 3.0.0 and Apple host versions 3.0, with Android excluded. The owner has been asked to confirm
these values; production on remains provisional until final packages are verified. No policy has
been published. See [operation procedure](../release/production-sales-policy.md).

Local operation coverage passes 62 tests; analytics operation coverage passes 16 tests. CI on
`a3124cc4` passes the main lint/typecheck/unit/build, Deno, StillKit, production ledger and Firefox
checks. A signature negative fixture could move inside its 300-second acceptance window while
awaiting crypto; it now stays an hour outside the window. The analytics rehearsal crossed a
quarter-hour cron tick, supplying a real run during its no-run negative control. Its disposable
database now disables the cron launcher before constructing the exact active schedule; the
production operation and evidence gate are unchanged. Another CI runner could not bind its
database port, so its served-route proof must rerun. These are not production checks.

Nineteen production configuration values are staged in the protected GitHub environment. Staging
does not apply them to Supabase. The separate Stripe webhook secret remains pending its endpoint's
creation permission; no new endpoint exists and the RevenueCat webhook is unchanged.

### Owner answers and webhook preparation, 21 October 2026

The owner confirmed Chrome/Firefox `3.0.0` and Apple `3.0` as the planned versions, with possible
QA-driven changes. The package evidence gate remains: a confirmed plan is not a final artifact.
The owner also authorized extending the RevenueCat server handler while preserving its dashboard
URL, token and settings.

Stripe endpoint creation now succeeds after the key permission update. A separate live production
endpoint was created with the five reviewed events and pinned API version, its signing secret was
saved privately, and the endpoint was disabled and read back. The unrelated existing endpoint was
preserved. `PROD_STRIPE_WEBHOOK_SECRET` is now staged in the protected GitHub environment, bringing
this session's staged configuration count to twenty. No hosted function or secret apply occurred.

The RevenueCat handler now refreshes production V3 rights through canonical RevenueCat V2 reads
and the existing linked-Apple transaction refresher. It neither trusts payload purchase claims nor
issues proofs nor creates Apple account links. Verified observations can persist independently;
unknown, partial, superseded or failed refreshes release the event claim for retry. Explicit sandbox
events are acknowledged without changing either legacy or V3 production account rights. The
legacy-only deployment remains compatible until production configuration is provisioned.

Verification for this increment: Deno lint checks 145 files; the full handler suite passes 632 tests
and 147 steps, with one separately gated integration test ignored. Entrypoint typechecking passes,
and all nine fixed production purchase routes compile and verify their closed upload dependency
sets. The 83 focused webhook/provider/Apple tests are included in the full suite. No live payment,
refund or production database write was performed.
