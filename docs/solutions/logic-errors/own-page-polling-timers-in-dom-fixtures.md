---
title: Own page polling timers in DOM test fixtures
category: logic-errors
track: bug
problem_type: logic_error
module: packages/ext-chromium
applies_when: A DOM fixture mounts a real page controller with polling that outlives component unmount
date: 2026-10-07
last_updated: 2026-10-17
status: active
tags: [vitest, jsdom, timers, cleanup, popup, entitlement, flaky-test]
---

# Own page polling timers in DOM test fixtures

The Chromium popup suite passed every assertion but failed with an unhandled
`ReferenceError: document is not defined`. An account-status polling interval fired after Vitest
removed the fixture's DOM globals. Component unmount and DOM cleanup had completed, but the
page controller's polling timer was still alive.

`watchAccountStatus` in `packages/core/src/ui/account-status.ts` polls every two seconds.
The controller factory in `packages/core/src/ui/extension-setup.ts` treats its legacy watchers as
page lifetime work. Stopping a popup binding does not stop those watchers. The fixture repeatedly
imports the real popup entrypoint, so it must also close the timers owned by each simulated page.

The repair belongs in
`packages/ext-chromium/entrypoints/popup/__tests__/legacy-popup-mount.test.ts`.
Track the intervals created by the fixture's mounted page and clear those handles before removing
the DOM environment. Preserve the real controller, background transport, polling and durable-write
assertions. Do not clear unrelated timers or suppress unhandled errors to make the suite pass.

## Verification

The new regression mounts the real popup and confirms account-status polling while the page is
alive. After actual unmount and cleanup, advancing six seconds must produce no additional
account-status reads. An independently created interval must continue running, proving cleanup
does not cancel every timer.

Before the repair, account-status reads increased from two to five after page closure while the
unrelated interval ran four times. Removing only the owned-handle clear reproduced that failure.
Restoring the repair passed all 13 focused tests; the complete Chromium suite passed 44 files and
576 tests with no unhandled errors. The changed test passed ESLint and the package typecheck.

These are DOM fixture lifecycle checks. They do not certify browser process shutdown, native
devices, live account providers or signed builds. Production polling and account-revision guards
remain unchanged. A separate production lifecycle defect would need its own evidence and repair.

## Follow-up: the controller's own storage watchers (2026-10-17)

The same lifetime gap existed in production code for two more watchers. `createExtensionUiController`
started `cache.watch()` (settings) and `entitlement.watch()` (Still Pro access) but discarded their
stop functions, so `controller.dispose()` on page unmount left both running. The entitlement cache's
access timer (the ISS-0032 quick retry or the freshness refresh) kept firing after the page closed.

In `informational-pro-host.test.ts` every test stubs a new `chrome` global, so a timer left by the
free-sync sign-in test sent its `observeBenefits` into a later test's fixture. "keeps configured
legacy-host mode outside the informational destination" then saw an observation it never made.
It failed only on slow CI runners, where the timer landed inside that test instead of a tolerant one.
Instrumenting `EntitlementCache` with its creating test name showed every stray call came from a
cache created in the sign-in test that was still watching.

The repair registers both stop functions with `controller.addTeardown`, so `dispose()` ends them
with the page. The regression in `packages/core/src/ui/__tests__/access-recheck.paid-on.test.ts`
proves a live page keeps retrying, then that after dispose neither timers nor storage changes reach
the background or the controller. Under heavy CPU stress (60 runs, 16 parallel, 16 busy loops) the
file failed 14 of 60 runs before the repair and 0 of 60 after.

Rule: every watcher a page-lifetime factory starts must hand its stop function to the owner's
teardown. A test that counts background messages also catches stale callers from earlier tests,
so look for leaked lifetime work before loosening a count. An earlier fix (commit 9facf2cd) counted
observations relative to each invalidation; that remains right for retries within one live page.

Related: [session lifecycle ownership](invalidate-sync-work-by-session-lifecycle.md) explains
why asynchronous account work also needs to retain the identity of the session that started it.
