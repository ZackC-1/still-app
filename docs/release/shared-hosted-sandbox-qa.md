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

Required 0015/0016/0019/0020/0021 history, their current objects and the sandbox policy row must exist
and pass the current prerequisite and QA catalog gates. Earlier migration gates deliberately pin
their original schema and RPC bodies; running those unchanged against the latest schema is not a
valid prerequisite check. If current objects are missing, stop and prepare a separately reviewed
prerequisite change. A successful disposable-database rehearsal does not establish those objects
on the hosted target.

The generic migration workflow refuses caller-selected Edge Function deployment. The separate
fixed `qa-sandbox-functions` operation deploys only the eight sealed QA bundles through the
protected workflow. Its `baseline-only` mode is the read-only readiness check: when the catalog gate
fails, the closing record lists the fixed issue codes from the 0021 gate and the current
prerequisite query (for example `role_not_login:<role>`, `role_membership:<role>` or
`sandbox_sales_policy_missing`) and `missing_secret:<NAME>` for each absent required secret name.
It never lists catalog facts, digests or values. Do not deploy from a developer shell or treat the
synthetic foundation workflow as production authority.

The migration receipt can report `applied-verified-counts-changed` when a private full-row invariant
changes while catalog verification passes. Investigate that warning before preparing a function
activation packet. Concurrent production traffic can change those fingerprints, so the warning
does not identify the cause. A successful migration exit code alone never authorizes QA activation.

The `supabase-production` GitHub environment exists with owner-only required approval (2026-10-09).
Every protected run still re-reads that protection itself and refuses without the owner's
approval; do not let a workflow implicitly create or widen an environment. On 2026-10-09 the
pending database updates 0014 through 0021 began to be applied one protected run per step, each
from the last `main` commit on which that update was the newest one. PR #373 bound the deploy
configuration so this catch-up can run, and PR #374 lets the 0021 end-state check run before 0021
is applied. Confirm the hosted history ends at `0021` before any activation step below.

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

## Activation order

Each row is a separate owner approval or portal visit. Do not start a row until the one before it
is verified. Operations marked *planned* are being built as separate reviewed PRs; until one is on
protected `main` with CI green, its row is blocked.

| Step | What happens | How | Verify before moving on |
| --- | --- | --- | --- |
| A. Preconditions | Hosted history ends at `0021`; the support PRs are merged; the private secret bundle passes the offline check | Local only | Offline check prints `PASS overall` (see below) |
| B. Provider settings | Dedicated QA Apple In-App Purchase key; RevenueCat and Stripe sandbox checks; Stripe webhook endpoint for `qa-sandbox-stripe-webhook`; provider mapping bound to the sandbox price | Owner portal visits | Names and IDs read back; no values in Git or chat |
| C. Secrets and logins | Owner stores the Secrets-only token; the 19 bundle values are staged as write-only environment secrets; `qa-sandbox-secrets` with workflow `mode` `apply` (*planned*) sets LOGIN with generated passwords for the three narrow roles and installs every required secret | Protected run | Closing record lists names and installed/unchanged only; every `REQUIRED_SECRETS` name present by digest |
| D. First sales-policy entry | `qa-sandbox-sales-policy` mode `off` (*planned*) publishes sandbox revision 1 with sales off and no cutoff | Protected run | `sandbox_sales_policy_missing` no longer reported; production revisions unchanged |
| E. Readiness and deploy | `qa-sandbox-functions` `baseline-only`, then `apply` with that baseline digest; change nothing in between | Two protected runs | Readiness lists no issues; apply closing record `verified` with eight routes; production function versions unchanged |
| F. Test accounts | `qa-sandbox-subjects` mode `enable` (*planned*) makes the enabled memberships exactly the designated QA accounts (any other enabled member is switched off, never deleted), bound by `subjects_sha256` (see below) | Protected run | The plan shows the approved account count and it matches the QA accounts file; closing record `admitted` equals that count; non-member, expired-Auth and production-RPC negatives refused |
| G. Test sales on | Website return pages `/qa/success` and `/qa/cancel` answer 200; then `qa-sandbox-sales-policy` mode `on` (*planned*) | Protected run | Public sandbox policy read shows the new revision; cutoff row for sandbox only; production unchanged |

### Offline secret bundle check

Before staging any value, run the [offline bundle check](../../scripts/backend/qa-secret-bundle-check.ts)
against the private bundle (one JSON object with exactly the 19 `STILL_QA_SANDBOX_*` provider and
authority values; database URLs are generated later inside the protected run) and the public
paid-sandbox trust record. It runs the real config readers with dummy database URLs that use the
exact role usernames, checks that the signer public key is in the public trust list and that the
list matches its recorded fingerprint, and confirms the approved return pages. It can read only
those two files, has no network permission, and prints one PASS or FAIL line per check name. The
exact command is in the script header. A PASS proves composition only, not provider permissions,
hosted reachability or purchase acceptance.

