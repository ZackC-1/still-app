---
title: Verify migration preservation query output against the deployment parser
category: logic-errors
track: bug
problem_type: logic_error
module: scripts/backend/deploy
applies_when: Adding migration gates and before-and-after preservation snapshots
date: 2026-10-21
status: active
tags:
  - supabase
  - migrations
  - deployment
---

Migration structure gates and preservation snapshots have different output contracts. A structure
gate reports an array of issues. The deployment preservation parser expects a nonempty JSON object
whose values are nonnegative integer counts or 32-character hexadecimal fingerprints. Copying a
structure gate into an invariant file can produce valid SQL and still stop deployment with
`row-count-output-invalid` before any hosted write.

The 0026 and 0027 invariant queries now snapshot the complete rows of pre-existing application and
QA tables. They exclude tables introduced by the pending migration group because the same query
must execute both before and after that group. Separate structure gates continue checking the new
tables, function bodies, ownership and grants. The deployment parser remains strict.

The production checkout rehearsal executes each actual invariant SQL file before and after the
migration group, passes both outputs through the production parser, and compares the serialized
snapshots. This catches contract errors that source-text assertions alone cannot establish. Exact
comparison is appropriate in a disposable database with no concurrent clients. Production row
movement can be legitimate; this rehearsal does not change the production comparison policy.

Verification includes 76 deployment unit tests and the real PostgreSQL production checkout
rehearsal, including both snapshot parses/comparisons and payment/review ledger SQL tests. This
establishes the output and preservation contract in the disposable environment; hosted migration
application still requires its protected plan, approval and closing verification.

When adding another invariant, test its emitted result with `parseRowCounts`, not only whether its
SQL runs. Keep the query valid at the baseline before all migrations in its group. Do not weaken the
parser or substitute a structural issue array to get a deployment through.

Relevant files:

- `scripts/backend/deploy/deploy.test.mjs`
- `.github/workflows/supabase-production-checkout-rehearsal.yml`
- The 0026 and 0027 invariant queries under `scripts/backend/deploy/verify/`
