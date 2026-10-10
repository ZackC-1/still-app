---
title: Keep payment records and deactivate rights inside the account deletion transaction
category: security-issues
track: bug
problem_type: security_issue
module: supabase/migrations
applies_when: A table that records money, refunds or access references auth.users, or account deletion must change ledger state
date: 2026-10-10
status: active
tags: [privacy, retention, account-deletion, payments, postgres, qa-sandbox]
---

# Keep payment records when an account is deleted

## Symptom

A QA source review found two problems with account deletion (`delete-user` calls GoTrue's admin
delete, which hard-deletes the `auth.users` row):

- `private.qa_sandbox_purchase_operations.holder` was `ON DELETE CASCADE` (0021), so deleting an
  account deleted its paid Stripe checkout records. The QA runbook says paid operation records are
  kept.
- `private.access_rights.holder` is `ON DELETE SET NULL` (0019). A paid web right survived detached
  but still `active = true`.

The owner decided (2026-10-10): delete personal data, keep payment records needed for refunds,
tax and disputes, and deactivate the account's Pro rights.

## Solution

Migration `0022_account_deletion_keeps_payment_records.sql`:

- Changes the checkout operation's account reference to `ON DELETE SET NULL` (column nullable).
  The operation id and Stripe Checkout Session id remain the non-personal matching keys.
- Adds a `BEFORE DELETE` row trigger on `auth.users` that deactivates the account's active
  RevenueCat-sourced rights (`active = false`, revision + 1, fresh `verified_at`), the same state
  change a canonical refund observation makes. It runs inside GoTrue's deletion transaction, so a
  failure fails the deletion rather than leaving an active orphan.
- Repairs rights orphaned before the migration (RevenueCat-sourced, holder null, active).

The QA Stripe webhook settles a later full refund for a deleted account by marking the kept record
`refunded` through the existing exact operation+Session RPC (`recordDeletedAccountRefund`). It
never recreates, observes or grants anything to the deleted account.

## Why it must be a BEFORE trigger

Foreign-key actions run as internal `AFTER` triggers named `RI_ConstraintTrigger_…`. Postgres fires
same-timing triggers in name order, and uppercase sorts before lowercase, so a user `AFTER DELETE`
trigger sees `holder` already cleared by `ON DELETE SET NULL` and cannot find the account's rights.
A `BEFORE DELETE` trigger still sees the rows. It locks the account's `access_observations` rows
before the rights, the order `commit_access_observation` and `transfer_access_right` use.

## Where it does not apply

Apple-sourced rights are not deactivated. Since 0020 they are accountless: `active` is Apple's
refund verdict for local access on the purchaser's Apple ID, and `false` is treated as a permanent
refund. Deletion already detaches them, and 0020 refuses to re-link a detached right. Changing
that requires an explicit owner decision because it would remove access Apple still says was paid.

`public.revenuecat_events` keeps its RevenueCat app user id and payload; it already survived
deletion and the privacy notice discloses retained billing events.

## Verification

- Disposable PostgreSQL 17 harness with a non-superuser `postgres` operator and a separate
  table-owner role doing the delete, standing in for GoTrue: the pre-0022 orphan reproduced
  (`active = true`), the migration repaired only it, and the gate went from six issues to `[]`.
  Deleting a live account deactivated its web right, detached (but did not deactivate) its Apple
  right, kept its checkout operations with `holder` null, and removed its observations. A second
  open orphan did not collide on the one-open-checkout index.
- Deno unit tests for the store and webhook. The main deleted-account refund test fails without
  the webhook change.
- `supabase/tests/account_deletion_payment_records_test.ts` runs in the GitHub-hosted security
  rehearsal (`rehearse-qa-sandbox.sh`): upgrade from a seeded 0021 deletion, private-row
  invariant, end-state gate, deletion, deleted-account refund and gate drift probes.

## Prevention

- Any new table that records payments, refunds or provider transactions references `auth.users`
  with `ON DELETE SET NULL` (or no foreign key), never `CASCADE`.
- State that must change when an account is deleted changes in a `BEFORE DELETE` trigger on
  `auth.users`, never in Edge code after the GoTrue call, which may already have lost the identity.
