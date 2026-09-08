---
title: Isolate delayed sync operations by session lifecycle
status: review-ready
date: 2026-09-08
issue: 149
owner: Codex Astra
branch: fix/149-sync-lifecycle
---

# Sync lifecycle isolation

A delayed account response must never replace settings in a later session, including a later session
for the same account. Keep account adoption, storage epochs, retained identity, and paid flags unchanged.

Approved seams: real SyncService, SettingsCache, SupabaseBackendPort and extension session, controlled
synthetic auth/transport, watched storage, and the actual Swift store/bridge through its WKWebView adapter.

1. Reproduce the delayed A response after B adopts its account; retain settled-response control.
2. Invalidate response application and cleanup by originating lifecycle. Add vertical regressions for
   same-account return, A → B → A, rejection, pending teardown, queued work, and reconnect reads.
3. Keep healthy seeding/adoption/offline/peer behavior covered by focused existing tests.
4. Remove production protection temporarily, prove regression failure, restore identical bytes.
5. Run core sync/storage/session, Safari App Group, typecheck and real StillKit checks; obtain independent
   standards/spec review. Final repository/artifact gates run on the coordinator's combined candidate.

## Verification

- Initial regression: 1 failed, 1 healthy control passed before the first response guard.
- Final focused regression files: 28 cases, including the real Swift bridge boundary.
- Full repository tests: core 635 passed / 39 existing skips, Safari 60 passed, Chromium 34 passed.
- Repository lint, all workspace typechecks, and unconfigured local builds passed.
- Playwright fixtures passed 40 tests; Chromium required execution outside the filesystem sandbox.
- Focused sync/storage/session selection passed 284 tests across 15 files.
- Actual StillKit Swift suite: 125 passed; Safari suite includes App Group arbitration coverage.
- Mutation: removing the write-response guard failed 7 cases; disabling lifecycle invalidation
  failed 27 cases and preserved the healthy control. Source bytes restored identically.
- Independent standards/spec review is coordinated before integration. Physical Apple device
  lifecycle, signed artifacts, and final combined-candidate certification remain separate release gates.

## References and boundaries

Specification: [issue 149](https://github.com/ZackC-1/still-app/issues/149).
Runtime context: [architecture](../ARCHITECTURE.md).
Reusable result: [session lifecycle isolation](../solutions/logic-errors/invalidate-sync-work-by-session-lifecycle.md).

The current release direction authorizes free blocking and optional sync; the paid strategy text
predates that decision. Both paid flags remain false. This change edits only the shared sync service
and focused tests/documentation. It does not alter account-wins rules, cache/Swift arbitration,
retained identity, dormant paid branches, dependencies, or production/store state.

Recovery is to revert this isolated issue commit before release; no migration or persisted schema
change is introduced. That restores the demonstrated stale-response defect, so a reverted candidate
must not be certified as satisfying issue 149.
