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
- **Preserved QA account is optional (follow-up, 10 Oct).** It is an older account, not a `+stillqa`
  alias, so the unchanged alias rule refuses it. The registry needs the eight aliases; `setup` and
  DB-02 pass with eight and note it; checks naming it answer `unavailable`, not `fail`. No SQL change.
- **DB-36 is not read-only** (fault injection and writes); it stays an engineering record.
- **Security review (10 Oct) changes.** Registration and visibility are bound to the owner's
  `+stillqa-<name>` aliases through a mailbox digest (trigger plus read-time rule; no address
  committed); paid-lane labels must also be sandbox members. The public log gets one verdict line;
  the full report is age-encrypted to a repository-variable public key. Production is reduced to a
  keyed digest compared with the DB-01 baseline. Rights are QA-held, QA-linked or holder-less
  sandbox rights verified after the registry was filled; erasure jobs are last-hour counts. The
  session proof also refuses definer EXECUTE, database CREATE and changed role settings. References
  are HMAC-keyed. Sign-in expires after 60 days. The QA account file was not on disk, so the exact
  alias domain could not be confirmed; the rule is domain-agnostic and bound to the owner's digest.

## Verification

- `node --test scripts/backend/qa-checks/qa-checks.test.mjs`: 16 pass (catalogue closed and
  complete, guard negative controls, production never in a printed query, one alias rule in all
  places, views equal the candidate's creates and grants and all are used, keyed references,
  output withholding, verdicts, workflow shape and pinning, protection check, owner helpers).
- `deno test scripts/backend/qa-checks/run.test.ts`: 4 pass (session proof incl. definer, CREATE
  and role settings; keyed production digest; failure text; age v1.2.1 encryption round trip).
- `run-db.test.ts` against a disposable Supabase PostgreSQL 17.6 container with migrations
  0001-0021 and the candidate installed twice: 10 steps pass (alias-only registration, session
  proof, every input with nothing raw and no production fingerprint, non-QA rights/customers/older
  erasure jobs invisible, paid-lane label without membership refused, keyed production comparison,
  deletion check, refused reads and writes, six kinds of widened role refused, admin refused).
  CI repeats it in the `Supabase security rehearsal` workflow.
- Existing backend suites, `pnpm lint`, actionlint 1.7.7 and shellcheck pass.

## Remaining (owner)

Install the candidate, create the sign-in, register the nine labels (preview then commit), create
the environment with two secrets and the public-key variable, then approve `setup` and DB-01. Hosted sign-in through the
session pooler and its certificate are unproven until then.
