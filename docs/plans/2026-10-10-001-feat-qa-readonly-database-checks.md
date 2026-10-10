---
title: "Protected read-only database checks for the owner QA programme"
status: active (PR open; hosted install, sign-in, registry and GitHub environment are owner steps)
date: 2026-10-10
owner: "Claude Code (QA database checks lane)"
branch: "feat/v31-qa-db-readonly-checks-20261010"
---

# Protected read-only database checks for the owner QA programme

## Outcome

Claude can answer the programme's "Claude runs this" database steps (DB-01 to DB-38) through a
GitHub workflow that can only read, with the owner approving every run, without the Supabase CLI,
a write credential or any customer data. Runbook and programme mapping:
[docs/release/qa-readonly-database-checks.md](../release/qa-readonly-database-checks.md).

## Decisions

- **New role, not the audit role.** `still_security_auditor` is catalog-only by design; the
  security audit reports `audit_role_not_narrow` if it can read any customer relation. A separate
  `still_qa_readonly_checker` reads only QA-scoped views.
- **Views, not table grants.** The role has SELECT on 25 `still_qa_checks` views and nothing else.
  Views filter to the owner-filled nine-label registry plus sandbox QA members, sandbox rights and
  whole-database counts. The free control account (actor 0) and deletion account (actor 9) are
  deliberately not sandbox members, so the registry is the QA scope.
- **Registry survives deletion.** Its account id is not a foreign key, so DB-29/DB-30 can count
  what is left for a deleted account.
- **Unnumbered candidate.** A numbered migration on `main` that hosted history lacks would block
  the fixed `qa-sandbox-functions` operation and move DB-01's baseline mid-QA. The owner chooses
  SQL-editor install of the reviewed file (recommended during QA) or a later numbered migration.
- **Extended protocol always.** postgres.js uses the simple (multi-statement) protocol for a
  query without parameters; the runner forces `simple: false` (found by the disposable test).
- **DB-36 is not read-only** (fault injection and writes); it stays an engineering record.

## Verification

- `node --test scripts/backend/qa-checks/qa-checks.test.mjs`: 13 pass (catalogue closed and
  complete, every query passes the guard, 30+ guard negative controls, views equal the candidate's
  creates and grants and all are used, output withholding, workflow shape, protection check,
  owner helpers).
- `deno test scripts/backend/qa-checks/run.test.ts`: session proof and failure text.
- `run-db.test.ts` against a disposable Supabase PostgreSQL 17.6 container with migrations
  0001-0021 and the candidate installed twice: 7 steps pass (session proof, every catalogue input
  with no raw id/email/session id printed, deletion check, synthetic customer invisible, base-table
  and registry reads and writes refused, widened role refused, admin session refused). CI repeats
  it in the `Supabase security rehearsal` workflow.
- Existing backend suites, `pnpm lint`, actionlint 1.7.7 and shellcheck pass.

## Remaining (owner)

Install the candidate, enable sign-in, register the nine labels, create the
`supabase-readonly-checks` environment and secret, then run `setup`. Hosted sign-in through the
session pooler and its certificate are unproven until then.
