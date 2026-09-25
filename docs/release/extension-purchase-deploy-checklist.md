# Account sign-in and retained purchase deployment reference

Current reference for Still 2.0.0; reviewed September 14, 2026. The filename is retained for existing
links. All blocking and optional sync are free; the old purchase checklist is not an activation
prerequisite. The [prior checklist](../archive/pre-2.0-reference-refresh/docs/release/extension-purchase-deploy-checklist.md)
preserves the July deployment, template-regression and purchase-test history.

## 1. Supabase email-code sign-in

The shared cross-platform flow uses an emailed six-digit code. Both new-account “Confirm signup”
and existing-account “Magic Link” templates must support code entry; do not reintroduce verification
links that mail scanners can consume. Current expected OTP lifetime is one hour with a 60-second
resend cooldown. Configured production settings, not local defaults alone, determine actual delivery.

The [September 14 record](history/2026-09-14-release-status.md#backend-email-and-operational-decisions)
credits custom SMTP, the verified `stillapp.fit` sender, receipt tests and disabled Resend click/open
tracking. Preserve that evidence. Before a new auth/configuration change, verify the affected
settings and new/existing-account flow; do not repeat all completed release tests without a reason.
Provider daily/monthly allowances are separate from Supabase's hourly limit.

### 1b. Hosted configuration checks

For a new upload affected by auth changes, compare the actual hosted code length/lifetime and
resend policy with the client, confirm both templates, and verify the intended SMTP sender.
A code entry UI cannot compensate for a mismatched eight-digit provider setting or failed delivery.
Collect pass/fail and dates only; never publish codes, session tokens or email contents.
The [hosted-config lesson](../solutions/conventions/hosted-portal-config-drifts-verify-live.md)
explains why a past dashboard observation cannot prove a later changed deployment.

### 1c. review-signin deploy + config cross-check (HARD gates, R14/R16)

The retained Apple reviewer path accepts a fixed code for one private designated address and sends
no email. Ordinary accounts use normal OTP. The deployed secrets and Apple-only
`VITE_REVIEW_SIGNIN_EMAIL` build input must match the private App Review information.

The September 14 record confirms the later `review-signin` deployment and logging update. Do not
redeploy, remint or rotate merely to complete an old checkbox. For a newly approved revision:

1. Prepare only the required secrets in a private ignored env file; never inline values in command
   arguments or public artifacts. Keep reviewer configuration out of extension builds.
2. Follow [the deployment/dependency procedure](counter-retention.md#edge-dependency-configuration)
   for the exact reviewed function and target. Preserve the documented CLI compatibility behavior.
3. Verify source/configuration parity and the approved reviewer sign-in; wrong-code and unrelated
   address requests must fail closed. Use only approved test identities, with no secret-bearing logs.
4. Preserve the shared reviewer code while either iOS or macOS submission references it. After all
   relevant reviews resolve, retire/rotate with the corresponding private portal information updated.

Authentication smoke evidence and the full hosted seed/switch/export/delete/re-create lifecycle
are separate. The latter remains the issue #153 certification item.

## 2. RevenueCat (Web Billing)

Purchases are dormant. Keep existing identifiers/ownership and the current provider connection.
No billing product, Stripe connection, entitlement grant or sandbox purchase is needed for free
2.0.0. For explicitly approved future paid work, use the [RevenueCat runbook](04-revenuecat.md)
and [retained monetization design](../monetization-design.md).

## 3. Extension build config

Configured Chrome/Firefox artifacts include the intended public `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`. Blank values retain all free blocking but omit cloud auth/sync.
An uploaded artifact cannot gain configuration from a later local `.env` edit. Preserve its exact
source, public-config allowlist, toolchain and lockfile for Firefox reproduction.

## 4. Store listings

Use [current free listing copy](store-listing-copy.md), actual four-site permissions, optional
email-code sync and current privacy disclosures. Do not describe Pro checkout, paid sync or purchase
restore as a 2.0.0 reviewer step. Keep owner-edited submitted Apple text and accepted screenshots.

## 5. Support playbook

Earlier buyers can use 2.0.0 without restoring or recovering a purchase. Receipt/refund enquiries go
to `support@stillapp.fit`; web refunds use the approved 14-day window, Apple refunds go through Apple.
Account export requests go to `privacy@stillapp.fit`. Do not automatically grant entitlements or
merge accounts to solve a free-feature support request.

## 6. Verification boundaries

The normal required CI checks exercise source behavior, including free-mode gates and retained
purchase logic where explicitly tested. Paid-only tests skipped under disabled flags are not new
purchase evidence. Existing Mac/iPhone checks remain credited; physical iPad is owner-accepted
skipped/unverified. See [validation](VALIDATION.md) and the current dated release record.
