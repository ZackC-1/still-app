---
title: QA runtime reliability - Plan
type: fix
date: 2026-10-14
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# QA runtime reliability - Plan

## Goal Capsule

**Objective:** Settings changes reach another signed-in browser reliably, and turning Still off leaves the page quiet.
**Means:** Bound database connections in the existing writer factory and stop content-owned entitlement observation while its service is off.
**Source:** Owner-authorized autonomous QA of candidate 2.1.1.357; engineering delta handoff dated October 14. This follow-up starts at main d984146c. The frozen candidate remains unchanged.

## Product Contract

The original two-browser 30-second check failed. A longer diagnostic delivered all 13 cases but took 5.4–71 seconds. Both reads and writes intermittently returned HTTP 500. Approved aggregate diagnostics found SQLSTATE 53300 (reserved connection slots) alongside rate_limiter_unavailable. This establishes exhausted database capacity, not which client owns all connections.

The 30-minute sustained test completed 161 rounds with four failures: seven content callbacks while Off, zero Off DOM writes. A focused 125-second reproduction attributes two callbacks to the entitlement refresh timer.

- **R1:** Recover reliable settings delivery without bypassing authentication, account isolation, transactional writes, or rate limiting. Preserve existing error privacy and fail-closed behavior.
- **R2:** A hydrated global-Off or current-service-Off content script stops recurring entitlement work. Re-enabling restores free blocking immediately and paid effects only from a fresh authority observation.
- **R3:** Preserve account/expiry invalidation, stop cleanup, and resistance to late asynchronous results across Off/On changes.
- **R4:** Validate a distinct successor build; retain the original failure evidence and frozen artifacts. Eventual delivery under a relaxed timeout is diagnostic evidence, not closure of the original failure.

No pricing, purchase, schema, role/grant, credential, database capacity setting, or user-data changes are part of implementation. Hosted deployment requires its existing approval gate after the exact diff and checks are ready. Read-only error diagnostics remain authorized with categories/counts/timestamps only.

## Planning Contract

### Decisions and rationale

- **KTD1 (R1):** Use the existing createWriterSql factory with a one-connection per-client cap and a 20-second idle release. Preserve prepare:false and existing transaction boundaries. The present driver defaults permit ten connections per instance and retain idle connections. This bounds each client's footprint; serial queries may queue, so existing settings transaction tests and concurrent driver behavior must pass. Supabase recommends small client pools for serverless workloads: [serverless drivers](https://supabase.com/docs/guides/database/connecting-to-postgres/serverless-drivers), [connection limits](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits). Changing connection endpoints or raising server limits is outside this change.
- **KTD2 (R2–R3):** Content orchestration owns whether its entitlement cache watches. Use the existing watch cleanup and refresh lifecycle rather than add another timer/scheduler. Determine activity from committed global and service settings, not effective paid features (which may be held while checking). On resumption, invalidate cached access before paid effects can apply. A result begun before Off must not resurrect protection or a timer.
- **KTD3 (R4):** Source preparation and local/CI verification precede any hosted rollout. Deploy the sandbox functions through their protected workflow first if supported. Recheck function/database error aggregates and original peer scenario; unresolved capacity errors keep R1 open. No connection termination or resource upgrade is inferred from diagnostic permission.

### Lifecycle sketch

Hydrated On -> observe authority and apply committed access. Committed Off -> detach observation, abort pending work, cancel timer. Off -> On -> hold stale paid access, attach observation, request fresh access; free blocking applies immediately. Stop -> release all content-owned subscriptions/timers, ignore late results.

### Risks and confidence

KTD1 is a bounded mitigation, not proof that these pools caused all exhaustion. An unchanged hosted error rate falsifies sufficiency and requires further approved diagnostics. Max-one must not introduce a nested query deadlock: test real settings transactions and inspect their use of the transaction handle. KTD2 must cover missed account changes and pending observations, rather than just cancel the timer.

Confidence review: requirements/context each 0 gaps; technical decisions, implementation units, system impact, and operational risks each 1 critical-section point after the above evidence and rollout limits; no section reaches the 2-point research threshold. No new product decision is deferred. Deployment readiness remains an observed operational gate.

## Implementation Units

### U1 — Bound edge database connection retention (R1)

Files: `supabase/functions/_shared/pg-store.ts`, relevant driver tests in `supabase/functions/_shared/pg-store.test.ts` and `supabase/tests/`, existing disposable backend rehearsal wiring if needed.

Use the shared factory, no new client abstraction. Characterize concurrent queries and transaction rollback through a disposable database or protocol-level test. Verify one simultaneous connection, eventual completion of queued work, and idle release/reconnection. Keep existing missing-user classification and rate-limiter privacy tests. Real SQL integration runs only in the existing disposable CI/rehearsal lane, never against owner data.

### U2 — Suspend content entitlement work while Off (R2–R3)

Files: `packages/core/src/content/index.ts`, `packages/core/src/entitlement/cache.ts` only if its existing lifecycle needs strengthening, and corresponding content/entitlement tests.

Add failing regressions before implementation. Cover initial Off, On->Off with a pending read, more than two refresh intervals Off, current-service Off with another service On, and Off->On after a missed revocation. Assert restored free blocking, held paid effects until fresh resolution, and no timer resurrection after stop. Preserve legacy behavior and other cache consumers.

### U3 — Verify and deliver successor evidence (R4)

Depends on U1/U2. Remove temporary attribution hooks from shipping changes. Run repository gates and focused Deno/transaction checks; review the final diff. Build a distinct candidate using the release runbook, then rerun the unchanged sustained gates and the original peer delivery test after the approved backend rollout. Record verification in the task tracker and a report beside this plan; document solved reusable lessons only after proof.

## Verification Contract

- U1: driver concurrency/idle tests, existing handler/privacy tests, disposable real SQL settings/rate-limit tests. No swallowed database errors or increased allowed traffic.
- U2: focused fake-clock lifecycle tests, content/entitlement suites, lint/typecheck/build, fixture browser checks. The sustained 30-minute zero-Off-callback contract remains unchanged.
- U3: original 30-second two-peer checks, simultaneous/rapid edits, reload persistence and baseline restoration. Confirm hosted policy revision 7 and visible Pro offer without a purchase. Preserve logs of failures as well as passes. Record unavailable device/platform checks explicitly.

## Definition of Done

The reviewed source passes relevant local and CI checks; a new candidate passes the unchanged Off workload; hosted rollout and peer verification prove R1 or leave it explicitly open. Frozen .357 hashes remain intact, QA settings are restored, and no production or payment change exceeds owner authorization.
