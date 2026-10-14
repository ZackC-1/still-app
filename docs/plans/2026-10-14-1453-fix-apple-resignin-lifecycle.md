---
title: Keep Apple Sign in usable after sign-out
status: ready
created: 2026-10-14
---

# Keep Apple Sign in usable after sign-out

## Goal and scope

The owner observed that Sign in stopped responding after a successful sign-in and sign-out in the iPhone app. Reopening restored it. Reproduce the lifecycle through the actual Apple settings host, controller and Apple session before changing behavior. The observation does not establish an error message, disabled state, timing, or a free-control failure.

This work depends on PR #434 (native Apple UI and its settings-authority dependency). Preserve its UI changes. No provider, account, stored-data reset, purchase, device or issue-row operations are included.

## Investigation and implementation unit

U1: Exercise initial code sign-in, sign-out and immediate re-sign-in in one mounted host using synthetic transport boundaries. Inspect lifecycle-owned action callbacks and async teardown. If a stale callback or state is reproduced, fix its existing ownership signal with the smallest change; preserve identity/revision fences and obsolete-callback rejection. Do not assume the earlier settings-control issue shares a cause.

Candidate to verify: Apple session publishes signed-out state before asynchronous cleanup completes; the controller advances its plain account revision again at final cleanup. A callback built at the earlier revision can remain drawn without a reactive update, then correctly reject the tap as obsolete.

## Verification

- Observe a red mounted regression before production edits.
- Same mounted host supports repeated sign-in/sign-out/re-sign-in, wrong-code retry and valid-code completion; settings choices survive and no purchase is started.
- Existing stale-account/epoch callback, controller, Apple-session and Apple-settings tests pass.
- Repository lint/typecheck and applicable tests/builds pass; inspect rendered iPhone layout and compile the Apple webview/native host as proportional.
- Review the scoped diff, capture the reusable verified lesson, commit the reviewed change on the dependency branch. Root owns consolidated PR delivery, merge and CI integration.

## Evidence boundary

Synthetic tests establish the reproduced implementation defect only. Physical iPhone successor-package retest remains required. If the lifecycle cannot be reproduced, retain evidence and avoid a speculative code fix.
