---
title: Fence a cancellation when it is asked for, and record a cross-store intent before acting on it
category: design-patterns
problem_type: design_pattern
track: knowledge
module: packages/core/src/analytics
tags: [analytics, concurrency, serialized-queue, cancellation, deletion, privacy, indexeddb, mutation-testing]
applies_when: A serialized client (one operation at a time) must stop work that was already queued, or must apply one change across two stores that can fail independently
date: 2026-09-23
status: active
---

# Fence a cancellation when it is asked for, and record a cross-store intent before acting on it

## Context

The analytics client (`packages/core/src/analytics/client.ts`) runs every operation one at a time
through a promise chain. Deleting an account must guarantee that nothing queued under the account
is sent after the server deletes its PostHog person, or the person is recreated. Eight review rounds
kept finding a new interleaving in this one path. The last three (Codex, 2026-09-23, at `6ab3f8c`)
were:

- Two flushes queued; the deletion aborted the first, but the second started with the already
  bumped cancellation epoch and sent the account's events after the controller's 5 s wait ended.
- IndexedDB refused the queue purge; the account was cleared anyway, and after a restart nothing
  knew a purge was still owed, so the events went out under the deleted account.
- A deletion that failed after a sign-out re-identified the signed-out account, because the
  post-deletion guard checked the revision only when a user was present.

## Root causes

1. **The fence was taken at execution time, not request time.** Each flush read the cancellation
   epoch when its turn came. Anything queued before the cancellation but started after it saw the
   new epoch and ran. Only `reset()` cancelled; the hosts' direct `confirm(null, {forget})` calls
   never did.
2. **The intent lived in one store and the data in another.** The account (extension local storage)
   and the queue (IndexedDB) are separate stores that fail independently. Clearing the account
   after a best-effort purge left no record that a purge was owed.
3. **Asymmetric guards.** The pre-deletion guard required the same revision *and* the same user;
   the post-deletion guards checked the revision only when a user was present, so "signed out"
   slipped through.

The verification pass at `2d8129f` then found the same two shapes one level down: the opt-out
checked its epoch, then awaited two more reads with nothing re-checked before its request; and a
state-store read that threw was answered with an empty state, which hid the owed drop and let the
next writer overwrite the account and the record of the debt.

## Solution

- **Capture cancellation state synchronously, before entering the queue, and check it last, inside
  the function that sends.** `flush()` and `sendOptOut()` read the epoch at call time; `cancel()`
  bumps it synchronously; any queued operation compares at its turn and sends nothing if a
  cancellation overtook it. The cancel moved into `confirm()` itself so every host path (extension
  `onStart(null)`, Safari's account re-read, the Apple app's `accountAbsent`) is fenced, not only
  `reset()`. `post()` takes the epoch its caller was asked under and refuses at entry, so the check
  sits after every awaited read a caller does, with nothing awaited between it and the network.
  An early check in the caller is then redundant, and was removed rather than kept untestable.
- **Record the intent durably before acting, then verify.** The account is appended to a
  `forgotten` list in the state store *before* the queue drop. The drop is verified by re-reading
  the queue (a refused read is `null`, never "empty"; a write that is acknowledged but not kept is
  caught by the reread). `flush()` refuses to send while the list is non-empty, and every
  `confirm()` retries the drop, so a refused write only delays the drop to a later confirmation or
  flush, in that process or the next, whoever signs in next.
- **Unreadable is not empty.** `read()` returns `null` when the state store throws, and every
  reader fails closed: nothing is sent, nothing is written on top of a state that was never read,
  and a forget that cannot even name its account blocks the process (the next one is asked again).
  Substituting an empty default for a failed read is how a durable record gets both overlooked and
  overwritten.
- **Make guards symmetric.** Re-identify after a failed deletion only when both the revision and the
  user match the values captured when the deletion was asked; signing out resets the delete flow.

## Why it works, and where it does not apply

The serialized chain guarantees order, not freshness: an operation queued early runs late with a
view of the world from when it started. Anything that must "stop everything from now on" has to be
observable to operations that are already waiting, which means a value captured when they were
asked, compared when they run. The same reasoning applies to any queued worker with a kill switch.

Recording the intent in the store that is known to work (the small local store) before touching
the one that can refuse (IndexedDB) is the two-store version of write-ahead logging. It does not
apply when both writes go to one transactional store; use the transaction instead.

The residual window is the process boundary: the popup asks the background to forget over a runtime
message, and the controller stops waiting after 5 s. That is documented in the runbook's weekly
check, not claimed away.

## Verification

- `packages/core/src/analytics/__tests__/races.test.ts`, "forgetting an account (it was deleted)":
  a queued flush after the deadline, a host's direct forget mid-batch, a refused drop in the same
  process and across a restart (next confirmation `null` or another account), a refused queue read,
  a queue write acknowledged but not kept, an unreadable state store (nothing sent, nothing
  overwritten), a forget on unreadable state (process blocked, next start asked again), an opt-out
  overtaken by a forget before and during its own reads, and a forget during a flush's queue read.
  "unconfirmed accounts": a seeded, previously attributed queue is held.
- `packages/core/src/ui/__tests__/controller-analytics.test.ts`: a deletion that fails after a
  sign-out never re-identifies and leaves the flow idle.
- Mutation pass (sixteen mutations: each fence, the request-entry check, the durable record, the
  verification reread, the null-read and null-state handling, the write-on-unread guard, the
  seeded-queue guard, both controller guards): every one fails at least one test. Two guards that
  no mutation could expose (a second drop gate inside `confirm`, an early epoch check in the
  opt-out) were removed rather than kept untestable.
- Full gate green: lint, typecheck, all JS tests across core, Safari and Chromium, build, 51
  Playwright fixtures; Codex's independent pass at `2d8129f` also ran Deno (151) and Swift (142).

## Prevention

- When adding an operation to a serialized client, ask: if a cancellation lands while this is
  waiting its turn, what does it compare against? If the answer is "state read when it runs", it is
  not fenced. Then ask where the *last* check sits: if anything is awaited between it and the
  request, it is not the last check. Put it inside the function that sends.
- A `catch` that returns a default value turns "I could not read" into "there is nothing". For
  state that records an obligation, return `null` and make every reader fail closed.
- When one logical change touches two stores, write the intent to the reliable store first, verify
  the other, and gate the effect on the verified state.
- When writing a guard after an `await`, copy the guard from before the `await`; a shorter guard
  is a different guard.
- Mutation-check every new protection before claiming it: remove it and watch a test fail.

Related: [ADR 0004](../../adr/0004-first-party-usage-analytics.md),
[plan 2026-09-23-001](../../plans/2026-09-23-001-feat-usage-analytics-plan.md),
[invalidate sync work by session lifecycle](../logic-errors/invalidate-sync-work-by-session-lifecycle.md).
