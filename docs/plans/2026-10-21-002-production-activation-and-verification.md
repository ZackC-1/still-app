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
   Confirm live eligibility before implementing its final integration; do not silently substitute
   RevenueCat Web Billing or ordinary Stripe Checkout. Pending owner status read.
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
| Monitoring/recovery | Named checks for webhook failures, entitlement failures, sync errors and overdue erasure; stop-sales operation prepared and verified without revoking existing rights. |

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

Initial read-only inventory completed. No production configuration or customer records changed.
The DB-01 workflow used the existing `standing-v1` authorization; production write approvals remain
in force. First owner step: report the live Stripe Managed Payments status. Payment-account
readiness and new live charges have not been verified. No release go/no-go has been issued.

Sources for the guided portal steps: [Stripe Managed Payments setup](https://docs.stripe.com/payments/managed-payments/set-up),
[eligibility](https://docs.stripe.com/payments/managed-payments/eligibility),
[PostHog project analytics runbook](../release/posthog-analytics.md),
[PostHog filtering documentation](https://posthog.com/docs/product-analytics/trends/filters),
and [read-only database checks](../release/qa-readonly-database-checks.md).
