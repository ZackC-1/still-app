---
title: Close a recurring review loop by reproducing every finding, fixing the class, and mutation-checking each guard
date: 2026-09-23
category: conventions
track: knowledge
module: packages/core
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Successive review rounds keep finding a new race or edge case in the same code path"
  - "A reviewer reports an interleaving or failure-ordering bug in async, queued, or multi-store code"
  - "Claiming a set of guards is covered by tests before merge"
  - "A guard exists that no test fails without"
  - "Running mutation checks or Playwright fixtures alongside other builds in this repo"
symptoms:
  - "Each review round reports a 'new' race in the same deletion or recovery path"
  - "Per-finding patches pass their own test but the next round finds a sibling interleaving"
  - "A mutation run reports every mutant caught, including a baseline that never passed"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - testing_framework
  - tooling
  - documentation
tags: [code-review, race-conditions, mutation-testing, regression-tests, concurrency, vitest, review-loop, analytics]
status: active
---

# Close a recurring review loop by reproducing every finding, fixing the class, and mutation-checking each guard

## Context

PR #200 added first-party PostHog analytics to Still 2.1: the client in `packages/core/src/analytics/client.ts`,
the hosts in `extension-host.ts` and `apple-app.ts`, and the deletion flow in
`packages/core/src/ui/controller.svelte.ts`. It went through ten external review rounds, and every
round found one more interleaving in account deletion or storage recovery where a deleted account's
events could still leave, or where a storage failure quietly erased an obligation.

Each round had been answered with a patch at the call site the reviewer named, and the next round
found the same shape one level down. Commit 2d8129f fenced the flush; the next reviewer found that the
opt-out checked its epoch, awaited two more reads, and posted with nothing re-checked. The loop closed
only when the method changed: reproductions came before fixes, each fix covered a whole class of bug,
every protection had to survive a mutation check, and the docs stated the guarantee exactly. The PR
merged as 63841ac.

The design pattern that came out of this work (fence a cancellation when it is asked for, record a
cross-store intent durably) is documented in
[fence-cancellations-when-asked-and-make-cross-store-intents-durable](../design-patterns/fence-cancellations-when-asked-and-make-cross-store-intents-durable.md).
This document is about the method and the harness.

## Guidance

**1. Reproduce every finding against the real source before changing code.** Turn each reviewer
finding into a test that stops the code at the exact boundary where the race happens, usually a
storage read or the network request, then drive the interleaving by hand. A gate creates the
interleaving, never a timer; use fake timers only when a deadline is itself part of the scenario. The
helpers live in `packages/core/src/analytics/__tests__/races.test.ts`: `gate()`, a `pausable()`
memory store whose `pauseNextRead(key)` resolves once a read has started and returns the function
that releases it, `failNextRead(key, skip)` to make a later read throw once, `refusable()` to make a
store's reads or writes throw or to make a write report success without keeping anything, and
`recordingFetch()` to capture every batch that would have been sent.

Decide fault injection when a read starts, not when it ends. A helper that decided at the end failed
the read that was already paused, which was a path that already failed closed; two tests passed for the
wrong reason and a real mutant survived. Reproducing first also turns up bugs nobody reported: two extra
leaks surfaced this way before any fix went in.

**2. Name the class of bug and fix the class.** The ten rounds reduced to a handful of shapes. For each
finding, name its shape, then find every other place with that shape:

| Shape | Question to ask of every call site |
|---|---|
| Cancellation fence read when the work runs, not when it was asked for | What does this compare against if the cancel lands while it waits its turn? |
| Guard after an `await` shorter than the guard before it | Is the post-await guard a copy of the pre-await one? |
| Check, then await, then act, with no re-check where the request is made | Is anything awaited between the last check and the network call? |
| Failed read answered with an empty default | Does `catch` turn "could not read" into "nothing owed"? |
| Cross-store intent acted on before it is recorded durably | If the second store fails, does the intent survive a restart? |
| Marker written before the event it marks | Does a failure between the two repeat work, or lose it? |
| Failed state change leaves the old truth standing | Should the old value be withdrawn when the new one cannot be written? |

Put the fix where every caller passes through it. After 6af5397, `post()` takes the epoch its caller
was asked under and refuses at entry, so the flush and the opt-out get the same final check after all
their reads; the patch was not added only to the opt-out the reviewer named. This is the same move as
[mirror-fixes-across-parallel-paths](mirror-fixes-across-parallel-paths.md): route the siblings through
one hardened place.

