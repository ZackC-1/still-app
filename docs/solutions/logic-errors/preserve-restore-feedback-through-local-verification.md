---
title: Preserve restore feedback through local purchase verification
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core/ui/v3
applies_when: A native restore result and accepted purchase cache can publish during asynchronous local verification
date: 2026-10-07
status: active
tags: [apple, purchase, restore, async, ui]
---

A pending purchase must remain recoverable after the purchase sheet closes. The Settings leaf
needs explicit verification-required presentation and a Verify purchase action that invokes the
existing local verifier without starting another purchase or requiring account sign-in.

Restore feedback has a separate lifetime. Suppressing generic failed or cancelled states based
only on a pending purchase can hide a failure from a new native Restore operation. Conversely,
clearing checking before awaiting the signed verifier lets an intervening accepted-cache update
hide progress, re-enable Restore and release the restore rating hold while verification is still
running.

[apple-pro-host.ts](../../../packages/core/src/ui/v3/apple-pro-host.ts) records whether the current
operation entered local verification. It suppresses only feedback derived from that verifier and
preserves independent native Restore failures. Checking remains active throughout the awaited
verification; completion or failure clears it through the existing result handling. The Settings
presentation and mounted leaf expose the same recovery action without a duplicate generic retry
row.

The host and mounted integration tests exercise Settings and Purchase surfaces with delayed
failed, held and owned verifier results. They check visible progress, action availability and the
actual restore rating hold while a cache update arrives. Six new deferred-verification regressions
failed before the final production repair. The final six-suite host selection passed 256 tests,
and independent source review approved the final repair. These tests use synthetic native/provider
boundaries; they do not certify StoreKit, signed archives or device purchase behavior.
