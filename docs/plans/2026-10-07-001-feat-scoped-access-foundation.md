---
title: "Prepare scoped purchase ownership foundation"
status: active
date: 2026-10-07
owner: "Codex Personal"
branch: "feat/v31-scoped-access-foundation-20261007"
---

# Prepare scoped purchase ownership foundation

## Outcome and scope

Migration 0019 gives trusted server code an account- and environment-scoped purchase ledger,
observation tokens, revocations and an explicit ownership transfer primitive. Existing or deleted
account ownership remains a conflict until an authorized transfer. Free blocking and free settings
sync retain their existing authority and behavior.

This is the database foundation for V3 Pro access. Apple migration 0020, provider verification,
proof issuance, client consumption and service deployment are separate work. Publish 0019 first;
do not replace a later Apple rehearsal with this foundation-only runner.

References: [strategy](../../STRATEGY.md), [current product](../PRODUCT.md),
[architecture](../ARCHITECTURE.md), [backend operations](../../scripts/backend/README.md),
and [catalog rehearsal roles](../solutions/security-issues/match-supabase-catalog-rehearsal-roles-and-managed-owners.md).

## Work and acceptance

1. Create the server-only ledger and token-fenced routines. Deny client roles and preserve
   no-silent-adoption semantics. Lock the sorted union of snapshot and owned keys so concurrent
   snapshots cannot reverse the order through absence writes or a row appearing mid-call.
2. Pin catalog, ACL, routine metadata and exact function bodies. Compare private full-row
   fingerprints and counts across the upgrade; seed valid, nonempty synthetic legacy rows only
   before upgrade. Clean-post drift fixtures and negative catalog controls roll back.
3. Exercise both SQL locking races on an ephemeral GitHub-hosted Linux database. Each earlier
   ordering must reproduce `40P01`; the reviewed ordering must complete with the expected owners
   and revisions. Always restore the reviewed routine after test instrumentation.
4. Admit bounded lowercase MD5 fingerprints alongside counts in the private deploy comparison.
   Require cloud tests explicitly in the hosted runner; refuse disabled required tests before DB
   work. The standalone branch tests 0019 and explicitly skips absent future 0020 fixtures.

The seven source paths are the 0019 migration, its two verification selectors, its cloud test,
`scripts/backend/rehearse.sh`, and the shared deploy parser and tests. No open policy decision
changes automatic ownership adoption or permits client grants.

## Verification evidence

- Backend boundary tests: 28 passed.
- Deploy tests: 57 passed; one explicit future-0020 publication-boundary skip.
- Deno frozen type check, lint and formatting: passed for the cloud test.
- Shell syntax and diff whitespace: passed.
- pglast 7.20: 16 DDL statements, four PL/pgSQL routines plus the final DO block, two read-only
  selectors and four instrumented concurrency variants parsed. This is syntax evidence only.
- Four raw function-body pins matched source. Commit body MD5:
  `36cbfea9ff8efc4c9ac5898dce5459db`.
- Required-cloud negative control refused locally with `required-cloud-tests-disabled` before
  DB work. Both optional database tests were ignored on macOS.
- Independent Muse source review approved the exact seven-source snapshot with no introduced
  P1/P2/P3 findings. Configured model: `muse-spark-1.3`; actual served model: **UNVERIFIED**.
  The final Claude attempt stopped at its weekly limit before reviewing this snapshot.
- The first hosted CI run applied 0019, then both backend jobs failed the existing 0014+
  catalog assertion because the four new routines used an empty search path. The correction
  pins `pg_catalog, pg_temp`, matching the maintained contract, and updates the exact 0019
  verifier. All four function bodies and their MD5 pins remain unchanged. A pglast control
  rejects the published settings and accepts the corrected settings; deploy tests pass again
  (57 passed, one explicit skip). Fresh independent review and hosted rerun remain pending.

## Remaining gates and recovery

Actual GitHub-hosted upgrade and clean SQL execution, catalog/ACL checks, preservation comparisons,
both deadlock controls, and the CLI apply path remain unexecuted locally. Publication enables CI;
it does not establish production compatibility or authorize service deployment.

Keep the exact-operation and cloud-only guards. A failed gate blocks deployment. Do not assume a
lossless down migration after ledger writes: repair forward under a separately reviewed operation.
Reusable runtime conclusions should be captured only after the actual cloud scenarios pass.

The owner authorized a non-draft PR and target-only monitoring. Protected merge remains with the
coordinator; the monitor must not merge, rebase, force-push or approve CI.