**3. Keep reproductions as permanent regressions, then mutation-check every protection.** For each
guard, remove or weaken it and confirm at least one test fails. If no mutation can expose a guard,
delete the guard: an untestable guard is the next review finding. Three were removed for this reason
(a second drop gate inside `confirm`, an early epoch check in the opt-out made redundant by `post()`,
and a "block the process on an unreadable forget" guard). The mutant count grew with the protections,
from 10 to 32, and a count from an earlier round must never be carried forward as a claim about the
current source.

**4. Build the mutation harness outside the repository.** Early rounds used a scratch script that
edited repository files in place and restored them, which is fragile with other agents in the same
checkout. The cleaner harness keeps everything in a scratch directory: a script holding
`(name, module, old, new)` string replacements that asserts each `old` string exists (so drift fails
loudly) and writes each mutant module into `mutants/`, plus a temporary vitest config whose Vite
`load` hook serves the mutant copy for exactly one repository module id, chosen by an environment
variable. The baseline is the same command with the variable empty.

Two harness gotchas. The scratch directory needs a `node_modules` symlink to
`packages/core/node_modules`; without it `vitest/config` and the svelte plugin fail to resolve from the
config, the baseline fails, and every mutant looks "caught" because every run exits non-zero. Always
confirm the baseline exits 0 with the expected test count, and require each mutant log to show a real
failing test and no startup error. And run `pnpm exec playwright test --project=fixtures` only after
both Xcode builds finish: Xcode rewrites the Safari extension output the fixtures read, and an
overlapping run timed out once on a Safari popup fixture that passed alone.

**5. Write the guarantee exactly, including the windows it leaves open.** A reviewer will test the
documentation's claims against the code. State remaining gaps as limits, not recoveries: the
popup-to-background message hop during deletion is unbounded; a forget that never reached storage
cannot survive the process, and the next process drops the queued events only if it learns that
nobody is signed in.

## Why This Matters

Patching one finding at a time on concurrent, multi-store code never ends. Each patch closes one
interleaving while the same shape stays open at every sibling call site and one `await` further down,
so the reviewer is searching the code for you, one example per round. Reproducing first turns a claim
into a fact and finds the neighbouring bugs in the same pass. Fixing the class removes the shape
everywhere at once. Mutation-checking keeps the suite honest: it caught a helper that let tests pass
for the wrong reason and justified deleting guards that only looked protective. Exact documentation
stops the final round from being a documentation finding.

## When to Apply

- A PR has had two or more review rounds find a new variant of the same bug. That is the signal to
  stop patching and switch methods.
- Code that runs work through a serialized queue or promise chain and must honour cancellation,
  sign-out, deletion, or consent withdrawal.
- One logical change that spans two stores that can fail independently, such as extension local
  storage plus IndexedDB, or app state plus a server.
- Any privacy or deletion guarantee where "nothing leaves after X" must hold across storage failures,
  restarts, and slow networks.
- Before claiming a guard protects something: if you cannot write a mutation that a test catches, the
  claim is unproven.

## Examples

The pausable store from `races.test.ts`. The fault decision happens when a read begins, so a fault
armed while a read is paused targets the reads after it:

```ts
// inside pausable(): the store's get()
async get(k) {
  let fail = false;
  if (failing && failing.key === k) {          // decided when the read BEGINS
    if (failing.skip > 0) failing.skip -= 1;
    else { fail = true; failing = null; }
  }
  if (pause && pause.key === k) {
    const p = pause; pause = null;
    p.reached();
    await p.gate.opened;                       // held until the test opens it
  }
  if (fail) throw new Error("unreadable once");
  return structuredClone(data[k]);
},
```

A gated reproduction, releasing the paused read by hand; and a fault armed during a pause, which
skips the two reads that queue the event and fails the third:

```ts
it("an opt-out asked for before the forget never names the account", async () => {
  const rec = recordingFetch();
  const { client, store } = makeClient({ fetch: rec.fetch });
  await client.identify(U1);
  const reached = store.pauseNextRead(QUEUE_KEY); // inside the opt-out, before its request
  const optingOut = client.sendOptOut();
  const open = await reached;
  const forgetting = client.confirm(null, { forget: true });
  open();
  await Promise.all([optingOut, forgetting]);
  expect(JSON.stringify(rec.events())).not.toContain(U1);
});

const reached = backing.pauseNextRead(STATE_KEY); // the marker check
const tracking = client.trackDaily("active", "active", {});
const open = await reached;
backing.failNextRead(STATE_KEY, 2);              // past the two reads that queue the event, the re-read fails
open();
await tracking;
```

