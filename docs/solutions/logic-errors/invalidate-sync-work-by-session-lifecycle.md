---
title: Invalidate delayed settings sync work by session lifecycle
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: Async sync responses or cleanup can finish after sign-out or a later session entry
date: 2026-09-08
last_updated: 2026-10-08
status: active
tags: [sync, session, account-isolation, realtime, async]
---

# Invalidate delayed settings sync work by session lifecycle

A settings write sent by account A could finish after account B signed in. The sync service applied
A's response to the current cache, which stamped it with B's current local sync epoch. B's next edit
then uploaded A's settings into B's profile. The request itself retained A's identity: this was a
client-side contamination defect, not a demonstrated backend authorization bypass.

Storage arbitration could not reject this response. Its server version belonged to A, but its local
epoch now appeared to belong to B. Moving the fix into cache or native comparison rules would hide
incorrect ownership at the point where the network response enters local state.

## Fix the operation's owner

`packages/core/src/sync/service.ts` keeps a lifecycle counter that advances when write-through stops.
Sign-in and resume replace the lifecycle, as does an entitlement confirmation that starts sync for
a new session. A same-account confirmation of an already active session preserves it.

Async work captures the lifecycle that starts it. Before applying a response, recording a failure,
starting a subscription, or draining queued writes, it checks that lifecycle is still current. The
initial reconcile also checks after hydration and identity reads, before issuing later requests.
Existing account adoption, timestamp/version comparisons, storage epochs, and the retained
last-synced-account marker keep their prior rules.

Checking UUID alone is insufficient: sign-out followed by sign-in as A, or A → B → A, can finish with
the same UUID and a different owner for in-flight work. A late empty-account read can otherwise seed
an account that the new session has already adopted, and a late fresh-account write can force an
older envelope over the newer account state.

Response checks alone also leave a bug. An obsolete `finally` can drain the current session's queued
write or clear its in-flight marker; an obsolete rejection can discard its queue or mark it offline.
Cleanup, realtime callbacks, and reconnect reads need the same ownership boundary.

## Behavioral evidence

`sync-lifecycle.test.ts` exercises the real session, cache, and Supabase backend adapter using
synthetic auth and controlled transport responses. It covers delayed success/rejection, returning
to the same account, A → B → A, pending sign-out/deletion, queued writes, fresh-account adoption,
resume, reconnect, entitlement confirmation, and watched peer storage. A settled-response control
preserves the healthy ordering.

`sync-lifecycle-native.test.ts` compiles the unchanged Swift `StillSettings`, `SharedSettingsStore`,
and `SettingsBridge`, then drives them through the actual `WKWebViewStorageAdapter` using a synthetic
JSON subprocess transport. B's native record and next upload remain B's after A's late response.
The test runs on macOS and explicitly skips other hosts; it does not certify WebKit or physical
Apple device lifecycle and notifications.

Mutation checks removed the production write-response guard and then disabled lifecycle
invalidation. The first caused seven regression failures, including the Swift boundary; the second
caused 27 failures while the healthy control passed. Application bytes were restored exactly before
rerunning checks. This proves those named mutations are detected, not independent coverage of every
individual guard.

Relevant existing sync/storage/session tests preserve normal edits, coalescing, offline/reconnect
recovery, first-account seeding, existing-account adoption, and peer propagation. StillKit's actual
Swift suite passed 125 tests.

Related: [local sign-out persistence](../security-issues/supabase-signout-leaves-local-session-on-revoke-failure.md)
explains why host auth teardown must also clear persisted sessions when a server revoke fails.

## Account display and native cleanup

The same ownership rule applies outside SyncService. A queued native status write adds an await
before sign-out; recheck the session generation after that await and after native cleanup, before
signing out the sync service. Account deletion must likewise ignore a completion superseded by a
new session. UI completion handlers must not reset the replacement account. Clear account-scoped
delete presentation when identity changes, so the replacement account does not inherit a disabled
"Deleting" button. A launch identity lookup needs guards on both its success and failure paths.

`apple-session.test.ts` exercises delayed native status writes and account deletion through the
controller-to-session wiring. `ui/__tests__/account-status.test.ts` covers a background account
switch while an earlier sign-out is pending. Removing the Apple completion guards breaks both
new teardown regressions while the other session controls still pass.


## Refresh confirmation without replacing the account

Account confirmation is an observation of the current session. A fresh read for the same account
must not reset an open deletion dialog or its consent checkbox merely because a presentation object
was rebuilt. Key dialog ownership to the account identity; invalidate it on an actual identity
change. Authorization remains separate: the operation still requires current server confirmation,
and an obsolete token or session generation cannot authorize a replacement account.

`ui/v3/AppleSettings.test.ts` covers confirmation refresh while the deletion dialog remains open.
`sync/__tests__/auth.test.ts` covers replacing a token while retaining the same UUID.
`sync/__tests__/extension-session.test.ts` holds account deletion before its generation advances and
checks both a verification begun during teardown and an earlier verification that resolves during
teardown. Removing either corresponding production teardown guard makes its named regression fail;
restoring source makes both pass.

Browser and Apple confirmation effects share the paid-tier gate and visible/online recovery rules.
Do not issue dormant confirmation requests when the host has no consumer. The host tests cover
active recovery, hidden-page suppression and listener cleanup, plus dormant builds without reads.
These are controlled host and transport tests; they do not establish hosted OTP, sandbox purchases
or physical-device behavior.

## Serialize checkout recovery within a session

Session ownership alone cannot order two requests from the same session. Two concurrent Restore
calls can capture checkout operation A. After the first terminal response clears A, a new purchase
can persist operation B. A delayed terminal response for A then clears B while every account and
session guard still passes.

The managed checkout path in `sync/extension-session.ts` uses one promise queue for creation and
completion, including the operation read, terminal clear and new-operation persistence. Capture
the caller's session before entering the queue and check it again inside; waiting must never adopt
a replacement session. A rejection releases the queue. Run already-entitled reconciliation after
the creation callback releases the queue, because reconciliation itself enters that queue.

`sync/__tests__/sandbox-checkout-recovery.test.ts` covers overlapping Restore and purchase,
replacement of a queued session, release after a storage rejection, and already-entitled
reconciliation without nesting the queue. The overlapping regression failed before the queue
repair; all 19 recovery tests and the related session/transport tests passed afterward, 94 tests
in total. These checks establish local request ordering, not hosted payment settlement.

Identity-switch cleanup also needs a hold before authentication can replace the account. A new
account could previously open checkout while the old account's tab-close awaited, then lose its
operation to the old purge. The managed code-verification path holds checkout and recovery from
entry through cleanup, releasing the hold in `finally`. The controlled cleanup regression failed
before that repair; tests cover both the delayed purge and release after authentication failure.
