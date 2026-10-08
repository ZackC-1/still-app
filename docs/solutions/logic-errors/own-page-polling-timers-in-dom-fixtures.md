---
title: Own page polling timers in DOM test fixtures
category: logic-errors
track: bug
problem_type: logic_error
module: packages/ext-chromium
applies_when: A DOM fixture mounts a real page controller with polling that outlives component unmount
date: 2026-10-07
status: active
tags: [vitest, jsdom, timers, cleanup, popup]
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

Related: [session lifecycle ownership](invalidate-sync-work-by-session-lifecycle.md) explains
why asynchronous account work also needs to retain the identity of the session that started it.
