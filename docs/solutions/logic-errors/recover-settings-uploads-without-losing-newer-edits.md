---
title: Recover settings uploads without losing newer local edits
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: A failed upload stays local until restart or a newer edit disappears during recovery
date: 2026-09-09
status: active
tags: [sync, retry, realtime, account-isolation]
---

A failed settings upload previously depended on another edit, a realtime reconnect, or an app
restart to retry. Restarting the sender recovered a saved toggle during device testing; the
underlying transport failure was not identified. The missing retry trigger was reproduced with
the real SyncService and a synthetic failed backend write.

SyncService now schedules retries after 1, 2, 4, 8, 16, then 30 seconds. `retryNow()` shares any
active read/write, and teardown cancels the timer and invalidates delayed responses. Recovery
uses the existing account-wins reconciliation; blindly re-uploading local settings would overwrite
a newer account profile. Apple foreground/online events and the explicit retry action also use
this method. Timers require an active runtime and do not abort an indefinitely pending transport.

A second ordering matters: a server can broadcast this client's write before returning its RPC
acknowledgement. If another local edit is queued, applying that echo loses the new edit. Trying to
restore it later with the same server version fails because the cache correctly rejects duplicate
versions. SyncService tracks its outgoing write ID and preserves the latest queued, held, or
unsent edit when applying that write's echo. Updates from another writer still use account-wins
rules. Ownership is cleared with the session lifecycle.

`lastSyncedAt` records a successful settings exchange with the account, not delivery to every
other device. `pendingUpload` remains set until the latest edit uploads or an explicit account-wins
reconciliation replaces it. The UI displays the authenticated account email alongside those states;
Safari separately compares effective settings with its containing app and labels the historical
app sync time. Email/status are not content-script settings or entitlement inputs.

Verification uses `sync-recovery.test.ts`: automatic retries, capped delays, overlapping requests,
newer queued/held edits, own realtime echoes before acknowledgement and after a lost response,
peer updates, and account lifecycle changes. Removing the automatic timer callback broke six
regressions; removing own-echo preservation broke three while healthy controls remained green.
The full sync suite passed 265 tests after the correction. Apple and browser account-status tests
also cover stale reads, sign-out, deletion and account switches. See the related
[invalidation lesson](invalidate-sync-work-by-session-lifecycle.md) for the ownership rule.
