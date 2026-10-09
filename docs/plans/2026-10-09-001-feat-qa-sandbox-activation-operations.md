---
title: "Owner-approved operations that switch the QA sandbox lane on and off"
status: active (PRs open; apply of the sales switch blocked on A3 and D2)
date: 2026-10-09
owner: "Claude Code (QA activation tooling lane)"
branch: "feat/v31-qa-sandbox-operations-20261009 (PR 1), feat/v31-qa-sandbox-policy-subjects-20261009 (PR 2)"
---

# Owner-approved operations that switch the QA sandbox lane on and off

## Outcome

Every production write needed to admit the designated test accounts, publish the sandbox sales
switch and stop the paid QA lane runs through the existing protected `supabase-production` workflow:
manual dispatch from main, a secret-free plan bound by digest and rehearsed on a throwaway database,
owner approval, re-derived digest, pinned SQL, read-only verification and an always-run closing
record. Nothing in this plan runs against hosted Supabase; it only adds reviewed, rehearsed tooling.

## Context and evidence

- Activation packet (private, gitignored): `docs/build/v31-owner-qa-20261008/backend-step3-qa-activation.md`
  §1 phases D/F/G, §2.4, §4 gaps G1, G3, G4, G5 and §5 decisions D2, D3.
- Existing operations: `scripts/backend/deploy/operations.mjs` (pause/resume settings sync).
- Schema: `0016_product_policy.sql` (revisions, write-once cutoff, canonical render),
  `0021_qa_sandbox_access.sql` (QA writer role, `private.qa_sandbox_subjects`, wrapper lock order).

## Scope

In scope (this lane): G1 (generalised operation framework), G5 (`pause-qa-sandbox`,
`resume-qa-sandbox`), G4 (`qa-sandbox-subjects` enable/disable), G3 (`qa-sandbox-sales-policy`
off/on).

Out of scope: G2 `qa-sandbox-secrets` (another builder; the framework leaves a `kind` slot and the
workflow keeps its secret wiring per operation), G6 readiness output, G7/G8 return pages and the
bundle validator, docs G9, any hosted run or workflow dispatch, and D3 (accepted: the live
`revenuecat-webhook` is unchanged).

## Operations

| Workflow `operation` | Inputs | Kind | Writes |
|---|---|---|---|
| `pause-settings-sync` / `resume-settings-sync` | none | `role-login` | unchanged, byte-for-byte pinned |
| `pause-qa-sandbox` | none | `role-login` | `still_qa_sandbox_writer` NOLOGIN, then closes its connections |
| `resume-qa-sandbox` | none | `role-login` | `still_qa_sandbox_writer` LOGIN (password untouched) |
| `qa-sandbox-sales-policy` | `policy_mode` `off`/`on`, `policy_expected_revision` | `qa-sales-policy` | one sandbox `sales` revision (+ ledger row); `on` also the sandbox `paid_cutoff` once |
| `qa-sandbox-subjects` | `policy_mode` `enable` + `subjects_sha256`, or `disable` | `qa-subjects` | `private.qa_sandbox_subjects` only; never deletes |

## Safety invariants

1. Refuse by default: an operation, kind, input combination, SQL byte or check byte that is not
   pinned in `operations.mjs` is refused at plan and again at apply.
2. Each kind has its own allowed statement shapes; the pinned hash is the primary guard.
3. Role comparison: every Edge Function role stays untouched except the operation's own target
   (`role-login` only). Other kinds may change no role fact at all.
4. Migration history never changes.
5. Sales policy: environment hard-coded to `sandbox` (no `production` literal is allowed in the
   SQL); compare-and-set on the approved expected revision under `apply_product_policy`'s advisory
   lock; body validated by `private.product_policy_body_valid`; revisions only appended; the
   sandbox cutoff is inserted only by `on`, only when absent, and is write-once by trigger.
6. Subjects: the list exists only in the write-only environment secret
   `QA_SANDBOX_SUBJECT_EMAILS_JSON`, `{"salt":"<32+ random hex>","emails":[...]}`, bound to the
   approval by `subjects_sha256` = `<count>:<SHA-256 of {"salt","emails" sorted, lower-cased}>`.
   The salt keeps the public value from being checked by guessing emails (a missing or short salt
   is refused); the count is shown in the plan so the owner can check it against the designated QA
   accounts file. Only per-email SHA-256 values reach the database, through the psql environment,
   never argv. Enable makes the enabled set exactly the list: it refuses unresolved, ambiguous or
   unconfirmed accounts, and switches off (never deletes) any other enabled membership, all in one
   UUID-ordered pass (Auth row before membership row for listed accounts, matching the wrappers).
   Disable switches every enabled membership off and never deletes. Receipts carry counts only.
9. Limits, stated plainly: (a) once production has a paid cutoff, both sandbox sales switches
   refuse with `operation-precondition` (`production_cutoff_present`); `pause-qa-sandbox` is then
   the off switch. (b) Switching a membership off stops new paid grants only; sandbox rights
   already granted are kept until refunded or transferred through the QA flows. (c) Residual risk:
   enable cannot tell a mistyped real customer's email from a test account, so the list is built
   only from the designated QA accounts file and the owner checks the planned count.
7. Policy and subject SQL runs in one transaction, so any refusal writes nothing.
8. Provisional content cannot reach production: while the QA build identifiers (A3) or the cutoff
   content (D2) are provisional, the planner refuses `mode=apply` for the sales-policy operation.

## Decisions

| Item | State |
|---|---|
| D2 cutoff content | 0016 open question 6 leaves production undefined. Pinned constant: product `still-free-v2`, benefits = the sorted free-tier ids (`facebook.reels`, `instagram.reels`, `tiktok.all`, `youtube.shorts`). **Owner sign-off required**; apply refused until then. |
| A3 QA build identifiers | Not frozen. Pinned placeholder build `qa-provisional` per paid surface; apply refused until a reviewed change freezes them. |
| `policy_expected_revision` input | Added (the compare-and-set value must be part of the approved plan). |
| Subjects `disable` scope | Every enabled membership (works without the email secret, so it is a reliable off switch). |

## Work units

1. PR 1: generalise `operations.mjs` into kinds; `untouchedRoles(op)`; generic recovery/closing
   text; add G5; workflow choices; rehearsal matrix. Verify: operations, deploy, workflow tests.
2. PR 2: G3 and G4 kinds, SQL, verify SQL, rehearsal proofs and negative controls, workflow inputs,
   Deno race test in the disposable QA rehearsal. Verify: same tests plus local rehearsal.

## Verification

- `node --test scripts/backend/deploy/*.test.mjs`, `pnpm lint`, `pnpm typecheck`.
- CI `Supabase operation rehearsal` runs the real replay for every operation and mode.
- CI `Supabase security rehearsal` runs the subjects race test against the real 0021 wrappers.
- Local rehearsal only against this worktree's own `--local` database.

## Completion evidence

- PR 1 (#380): framework and G5. `node --test scripts/backend/deploy/*.test.mjs` green; local
  rehearsal of all four login switches against this branch's own `--local` database: verified.
- PR 2: G3 and G4. Same gates; local rehearsal of `qa-sandbox-sales-policy` off (expected 0) and on
  (expected 1), `qa-sandbox-subjects` enable and disable: every proof and negative control passed;
  `qa_sandbox_subjects_operation_test.ts` passed in a Linux container against the same local
  database (real 0021 wrappers).
- Not verified here: anything hosted (no production run or dispatch), real QA build ids (A3) and
  owner sign-off of the cutoff content (D2); apply stays refused until both land.
