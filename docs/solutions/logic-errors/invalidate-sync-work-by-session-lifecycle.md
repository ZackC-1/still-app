---
title: Invalidate delayed settings sync work by session lifecycle
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: Async sync responses or cleanup can finish after sign-out or a later session entry
date: 2026-09-08
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
