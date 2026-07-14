# Implementation plans

Plans translate strategy and specifications into bounded work. They are useful for multi-file changes,
migrations, security-sensitive work, external coordination, or anything whose completion criteria
would otherwise be ambiguous.

Existing dated plans are retained as decision history. Do not assume an old plan is still active;
check its status, the current code, tests, ADRs, and release runbooks.

## Naming

Use:

```text
YYYY-MM-DD-NNN-<type>-<short-topic>.md
```

Examples:

```text
2026-07-14-001-fix-entitlement-refresh.md
2026-07-14-002-feat-review-prompt.md
```

## Plan contract

An active plan should contain:

- Status, owner/harness, branch, and creation date.
- Problem and intended outcome.
- In-scope and out-of-scope boundaries.
- Relevant strategy, specification, ADR, architecture, and solution references.
- Assumptions and decisions requiring confirmation.
- Ordered work units with concrete verification.
- User-visible acceptance scenarios.
- Risks, rollback or recovery approach, and external/human gates.
- Completion evidence and any resulting solution-document update.

Use [`_template.md`](_template.md) as a starting point.

## Lifecycle

1. Create the plan on the branch that will own the work.
2. Keep status and decisions current while implementing.
3. Record verification evidence rather than merely checking boxes.
4. Mark the plan completed or superseded when work stops.
5. Promote reusable learning to `docs/solutions/`.
6. Use a handoff only if unfinished state must move to another agent or session.

Plans describe intended work; tests and current implementation remain the evidence of actual behavior.
