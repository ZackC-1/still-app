---
title: Fixed sandbox ledger boundaries for shared-hosted QA
type: feat
status: in-progress
date: 2026-10-08
---

# Fixed sandbox ledger boundaries

Prepare the server-only sandbox ledger boundary for Still v3.1 QA on the existing hosted backend. This source change does not deploy a migration, enable a database login, register an owner account or activate payments. Existing free blocking and settings sync remain independent of purchase authority.

## Requirements

- R1. A dedicated QA login can execute only named fixed-sandbox wrappers. It cannot call production writer RPCs, private cores, read or mutate private tables directly, inherit privileged roles or modify the legacy entitlement projection.
- R2. Enabled, confirmed QA membership is required for positive account grants, explicit links and transfers. Membership disablement races use common database row locks. Both accounts authorize a transfer.
- R3. Genuine native sandbox possession stays accountless. The local Apple wrapper accepts no holder or linking arguments. Explicit linking and account confirmation use distinct wrappers.
- R4. Canonical known refunds and removals survive membership disablement, including a transferred purchase observed by its original provider subject. Unknown negatives cannot create a right. Delayed active results cannot resurrect a canonical refund.
- R5. Preserve purchase identity through interruptions. Immutable holder, configuration fingerprint and Session binding; one unresolved attempt; one-way creation claim before any external creation request. Unknown attempts never release another charge; canonical paid time prevents later unpaid closure.
- R6. Nine existing production RPCs retain their signature, owner, ACL, session/writer guard and successful or denied behavior. Seven shared private cores preserve literal prior ledger bodies; the two existing Auth-reading cores use the reviewed private account-reader helper with missing-account and lock options matching the prior behavior. Existing rows and policy revisions remain unchanged by migration apply.
- R7. The separate QA rate limiter uses closed quotas and short-lived HMAC counters without storing clear IP or subject values.
- R8. Reviewed emergency forward restore recovers prior production definitions and stops QA execution without deleting ledger records. Ordinary registry disablement continues known negative recovery and differs from an emergency stop.
- R9. Actual disposable GitHub-hosted Linux tests must exercise upgrade and clean install, real login denial, membership races, recovery and rollback; old production Edge composition must also run against the new SQL. Local skipped SQL tests are not successful database evidence.

## Implementation

1. Prepare tentative source migration `0021_qa_sandbox_access.sql`, eighteen fixed QA RPCs, nonlogin owner/writer roles and sandbox RLS. Actual hosted migration history must determine the final deployment number.
2. Extract nine current 0019/0020 bodies into SECURITY INVOKER private cores. Production SECURITY DEFINER wrappers retain their existing guard and ACL. This is a live-path change on apply even if all QA routes remain disabled.
3. Add synthetic pre-upgrade fixtures, row fingerprints and prior routine metadata; run actual SQL characterization and read-only catalog checks on isolated cloud infrastructure.
4. Add a separate cloud job for the fixed-sandbox SQL upgrade/clean-install tests. Retain the existing 0020 access rehearsal default and explicitly exercise existing Edge entrypoints against 0021 as an additional compatibility probe.
5. Obtain source review, evaluate findings, complete CI and actual cloud rehearsal before considering protected merge. Hosted apply remains a separate concrete reviewed action.

## Verification and current evidence

The source boundary preserves seven literal core bodies, the exact two Auth-helper substitutions,
all nine prior rollback bodies and eighteen public QA signatures. The four latest review repairs
raise the read-only catalog check from thirty-nine to forty body pins without adding a public RPC.
Typed Deno compilation, shell syntax, scoped lint and whitespace checks pass. Local macOS SQL
execution remains intentionally ignored; it supplies no database runtime evidence.

The earlier independent Claude review findings were addressed before `f81f8798`: PostgreSQL 17
creator membership, strict shared-table RLS metadata, known refunds from a banned prior holder,
and narrow login resource limits. Earlier cloud runs exposed JSONB fixture encoding, managed Auth
permission and pooled BEGIN/COMMIT fixture errors; the corrected fixture reserves a connection
with `admin.begin`. The original two catalog rehearsal baselines remain pinned at 0020 so they
continue to characterize their original boundary.

At `f81f8798`, all thirteen PR checks passed. The disposable GitHub-hosted Linux QA rehearsal
(run `37830768293`, job `113495657647`, merge commit `336da596356281dcf6d527839c9fad6b92fab5c6`)
passed both upgrade and clean install: fifteen behavioral steps each, plus thirty-three pgTAP
checks. Both production gateway modes ran the existing served access characterization against
0021. This does not cover every historical 0019/0020 Edge suite, real providers or devices.

A full frozen-head review then completed ten local specialist lenses and an actual independent
Claude review, with terminal peer collection and cleanup. It confirmed four P2 items. Their
source repairs are now prepared:

- Revoke the new QA owner's default PUBLIC function execution and audit the selected creator
  after both upgrade and clean install.
- Validate a complete observation batch before filtering unknown or unowned negatives and
  disabled-member positives; preserve a known refund in a valid mixed batch without creating
  unknown rights. Malformed observations and owned source/product mismatches still fail.
- Exercise canonical unpaid closure of an already claimed and Session-bound operation, then
  assert a new operation can use the single open slot.
- Run a private postgres-only minute cleanup job for expired QA limiter windows and their
  counters. Preserve this retention job after emergency authority stop and assert actual cron
  deletion of expired data while unexpired data survives.

These five-path repairs preserve the production wrappers and shared core bodies. Their typed and
static checks pass, but the changed SQL, expanded regression steps, creator audit and real cron
execution still require a new clean/upgrade cloud run and follow-up review before merge. A source
merge or CI result does not authorize hosted activation. No hosted migration, credential
provisioning, QA account admission, provider call or payment was performed.

## Hosted gate and recovery

Before any actual apply, verify current migration prerequisites through 0020, exact current production routine definitions/owners/ACLs, baseline behavior and row fingerprints. Missing prerequisites stop this operation and require a separate prerequisite scope. Review the exact target, source/config hashes, role/login actions, private QA membership and forward-restore packet before external writes. Never treat a source merge or successful cloud rehearsal as target deployment authorization.

The forward restore is an emergency authority stop; it retains records and existing bounded offline proofs may remain usable until their expiry. A normal QA subject disable keeps its known negative/recovery path available. No production purchase rows, historical entitlements or owner installations are reset to simplify QA.