### Which builds the sandbox sales switch admits

The sandbox sales bodies list one build id per surface (`QA_SANDBOX_SALES_BUILDS` in
`scripts/backend/deploy/operations.mjs`). Extensions present their manifest version, unique per QA
test set (for test set 4, `2.1.1.321`). The Apple id `2.1.0` is not specific to one test set: every sandbox-routed Apple build at marketing version 2.1.0 matches it (Apple QA builds keep MARKETING_VERSION; the build number is not presented). The public App Store build is excluded because it reads the production policy environment, never this sandbox body. A new test set needs a reviewed change to those ids and
a new sandbox sales revision.

### Building the test-account list

The `QA_SANDBOX_SUBJECT_EMAILS_JSON` environment secret is one JSON object,
`{"salt":"<random hex>","emails":["...", "..."]}`:

1. Take the emails **only** from the designated QA accounts file (actors 2 to 8; never actor 0 or
   9). `enable` cannot tell a mistyped real customer's email from a test account, so nothing else
   may be pasted in, and the owner checks the count the plan shows against that file.
2. Generate a fresh salt, at least 32 lower-case hex characters, for example `openssl rand -hex 32`.
   The salt keeps the public approval value from being checked by guessing emails. A missing or
   short salt is refused.
3. Stage the object as the environment secret (stdin only, never argv or chat), then run
   `node scripts/backend/deploy/deploy.mjs subjects-digest < <file>`. It prints only
   `subjects_sha256=<count>:<sha256> accounts=<count>`; dispatch with that exact `subjects_sha256`.

### Off switches (fastest first)

1. **Turn test sales off:** `qa-sandbox-sales-policy` mode `off` (*planned*) publishes a new sandbox
   revision with sales off. Test apps stop offering purchases on their next policy read. Once
   production has a paid cutoff, both sandbox sales switches (`off` and `on`) refuse by design
   (`operation-precondition`, `production_cutoff_present`); use `pause-qa-sandbox` instead.
2. **Stop the whole paid test lane:** `pause-qa-sandbox` (*planned*) sets `still_qa_sandbox_writer`
   NOLOGIN and ends its sessions, so every paid QA route answers unavailable at once. Free sync and
   production customers are untouched. `resume-qa-sandbox` restores LOGIN without changing the
   password.
3. **Remove test accounts:** `qa-sandbox-subjects` mode `disable` (*planned*) sets `enabled=false`
   and never deletes rows, so refund and removal recovery stays reachable. It stops new paid grants
   only: sandbox rights already granted are kept until refunded or transferred through the QA
   flows. To stop every paid QA function at once, use `pause-qa-sandbox`.
4. **Remove QA secrets:** `qa-sandbox-secrets` with workflow `mode` `disable` (*planned*) deletes only the
   `STILL_QA_SANDBOX_*` secrets and sets the QA writer NOLOGIN; the shared narrow-role URLs stay.

Until those operations are on `main`, the owner's emergency fallback is deleting
`STILL_QA_SANDBOX_ENTITLEMENT_WRITER_DB_URL` in the Supabase dashboard; paid QA routes then stop as
their running copies restart. Revoke the Secrets-only token when testing ends.

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

## Database checks during QA

The programme's "Claude runs this" database steps (DB-01 to DB-38) use the protected
[read-only check route](qa-readonly-database-checks.md): one owner-approved workflow run per step,
a closed catalogue of reviewed SELECTs, a narrow read-only role limited to the owner's QA aliases,
a one-line public log and an encrypted full report. Its database part is a separate owner-approved install; until it is
installed, the owner pastes the programme's prepared read-only queries into the SQL editor instead.

## Disable and recover

Disable new initiation and account grants first. Retain paid operation, transaction and revocation
records; continue only reviewed recovery/refund work whose authority remains safe. Deleting a QA
account keeps its checkout operations with the account id cleared and deactivates its web rights
once migration 0022 is applied; before that, deletion removes the account's checkout operations
and leaves a paid right detached but active. Unsafe signing
authority requires unavailable responses, with existing bounded proof expiry recorded explicitly.

Restore only QA bundles changed by the packet. If the live RPC wrapper change regresses, use the
reviewed forward-restore SQL supplied by SQL PR #362, then repeat production-writer and old Edge
compatibility checks. Disabling QA alone does not restore changed production RPC bodies. Do not
delete ledgers, reverse prerequisite migrations, revoke production keys or alter production bundles
as an incidental rollback.

Keep outcomes in the release record and owner QA programme as PASS, FAIL or UNVERIFIED. Every
receipt identifies actual source/configuration/package provenance and whether its evidence came
from synthetic tests, disposable SQL, the hosted target or an installed device.
