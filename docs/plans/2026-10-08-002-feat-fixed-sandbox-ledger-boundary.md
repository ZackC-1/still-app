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

Source preparation verifies seven literal core bodies, the exact two Auth-helper substitutions, all nine prior rollback bodies, eighteen QA signatures and thirty-nine catalog body pins. Existing backend runtime/publication checks passed all twenty tests after allowing public dependency metadata for cold Deno resolution. Shell syntax and whitespace checks passed.

Typed SQL compilation passed with the database test intentionally ignored on macOS; this is not SQL runtime evidence. The actual independent Claude SQL review retained four findings, all accepted and addressed: PostgreSQL 17 creator membership, strict shared-table RLS metadata, known refunds from a banned prior holder, and narrow login resource limits. A further source review and complete cloud run remain required.

The second disposable Linux run at `93d56fa8` applied the migration and passed seven behavioral steps, but failed seven others. Corrections use driver-native JSONB fixtures, reuse a private postgres account reader rather than granting access to managed Auth, and temporarily acquire only the QA owner ACL authority inside the emergency rollback transaction before removing that explicit edge. The two original catalog rehearsal baselines remain pinned at 0020 so their selected-creator refusal assertion continues to characterize its original boundary; the separate QA job tests 0021.

Corrected cloud upgrade and clean install, production Edge/new-SQL compatibility and emergency rollback execution remain unverified. No hosted migration, credential provisioning, provider call or payment was performed.

## Hosted gate and recovery

Before any actual apply, verify current migration prerequisites through 0020, exact current production routine definitions/owners/ACLs, baseline behavior and row fingerprints. Missing prerequisites stop this operation and require a separate prerequisite scope. Review the exact target, source/config hashes, role/login actions, private QA membership and forward-restore packet before external writes. Never treat a source merge or successful cloud rehearsal as target deployment authorization.

The forward restore is an emergency authority stop; it retains records and existing bounded offline proofs may remain usable until their expiry. A normal QA subject disable keeps its known negative/recovery path available. No production purchase rows, historical entitlements or owner installations are reset to simplify QA.
