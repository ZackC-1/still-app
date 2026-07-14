# Shared Compound Engineering brain

This repository is the shared memory for Claude Code, Codex Personal, Codex Work, and human
maintainers. Each harness keeps its own runtime configuration and raw session history. Durable
knowledge becomes shared only when it is written to the repository and synchronized through Git.

## What is shared

| Layer | Location | Lifetime |
|---|---|---|
| Product direction | `STRATEGY.md` | Durable; changes deliberately. |
| Agent operating rules | `AGENTS.md` and `CLAUDE.md` | Durable; applies at task start. |
| Architecture decisions | `docs/ARCHITECTURE.md` and `docs/adr/` | Durable; updated with accepted design changes. |
| Solved-problem knowledge | `docs/solutions/` | Durable; maintained as code evolves. |
| Planned work | `docs/plans/` | Active until completed or superseded. |
| Cross-agent resumption state | `docs/handoffs/` | Temporary; removed or archived after integration. |
| Release truth | `docs/release/` | Operational and time-sensitive. |
| Raw session transcripts | Harness-specific home directories | Local evidence, not authoritative project memory. |

## The shared loop

```text
                 ┌──────────────────────────────────────────────┐
                 │ STRATEGY + specs + ADRs + existing solutions │
                 └──────────────────────┬───────────────────────┘
                                        ▼
                         brainstorm or plan when needed
                                        ▼
                              implement and verify
                                        ▼
                       capture reusable learning with
                              ce-compound
                                        ▼
                              docs/solutions/
                                        │
                                        └──────── feeds the next task
```

The important transition is from private context to repository evidence. A conclusion held only in
one Claude or Codex transcript is not part of the shared brain.

## Starting work

Every agent should:

1. Confirm the repository, branch, and worktree it is operating in.
2. Read `STRATEGY.md` and `docs/README.md`.
3. Read only the relevant current spec, architecture, ADR, release, and plan documents.
4. Search `docs/solutions/` before repeating investigation.
5. Read a handoff only when the task explicitly resumes it.
6. Create or update a plan if the work is multi-file, risky, externally coordinated, or difficult to
   verify in one pass.

## While working

- Keep verified facts separate from hypotheses.
- Record decisions in the active plan as they are made.
- Prefer tests and repository evidence over chat recollection.
- If another agent owns overlapping files, coordinate or use a separate worktree instead of racing.
- Keep portal-only or human-gated steps in the applicable release checklist or handoff.
- Never write secrets or private customer information into the shared brain.

## Finishing work

1. Run verification proportional to the change.
2. Update the active plan and relevant current documentation.
3. Run `/ce-compound` in Claude Code or `$ce-compound` in Codex for a reusable non-trivial learning.
4. Update an overlapping solution doc instead of creating a duplicate.
5. Commit documentation with its supporting code when practical.
6. If work remains, create a handoff from `docs/handoffs/_template.md`.
7. If nothing remains, do not create a handoff merely to summarize a completed chat.

## Session-history boundary

Compound Engineering's `ce-sessions` feature can search standard local Claude and Codex session
locations, but the current upstream discovery script does not automatically include Still's custom
`~/.codex-personal/sessions/` and `~/.codex-work/sessions/` profile paths.

Do not merge or symlink personal and work transcript directories merely to simulate memory. That can
blur profile boundaries and expose unrelated context. Instead:

- Promote valuable conclusions into `docs/solutions/`, ADRs, plans, or handoffs.
- Treat raw session search as optional supporting evidence.
- If cross-profile transcript search becomes necessary, add an explicit, reviewed discovery adapter
  that reads both directories without changing where either profile writes its sessions.

## Synchronization rules

- Git is the synchronization mechanism. A local uncommitted document is not shared.
- Concurrent agents should use separate worktrees and branches.
- Pull or fetch before creating a new branch, and integrate through the protected `main` workflow.
- Resolve documentation conflicts by preserving the newest verified fact and the relevant history,
  not by blindly choosing one agent's entire file.
- After merge, remove or archive completed handoffs and refresh any solution doc made stale by the
  change.

## Maintenance cadence

- Run a focused `ce-compound-refresh` when a refactor contradicts or supersedes a known solution.
- Review `docs/solutions/` before major releases for stale paths, duplicate guidance, and invalidated
  assumptions.
- Review `STRATEGY.md` only when product direction changes; do not update it for routine status.
- Keep current store status in release documents, not in strategy or agent instructions.
- Periodically confirm `AGENTS.md` and `CLAUDE.md` still point every harness at the same knowledge.
