---
title: Content Off must stop entitlement observation without trusting stale grants on resume
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: A content script owns an entitlement cache with recurring refresh work
date: 2026-10-14
status: active
tags: [entitlement, content, lifecycle, performance]
---

Turning off DOM blocking does not stop an independent entitlement timer. A sustained trace attributed periodic Off callbacks to EntitlementCache's refresh timer even though DOM writes had stopped.

The content host now owns the watch lifetime according to committed global and service toggles. It keeps settings observation attached so On can wake it, and detaches entitlement observation while Off. Disabling only the free feature must not detach access checks: Pro extras may still be active.

On detachment, the content-only watch option holds cached paid grants, including independently protected grants, until a fresh authority observation. Free blocking resumes synchronously. Aborting alone is insufficient: a transport can ignore cancellation, so the cache also clears the current flight and ignores finalizers that no longer own it. Epoch checks reject late results.

Do not apply the paid-hold transition to every cache consumer. Existing popup tests caught a new signed-out `locked` to `verification_required` transition on cleanup. The option belongs to the content lifetime; ordinary UI watch cleanup retains its behavior.

Verification: `content/__tests__/format2-session.test.ts` first reproduced initial-Off refreshes, stale paid resume and old-flight reuse. Its final eleven tests cover both Off gates, 125-second quiet periods, purchased/protected resume, free-core-Off extras and late responses. Existing `entitlement/__tests__/consumer.test.ts`, `signed-out-access.test.ts` and Safari mobile content tests also pass. Paths are under `packages/core/src/`. Packaged sustained testing is a separate release gate.
