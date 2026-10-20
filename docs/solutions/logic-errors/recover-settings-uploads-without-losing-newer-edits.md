---
title: Recover settings uploads without losing newer local edits
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: A failed upload stays local until restart or a newer edit disappears during recovery
date: 2026-09-09
last_updated: 2026-10-20
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

Healthy idle clients need an acquisition trigger too. The hosted QA route deliberately has no
production `public.profiles` subscription (it uses private `qa-settings-v1` hints instead), and
production notifications can also be missed. Modern SyncService therefore schedules a fallback
canonical read `SETTINGS_FALLBACK_REFRESH_MS` (five minutes) after its last exchange while healthy
and active, sharing `retryNow()` with existing recovery. A failure cancels this healthy timer so the
exponential backoff remains the only recovery scheduler. Success rearms it; teardown cancels it
and lifecycle checks reject retired completions. The cadence does not promise delivery while an
OS suspends the runtime. Keep the QA subscription guard: removing it reaches the wrong authority.

The fallback first shipped at five seconds. Each idle signed-in app then posted the settings route
about every six seconds (the timer plus an ~800 ms call), all day: ISS-0079 measured 26 posts in
2.5 minutes from an idle Mac app, and every surface sharing SyncService did the same. Prompt
delivery does not depend on this timer: change notifications, launch/sign-in, Apple foreground,
`online` and realtime rejoin all read the account immediately. Only a silently missed
notification on an app that stays open and in front waits for the fallback, so keep it in
minutes. `live-sync.test.ts` reproduces the report with an 800 ms transport and asserts that
2.5 idle minutes send no settings calls and one fallback interval sends exactly one read.

Safari has a separate local receive boundary. Native App Group writes do not generate browser
storage events. Open visible Safari caches reread the existing native authority periodically,
without starting another cloud session or writing the browser projection back to native storage.
Hidden pages skip periodic reads. A fresh storage signal supersedes an old read rather than
waiting behind it: serializing those signals made a delayed old-account response hold up an
already committed new account. Abort the old wait and fence its eventual completion. Unsubscribe
cancels both the deadline and refresh timer.

`live-sync.test.ts` composes real backend ports, services, atomic writers, caches and popup bindings
with synthetic transport. It proves bidirectional and different-field convergence within one
fallback interval with notifications withheld, durable offline recovery, no overlapping cloud reads, session changes and
worker recreation. `apple-signin-lifecycle.integration.test.ts` also exercises a mounted host
through repeated sign-in and delayed native cleanup. Safari's `settings-storage.test.ts` proves
app-originated changes arrive without projection events; the compiled native
`atomic-settings.test.ts` preserves reverse-reply and account-generation correctness. These are
controlled integration proofs; real network latency and physical OS lifecycle behavior still need
device testing.
