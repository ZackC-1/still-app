---
title: "Production payment activation checkpoint"
status: active
created: 2026-10-21T17:35:00-07:00
source: codex-personal
intended_receiver: production backend session and build owner
---

# Production payment activation checkpoint

## Repository state

- Worktree: `/private/tmp/still-production-activation-20261021`
- Branch: `codex/production-activation-20261021`
- Previous source HEAD: `c680143a`; the following webhook increment is on the same draft
  [PR 522](https://github.com/ZackC-1/still-app/pull/522). Read Git for the current source HEAD.
- PRs 518/519 are incorporated with their commits preserved. The other session owns builds,
  visuals and PRs 517/520. The main checkout was not edited by this session.
- This checkpoint accompanies the owner-authorized RevenueCat handler increment and its tests.

## Objective and completed work

Production must implement the app's tested payment/sync behavior with live provider bindings,
while sandbox purchases remain isolated. Supabase holds payment and entitlement records;
PostHog holds consented product analytics. The owner authorized autonomous implementation.

PR 522 contains production Stripe Managed Payments checkout/recovery, migration 0026's narrow
purchase ledger, production provider composition, migration 0027's isolated Apple sandbox
review ledger, consent-aware purchase interaction producers, historical SKU compatibility and
production return pages. It also contains the protected production sales on/off operation.
First activation preserves exactly the four shipped-free benefits. Activation remains provisional
until packaged version admission is checked; emergency sales-off is independently available.

The new Stripe and RevenueCat keys passed read-only account/catalog checks. Live price, product,
RevenueCat app, entitlement and current offering bindings match the intended V3 USD9.99 one-time
product. Historical products remain separate. Apple key format and runtime composition pass;
an Apple API parameter-validation response is not successful transaction verification.

Twenty production configuration values have been staged in GitHub's protected environment.
None have been applied to Supabase. Private material is outside Git. The build owner can read
the **public-only** trust handoff at
`/Users/zack/.local/share/still/production-payments-20261021/public-access-keys.json`.
Its key ID is `still-access-production-20261021`. Match it against the actually deployed signer
before completing PR 520's paid-build gate; local preparation is not hosted evidence.

## Verification

- Local protected-operation suite: 62 pass; analytics-operation suite: 16 pass.
- Local webhook suite: 22 pass; provider/configuration suites: 38 pass.
- Current source CI passes production checkout/review PostgreSQL ledger, Deno, StillKit, Firefox,
  read-only check route and all protected operations, including production sales on/off.
- The previous head passed all checks except Playwright still running at that read. The webhook
  increment must receive fresh CI. Local full Deno: 632 tests and 147 steps pass, one ignored;
  Deno lint and webhook entrypoint typechecking pass.
- Earlier local Playwright run: 367 pass, 37 skipped. Production device checks remain outstanding.
- Two timing fixtures were corrected: a future signature moved inside its tolerance while awaiting
  crypto, and a cron quarter-hour tick supplied evidence during a no-run negative control. Cron
  suppression belongs only to the disposable runner container, not the ordinary production role.
- A direct production `product-policy` request returned gateway `NOT_FOUND` (function absent),
  not a policy-body 404. No production sales revision or cutoff can be inferred from that response.

## Owner answers and latest preparation

All three owner questions were answered. Stripe Webhook Endpoints Write was saved; live endpoint
creation now succeeds. The separate Still production endpoint is created, disabled and verified
with its five fixed events/API version. Its signing secret is saved privately and staged as
`PROD_STRIPE_WEBHOOK_SECRET`; twenty values are staged in total. The unrelated endpoint is untouched.

Planned release versions are confirmed as Chrome/Firefox `3.0.0`, Apple `3.0`; QA may change them.
Keep the packaged-version gate until actual artifacts are inspected.

The owner authorized the RevenueCat server handler extension while preserving dashboard settings.
The implementation now refreshes canonical V3 rights and existing linked Apple transactions, retries
incomplete refreshes and skips sandbox notifications for both production account projections.
83 focused tests pass; all nine production purchase routes compile. Hosted deployment is pending.

## Remaining engineering and operational gates

1. Keep the new Stripe endpoint disabled until the production handler is deployed and verified.
2. Complete the RevenueCat handler source review and CI; verify real delivery after deployment.
3. Implement canonical `purchase_recorded` / `purchase_refunded` attribution and deduplication.
   These server-only events currently have no producer. Current and original device consent,
   account lifecycle and review/sandbox exclusion must hold; purchase fulfilment must remain
   independent. Do not infer sales from access snapshots, restores or checkout return pages.
   An active analytics subject alone is insufficient evidence that a device still shares data.
4. Finish current-head CI and review, merge through protection, then prepare pinned-main plans
   for migrations, purchase secrets/functions and the separately protected sync deployment.
   Owner environment approval is required for hosted apply; agents must not self-approve it.
5. Verify hosted analytics erasure scheduling and subject activation. Historical secret/function
   deployments were found, but a successful schedule/switch activation was not established.
6. Publish and verify the checkout return pages, complete public-key/build alignment, and run
   final-device purchase, restore, account-switch/deletion and analytics-consent verification.
   Genuine payment/refund evidence remains outstanding. Do not manufacture live test charges.
7. Enable sales only after the release gates clear, preserving the approved free outcome.

## Reporting state

[Still Pro Conversion Readiness](https://us.posthog.com/project/624923/dashboard/2242729) has
three native charts for offer-to-start conversion, supported-surface interactions and outcomes.
The charts were rerun successfully. The dashboard labels deployment and canonical sale reporting
as incomplete; it excludes test/dev and the existing internal cohort. It does not claim complete
financial accounting or deduplicated account-level conversion.

## Next safe action

Inspect PR 522's current checks and the owner-approved webhook changes. Continue in the owned worktree;
preserve the build session's branches. Follow the active
[plan](../plans/2026-10-21-002-production-activation-and-verification.md) and
[sales procedure](../release/production-sales-policy.md). These V3 changes remain undeployed and
no sales policy was published by this work.
