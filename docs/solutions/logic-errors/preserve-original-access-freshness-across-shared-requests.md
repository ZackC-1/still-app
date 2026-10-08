---
title: Preserve the original access deadline across shared requests
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: Multiple consumers receive a cached or shared observation with a relative freshness interval
date: 2026-10-03
last_updated: 2026-10-07
status: active
tags: [entitlement, cache, async, clock, expiry]
---

# Preserve the original access deadline across shared requests

An access observation with 30 milliseconds of freshness started at wall time 1000. A second cache
joined its delayed broker request at 1028, and both received the same relative interval at 1029.
The first cache stopped returning purchased access at the original deadline, 1030. The joining cache
added the interval to its own start and continued returning purchased access until 1058.

The consuming cache already captured its request start. The problem was the broker adapter sharing
a response earned by an earlier request. A relative interval cannot be transferred to a later
request and restarted there.

## Keep coalescing at the authority boundary

[ChromeEntitlementAdapter](../../../packages/core/src/entitlement/chrome-adapter.ts) shares its
`observeBenefits()` in-flight promise only when the instance
owns background authority. Page broker calls each retain their own bounded request, cancellation
signal and start time. The background can still coalesce proof verification and storage work.
The existing wire format and the consuming cache's request-start deadline remain unchanged.

A separate boundary involved cached returns. Checking the clock twice for cache eligibility, then
reading it again to compute the remaining interval, could cross the deadline. For a deadline of
1030, reads of 1029, 1029 and 1030 passed the guard but produced a zero interval. Snapshot parsing
then threw inside the argument to `Promise.resolve()`, before a promise existed. Consumer recovery
and the runtime failure reply could not handle that synchronous exception.

Capture one clock value for both cached eligibility and the remaining interval. An expired sample
falls through to a fresh observation; consumers still check freshness when the promise completes.

## Verification

The regressions in [consumer.test.ts](../../../packages/core/src/entitlement/__tests__/consumer.test.ts)
use signed synthetic proof vectors, the maintained background router, real cache instances and
controlled transport delivery. They reproduce the staggered-consumer deadline and advancing-clock
exception before the fix. Restoring either old boundary makes its regression fail again.

Companion tests exercise successful watched expiry with another valid account-bound right and
compose actual persistence and transport delay. That composed delay can conservatively withhold
access before the true signed deadline; this change prevents renewal and does not eliminate that
early hold. Provider readiness and physical-device behavior require their own evidence.

Keep lifecycle ownership alongside these timing checks:
[invalidate delayed work by session lifecycle](invalidate-sync-work-by-session-lifecycle.md).

## Capture conclusive absence with its expiry

A conclusive no-right reconciliation has its own sixty-second observation window. If a benefit
read captures `absent` at 59,950 milliseconds but samples the reconciler deadline only after a
slow storage write, the deadline can have expired or a newer reconciliation can have cleared the
last observation. Replacing that missing deadline with a new sixty-second projection renews the
old absence and can show an expired purchase offer.

Capture `evidenceDeadline` alongside `evidenceStatus` in the trusted host context. Carry that exact
value through queued storage, crypto and native reads; cap the returned and cached projection by
it when the read finishes. Explicit `absent` with a null captured deadline is already expired,
including when the expiry millisecond falls between synchronous clock samples. Snapshot-only
invalidation prevents an older read from replacing a newer projection without aborting its caller.

The two long-read/reset regressions in
[chrome-account-access.test.ts](../../../packages/core/src/entitlement/__tests__/chrome-account-access.test.ts)
failed before this repair and passed afterward. A third regression rejects the synchronous
absent/null boundary. All 53 focused account-writer, adapter and response-parser tests passed.
These checks concern local freshness and UI truth; they do not establish payment-provider or
physical-device behavior.
