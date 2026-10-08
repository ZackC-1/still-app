---
title: Publish visual capture success only after startup and cleanup complete
category: logic-errors
track: bug
problem_type: logic_error
module: tests/visual/reference
applies_when: A browser capture tool starts a local HTTP server and promises a success or failure receipt
date: 2026-10-07
status: active
tags:
  - visual-testing
  - error-handling
  - provenance
---

# Visual capture receipts must cover resource failures

A capture CLI could exit on an emitted HTTP server bind error without writing its promised failure receipt. A second error path awaited browser cleanup before server cleanup: if the browser close rejected, the server remained open. The tool also wrote its success receipt before cleanup, allowing a later cleanup failure to leave an apparently successful result.

`http.Server.listen()` reports asynchronous bind failures through the `error` event. Wrapping only its successful callback in a promise does not route that failure into the capture catch block. A sequential cleanup in `finally` also stops at the first rejected await; it does not automatically release later resources.

The portable tool in [capture.mjs](../../../tests/visual/reference/capture.mjs) installs a one-time error rejection before listening and removes that listener after startup succeeds. It catches the capture operation error, then awaits browser and server cleanup independently. The original operation error remains primary; a cleanup error is recorded separately when both fail. A cleanup-only failure also prevents success. The CLI writes `capture-receipt.json` and prints PASS only after cleanup succeeds. Failure paths write `capture-failure.json` with the original error.

Verification covered an actual CLI invocation with valid, unchanged source and cache inputs, exclusive output and a controlled emitted bind denial. The old tool exited without a receipt; the repaired tool exited cleanly with a failed receipt, no success report and no browser attempt. A controlled operation-plus-cleanup failure retained the original error, recorded the cleanup error and awaited both cleanup paths. Removing the independent cleanup guard caused the regression test to fail; restoring it returned all fifteen focused tests to passing.

[Capture tests](../../../tests/visual/reference/capture.test.mjs) exercise emitted startup failure, successful listener removal, browser failure with awaited server cleanup, server callback failure and first-error preservation. These error-path tests do not replace an actual rendered reference capture, installed application QA or device verification. Preserve the successful capture's source hashes and scope separately when a later correction affects only resource handling.

For future capture tools, put emitted startup errors inside the awaited control flow, attempt each owned cleanup despite another failure, and defer the success artifact until every required cleanup completes. Use a fresh output directory for each attempt; retain failed attempts as evidence rather than overwriting them.
