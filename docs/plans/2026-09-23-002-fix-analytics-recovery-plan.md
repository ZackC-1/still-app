---
title: Preserve deletion intent and complete analytics recovery
type: fix
date: 2026-09-23
origin: PR 200 verification at d8f43fb
---

# Preserve deletion intent and complete analytics recovery

## Goal

Close the six verified review findings in PR #200 without another analytics architecture rewrite.
Keep one serialized client, one persisted account state, and the existing private queue. Analytics
must remain optional, independent of blocking and sync, quiet in background contexts, and limited
to ADR 0004's closed event schema. Preserve all settled owner decisions in the original analytics
plan. Local implementation and new commits are authorized; merging, deployment and portal changes
are outside this work.

## Design decisions

- A newer account answer may supersede a failed account answer, but never an unfinished forget.
  Keep a single outstanding forget obligation alongside the pending confirmation. Resolve it into
  the existing durable `forgotten` list before replacing the stored account. Update pending work
  only inside the operation chain, so a flush cannot execute a future confirmation out of order.
- A stale flush returns before doing recovery work. Network entry keeps its final cancellation
  check. These checks protect different boundaries, not duplicate implementations of one rule.
- Confirmation is complete only after attribution succeeds. Make attribution return a success
  result (including failed reads/writes and acknowledged-but-unpersisted writes), and retain the
  pending ask until that result succeeds. A flush retries the same operation; no new retry loop,
  background service, transaction framework, or storage migration is needed.
- An account confirmation request invalidates external server-attach work immediately. Keep the
  existing generation/epoch stamp and check confirmed state after awaited reads and before marking
  completion. The server still derives the email and account from its authenticated session.
- Pending install evidence represents both Chrome/Firefox milestones. Clear it only after both
  `installed` and `setup_completed` are queued. Preserve event-before-marker ordering and its
  documented duplicate-on-crash tradeoff.
- Queue append/removal must not overwrite an unreadable queue with an empty default. Reuse the
  existing nullable queue reader; keep ordinary inspection helpers separate from mutations.

## Implementation units

### U1 — Client recovery and deletion ordering

Files: `packages/core/src/analytics/client.ts`,
`packages/core/src/analytics/__tests__/races.test.ts`.

Add gated regressions for failed forget followed by another account, a cancelled flush ahead of
forget/identify, attribution failing during confirmation and during retry, and an unreadable queue
append. Repair the shared client once. Preserve quiet timestamps, immutable event attribution,
storage-refusal behavior, consent checks, queue bounds and all existing deletion tests.

Done when those regressions and the earlier C/D reproductions pass; no failed confirmation permits
an event under the previous account or loses the outstanding forget within the running client.
The existing durable drop still survives restarts once its state write succeeds. No claim is made
that an operation can survive process termination before storage accepts any record of it.

### U2 — Host completion and external attach

Files: `packages/core/src/analytics/extension-host.ts`, `packages/core/src/analytics/apple-app.ts`,
`packages/core/src/analytics/__tests__/races.test.ts`,
`packages/core/src/analytics/__tests__/apple-app.test.ts`.

Add a paused-final-consent attach regression, completion-marker race coverage, Chrome/Firefox
setup-failure recovery including restart, and the surviving null-state marker mutation regression.
Use the existing account stamp and pending-install record rather than adding parallel mechanisms.
Apple launch, ordinary UI use and foreground return retry the existing server attach after a transient
confirmation or network failure; its per-account completion marker suppresses successful repeats.

Done when the original E3/E16/E14 checks pass, account switches invalidate stale attach work, and
both install milestones can recover without duplication after an ordinary successful run.

### U3 — Verification, simplification and documentation

Files: the original analytics plan's Progress section, ADR 0004, the PostHog release runbook, and
`docs/solutions/design-patterns/fence-cancellations-when-asked-and-make-cross-store-intents-durable.md`.

Review the final diff for redundant state and duplicated safeguards. Update the four client rules
and documentation to reflect the implemented guarantees and actual test evidence. Keep the known
unbounded page-to-background window and physical/live validation limits explicit. Use new commits
on `feat/usage-analytics` so reviewers can compare the repair to d8f43fb.

## Verification contract

- Promote the six failing gated assertions (four behavioral defects) into repository regressions;
  prove they fail on the starting source before fixing it.
- Re-run the independent E suite and earlier A/B/C/D suites from temporary files against repository
  source. Mutation-check retained/new guards, including the prior surviving marker guard; report
  real failures, not tool-loading or compilation errors.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, Playwright fixtures, Deno tests/lint/check,
  StillKit Swift tests, and both unsigned Xcode schemes. Run extension-producing builds sequentially.
  Rerun any timed-out fixture alone and record whether it passes.
- Review client, Chrome/Firefox, Safari and Apple call paths against the settled privacy and product
  contract. Builds use a dummy analytics key and invalid ingestion host; tests mock requests.
- Do not claim perfect end-user behavior from local tests. Physical devices, browser suspension,
  live PostHog ingestion/deletion and portal settings remain release validation items.

## Plan review

The review's gated reproductions establish scope and failure boundaries. The smallest correction
is an ordered forget obligation plus completion-aware confirmation, using existing persistence and
serialization. Storage failure and superseding confirmation are the primary adversarial scenarios;
quiet work, off/on sharing, account deletion deadlines, restart and marker failure are regression
boundaries. No unsettled product decision or new dependency is required.
