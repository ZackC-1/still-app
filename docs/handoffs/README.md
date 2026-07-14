# Cross-agent handoffs

Handoffs preserve temporary execution state when unfinished work must move between Claude Code,
Codex Personal, Codex Work, or a later session. They are not permanent project knowledge.

Create a handoff only when another agent must resume work that cannot be completed in the current
session. Use one file per transfer:

```text
YYYY-MM-DD-HHMM-<source>-<topic>.md
```

Examples:

```text
2026-07-14-1530-codex-personal-firefox-review.md
2026-07-15-0915-claude-entitlement-debug.md
```

Start from [`_template.md`](_template.md).

## Required handoff facts

- Repository, worktree, branch, HEAD commit, and remote relationship.
- Dirty or untracked files and who owns them.
- What is complete and what remains.
- Decisions made and evidence supporting them.
- Commands already run and their results.
- Exact next safe action.
- External state that was directly verified, including when it was checked.
- Blockers or permissions the receiving agent cannot infer.

Never include a secret, private key, access token, customer record, or raw credential. Point to the
approved secret-management location by variable name only.

## Receiving a handoff

The receiving agent must verify Git state, referenced files, test claims, and time-sensitive external
status before acting. A handoff is evidence from a previous session, not higher authority than the
current repository or live system.

## Closing a handoff

After merge, release, cancellation, or supersession:

1. Promote reusable lessons to `docs/solutions/`.
2. Update the relevant current plan or release runbook.
3. Delete the handoff, or move it to `docs/archive/` only when historical traceability is valuable.

Do not maintain a singleton `current.md`; it becomes a merge-conflict hotspot for concurrent agents.
