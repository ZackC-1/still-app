# Shared-hosted sandbox QA

This runbook implements the activation sequence in
[the shared-hosted QA plan](../plans/2026-10-08-001-feat-shared-hosted-paid-sandbox-qa.md).
Use the existing hosted backend with the designated test accounts. Free blocking and optional free
settings sync remain independent of purchases. Source review, CI and merged PRs establish source
readiness; they do not establish hosted or installed-device acceptance.

## Before an approval packet

Freeze the reviewed source and capture a fresh read-only target baseline. Record the exact project,
migration history, prerequisite objects, production RPC definitions/owners/ACLs/security properties,
role memberships, enabled routes/JWT settings and configuration-name presence. Preserve private
account lists, credentials and database fingerprints outside Git and public CI logs.

Required 0015/0016/0019/0020-era objects and the sandbox policy row must exist and pass their gates.
If any are missing, stop and prepare a separately reviewed prerequisite change. A successful
disposable-database rehearsal does not establish those objects on the hosted target.

The protected migration workflow currently refuses Edge Function deployment. Do not deploy from a
developer shell or treat the synthetic foundation workflow as production authority. An exact,
reviewed function-deployment operation and its negative controls are required before activation.

## Exact route scope

The compiled client profile is `shared-hosted-sandbox`; it must agree with sandbox public trust in
the browser, WebView, Apple app and Safari extension. Unknown configuration holds requests and
never falls back to production. The seven client routes and separate provider receiver are:

| Function | Gateway JWT | Authority |
| --- | --- | --- |
| `qa-sandbox-product-policy` | false | Public policy read through the existing narrow reader |
| `qa-sandbox-sync-settings` | true | Authenticated subject-owned free settings |
| `qa-sandbox-reconcile-entitlement` | true | Current Auth and fixed sandbox account access |
| `qa-sandbox-verify-apple-access` | false | Independently verified sandbox Apple local possession |
| `qa-sandbox-link-apple-access` | true | Deliberate account link; transfer also proves the source |
| `qa-sandbox-create-web-checkout` | true | Enabled QA subject and persisted managed operation |
| `qa-sandbox-complete-web-checkout` | true | Bound operation and verified current provider evidence |
| `qa-sandbox-stripe-webhook` | false | Dedicated webhook signature and bound sandbox observation |

JWT configuration is only the gateway boundary. Retain each handler's Auth, membership, environment,
provider and ownership checks. A response or import acknowledgement never grants Pro; accepted
signed access committed by the existing client/native authority does.

## Packet contents

Bind the following to one proposed execution scope before requesting approval:

- Protected source commit/tree, exact function entrypoints/import tree and bundle hashes, pinned
  toolchain and deployment-operation digest.
- Actual target/catalog baseline, exact migration/role/grant diff, production-writer preservation
  checks, old production Edge/new SQL compatibility and exact reviewed forward restoration.
- Secret names from the [blank server template](../../supabase/functions/qa-sandbox.env.example),
  private configuration fingerprints and privately held QA subjects; no secret or account values.
- Verified dedicated Stripe test account, exact product/price and API version, RevenueCat QA
  app/product/entitlement mapping and permissions, Apple sandbox mapping and matched signer/trust.
- Named notification endpoints, provider changes, bounded positive/negative probes, monitoring,
  disable/recovery procedure and residual signed-proof validity window.

Account registry insertion, QA-role creation, secret installation and provider configuration are
external writes. Include each intended action explicitly. Existing production billing, global live
secrets and production Edge bundles stay outside this packet.

## Approved execution and acceptance

1. Recheck the target and source against the approved packet immediately before execution.
2. Apply only the approved schema/role change while QA initiation remains off. Repeat production
   writer and old Edge compatibility checks before installing QA authority or enabling purchases.
3. Install only approved inputs and deploy only the bound QA bundles through the reviewed protected
   operation. Read back composition and failure responses without issuing arbitrary rights.
4. Enable only approved QA subjects. Verify nonmember, expired Auth, wrong environment, malformed
   proof and production-preservation negatives before the first purchase.
5. Verify real sandbox purchase/import/reconciliation, local Apple ownership, deliberate link and
   transfer, Restore, full refund and recovery with bounded traffic. Preserve free sync and offline
   blocking throughout. Do not substitute mocked transport results for these checks.
6. Produce matched signed packages and record installed journeys on every supported surface.
   TestFlight and persistent Firefox/Android installation are separate acceptance checks.

Monitor fixed reason codes, latency, unavailable responses, operation backlog, webhook failures and
scope denials without receipts, JWTs, personal identities or browsing data. Stop on a QA-attributable
paid write outside sandbox scope, unmanaged checkout, cross-environment acceptance or unexpected
catalog/configuration drift. Designated QA accounts' own free-settings writes are expected.

## Disable and recover

Disable new initiation and account grants first. Retain paid operation, transaction and revocation
records; continue only reviewed recovery/refund work whose authority remains safe. Unsafe signing
authority requires unavailable responses, with existing bounded proof expiry recorded explicitly.

Restore only QA bundles changed by the packet. If the live RPC wrapper change regresses, use the
reviewed forward-restore SQL supplied by SQL PR #362, then repeat production-writer and old Edge
compatibility checks. Disabling QA alone does not restore changed production RPC bodies. Do not
delete ledgers, reverse prerequisite migrations, revoke production keys or alter production bundles
as an incidental rollback.

Keep outcomes in the release record and owner QA programme as PASS, FAIL or UNVERIFIED. Every
receipt identifies actual source/configuration/package provenance and whether its evidence came
from synthetic tests, disposable SQL, the hosted target or an installed device.