Per-finding patch versus class fix (6af5397). Before, the flush re-checked the epoch around `post()`
while the opt-out checked early and then awaited two reads with no re-check before its request:

```ts
// sendOptOut (before)
if (!this.configured || this.blocked || !this.confirmed || epoch !== this.epoch) return;
const identity = await this.identity();
const state = await this.read();
await this.post([event], abort?.signal);       // leak: a forget landed during the reads
```

After, the final check lives in the one function that talks to the network, and every caller passes
the epoch it was asked under:

```ts
private async post(batch, epoch: number, signal?: AbortSignal): Promise<"done" | "retry"> {
  if (epoch !== this.epoch) return "retry";    // last check before the network, synchronous
  ...
}

// sendOptOut (after): its early epoch check was removed, since no mutation could expose it
await this.post([event], epoch, abort?.signal);
```

The mutants that prove it: remove the check in `post()`, and pass `this.epoch` instead of the requested
epoch. Both fail tests.

The scratch mutation config, `mutations.config.mts`, in a scratch directory that also holds a
`mutants/` folder and a `node_modules` symlink to `packages/core/node_modules`. The mutant file is
resolved next to the config, so nothing depends on an exported variable:

```ts
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import fs from "node:fs";

const core = "/path/to/still-app/packages/core";
const paths = { client: `${core}/src/analytics/client.ts`, host: `${core}/src/analytics/extension-host.ts` };
export default defineConfig({
  plugins: [
    {
      name: "review-only-mutation",
      enforce: "pre",
      load(id) {
        const kind = process.env.REVIEW_MUTANT;                       // which repository module to replace
        if (kind && id === paths[kind]) return fs.readFileSync(new URL(`./mutants/${kind}.ts`, import.meta.url), "utf8");
      },
    },
    svelte(),
  ],
  test: { root: core, include: ["src/analytics/__tests__/races.test.ts", "src/ui/__tests__/controller-analytics.test.ts"], environment: "node" },
});
```

One mutation is one run: a script applies a single `old -> new` replacement to a copy of the module,
writes it to `mutants/<module>.ts`, runs the suite with that module swapped in, and names the log after
the mutation, not the module. The baseline is the same command with `REVIEW_MUTANT` unset:

```bash
cd "$SCRATCH" && ln -s /path/to/still-app/packages/core/node_modules node_modules
pnpm --filter @still/core exec vitest run --config "$SCRATCH/mutations.config.mts" --reporter=verbose > mutation-baseline.log 2>&1
# for each mutation: write mutants/client.ts (the module with that one replacement applied), then
REVIEW_MUTANT=client pnpm --filter @still/core exec vitest run --config "$SCRATCH/mutations.config.mts" --reporter=verbose > mutation-11_post_epoch.log 2>&1
```

The audit that must print nothing. Check the baseline by hand as well: it must exit 0 and report the
expected number of passing tests, since a baseline that ran zero tests would pass this audit.

```bash
cd "$SCRATCH" && for f in mutation-[0-9]*.log; do
  [ -e "$f" ] || continue
  grep -qE "Startup Error|failed to load config" "$f" && echo "HARNESS $f"
  grep -q " × " "$f" || echo "SURVIVED $f"
done
```

## Related

- [fence-cancellations-when-asked-and-make-cross-store-intents-durable](../design-patterns/fence-cancellations-when-asked-and-make-cross-store-intents-durable.md):
  the design pattern from the same work; its seven root-cause classes are the worked example above.
- [mirror-fixes-across-parallel-paths](mirror-fixes-across-parallel-paths.md): the earlier form of
  "fix the class" for teardown paths.
- [invalidate-sync-work-by-session-lifecycle](../logic-errors/invalidate-sync-work-by-session-lifecycle.md):
  an earlier use of mutation checks, with an in-place harness that this scratch-directory harness
  replaces.
- [codify-cross-platform-visual-contract-in-tests](codify-cross-platform-visual-contract-in-tests.md):
  the same rule that stale build output must never be what a fixture reads.
- Plans [2026-09-23-001](../../plans/2026-09-23-001-feat-usage-analytics-plan.md) (per-round record)
  and [2026-09-23-002](../../plans/2026-09-23-002-fix-analytics-recovery-plan.md); ADR 0004; PR #200.
