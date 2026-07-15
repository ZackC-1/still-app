# Still agent instructions

These instructions apply to every coding agent working in this repository. Claude Code, Codex
Personal, and Codex Work are separate runtimes, but they share the repository as their durable
Compound Engineering brain.

## Start every task here

1. Read [`STRATEGY.md`](STRATEGY.md) for product direction and non-negotiable product truths.
2. Read [`docs/README.md`](docs/README.md) and the relevant architecture, specification, ADR, or
   release runbook for the task.
3. Search [`docs/solutions/`](docs/solutions/) for prior decisions, failed approaches, and reusable
   fixes before investigating from scratch.
4. If resuming another agent's unfinished work, read the referenced file in
   [`docs/handoffs/`](docs/handoffs/) and verify its claims against Git and the current code.
5. Inspect `git status --short --branch`. Preserve unrelated changes and never assume an uncommitted
   file is disposable.

The complete shared-brain workflow is documented in
[`docs/SHARED-BRAIN.md`](docs/SHARED-BRAIN.md).

## CodeGraph: query structure before reading source

This project has a CodeGraph MCP server backed by a tree-sitter knowledge graph.

For questions about how code works, where a symbol is defined, what calls what, or what a change
would affect, the first tool call must be `codegraph_context` or `codegraph_search`. Prefer:

| Question | Tool |
|---|---|
| Focused context for a task or subsystem | `codegraph_context` |
| Find a symbol or definition | `codegraph_search` |
| Find callers or callees | `codegraph_callers` / `codegraph_callees` |
| Estimate change impact | `codegraph_impact` |
| Read a surfaced symbol's source | `codegraph_explore` |
| List indexed files or check health | `codegraph_files` / `codegraph_status` |

Do not repeat CodeGraph work with a grep-and-read loop. Use `rg` and direct file reads for literal
text, documentation, generated artifacts, or a specific file already surfaced by the graph.

For architecture or trace questions, answer directly with a small graph sequence: start with
`codegraph_context`, then use one `codegraph_explore` call for the surfaced symbols when source is
needed. Do not delegate repository exploration to a subagent, chain `codegraph_search` and repeated
`codegraph_node` calls, or loop over files that one graph query can return. Trust the parsed graph
results. After writing code, allow for the index watcher's short debounce before querying changed
symbols again.

If `.codegraph/` is absent, stop and ask: "I notice this project doesn't have CodeGraph initialized.
Want me to run `codegraph init -i` to build the index?"

## Compound Engineering loop

Use the same loop in every harness; only the invocation syntax differs.

| Purpose | Claude Code | Codex |
|---|---|---|
| Establish project tooling | `/ce-setup` | `$ce-setup` |
| Explore a direction | `/ce-ideate` | `$ce-ideate` |
| Clarify requirements | `/ce-brainstorm` | `$ce-brainstorm` |
| Produce an implementation plan | `/ce-plan` | `$ce-plan` |
| Execute an approved plan | `/ce-work` | `$ce-work` |
| Capture a durable learning | `/ce-compound` | `$ce-compound` |
| Refresh stale solution docs | `/ce-compound-refresh` | `$ce-compound-refresh` |
| Search supported local session history | `/ce-sessions` | `$ce-sessions` |

The normal delivery loop is:

```text
strategy/specification -> brainstorm when needed -> plan -> work -> verify -> compound
```

Do not invoke every skill mechanically. Use only the stages that add value for the task, but always
perform the read-first check and capture reusable learning after non-trivial work.

## Durable brain contract

Repository files, not chat transcripts, are the source of shared memory.

- `STRATEGY.md` records durable product direction and outcome priorities.
- `docs/ARCHITECTURE.md` records the current runtime map and module boundaries.
- `docs/adr/` records accepted architectural decisions.
- `docs/solutions/` records verified, reusable learnings from solved problems.
- `docs/plans/` records bounded implementation intent and verification scenarios.
- `docs/handoffs/` records temporary state when work must move between agents or sessions.
- `docs/release/` records operational store and deployment truth.

Before creating a solution document, check for overlap. Update an existing document when it covers
the same problem, root cause, and solution. Never put speculation, current status, secrets, or a raw
chat transcript in `docs/solutions/`.

When a non-trivial problem is solved, run the harness-appropriate `ce-compound` workflow or follow
[`docs/solutions/README.md`](docs/solutions/README.md) manually. Commit the resulting documentation
with the code that proves it whenever practical.

## Plans and handoffs

- Use a dated plan in `docs/plans/` for multi-file changes, migrations, or work with meaningful risk.
- Keep a plan's status and verification evidence current while it is active.
- Use `docs/handoffs/` only when another agent or future session must resume unfinished work.
- A handoff must name the branch, commit, dirty files, completed work, remaining work, verification,
  and blockers. Use [`docs/handoffs/_template.md`](docs/handoffs/_template.md).
- Delete or archive a handoff after its work is merged or superseded. Promote reusable lessons into
  `docs/solutions/`; do not let handoffs become a second permanent knowledge store.

## Multi-agent Git safety

- Give concurrent agents separate branches and, whenever possible, separate worktrees.
- Before starting, fetch and base new work on the current `origin/main`.
- Never reset, overwrite, delete, or reformat another agent's changes to make a task easier.
- Keep commits scoped and intentional. Do not commit local secrets, generated packages, build output,
  or unrelated edits.
- Merge through the protected-branch workflow. After a merge, update other worktrees with a safe
  fast-forward or an explicit rebase/merge appropriate to their state.
- When store review is pending, do not alter or resubmit a store artifact merely to synchronize Git.
  Follow the current release runbook and record portal-only changes in the operational handoff.

## Product truths that must remain consistent

- Free Still removes YouTube Shorts on supported web surfaces without an account.
- Still Pro is a one-time purchase that adds Instagram and Facebook Reels removal, TikTok website
  blocking, and cross-device settings sync on supported surfaces.
- Still Pro can be purchased on Apple platforms without an account (entitlement from the Apple
  receipt; App Review 5.1.1). One entitlement can be restored across supported surfaces when the
  user signs into the same Still account. Sign-in is required for sync and for Pro in
  Chrome/Firefox — not for the free tier or for Apple-platform purchase.
- Mobile support means websites opened in Safari. Still does not block short-form video inside native
  YouTube, Instagram, Facebook, or TikTok apps.
- Say "every supported surface," never "everywhere."
- Still does not collect browsing history. Host permissions remain limited to the four documented
  services and must never expand to `<all_urls>` without an explicit product and privacy review.
- Optimize first for qualified downloads, then for conversion to Still Pro without creating refund-
  causing ambiguity.

## Verification and completion

Run checks proportional to the change. The normal repository gates are:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright test --project=fixtures
```

Apple changes also require the relevant StillKit/Xcode checks and the human-gated device procedures
in `docs/release/`. Supabase changes require the relevant Deno checks, tests, migration review, and
deployment gates.

Do not claim completion without recording what was actually verified. If verification is impossible,
state exactly what remains and why.

## Secrets and external systems

- Never place credentials, tokens, private keys, customer data, or store secrets in plans, handoffs,
  solution docs, commits, or chat output.
- Treat App Store Connect, Chrome Web Store, Firefox AMO, RevenueCat, Supabase production, DNS, and
  payment changes as external state. Confirm scope before destructive or irreversible actions.
- Portal status is time-sensitive. Verify it directly before acting, then record only the minimum
  operational fact needed in the appropriate release document.
