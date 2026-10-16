---
title: Send a Safari page's native messages one at a time
category: integration-issues
track: bug
problem_type: integration_issue
module: packages/core/src/storage
applies_when: A Safari extension page (popup or settings) talks to the containing app through browser.runtime.sendNativeMessage more than once in quick succession
date: 2026-10-15
status: active
tags:
  - safari
  - native-messaging
  - settings
  - popup
  - stillkit
---

# Send a Safari page's native messages one at a time

## Symptom

ISS-0050. On both Safari popups (Mac signed out, iPhone signed in), three or four quick taps on a
site blocker or on the main switch muted every switch and showed "Settings are unavailable." with
Try again. Try again did nothing visible; the popup recovered by itself a few seconds later. The
native Mac app, with the same shared settings screen and the same App Group store, never froze.

## Root cause

The two hosts share the settings cache, the popup binding and the native writer. They differ only
in transport. The app's web view calls its handler in process. A Safari page sends
`browser.runtime.sendNativeMessage` requests, and a popup sent several at once:

- each tap's `settingsIntent`;
- the `get` that the tap's own browser-storage mirror write triggered through `storage.onChanged`;
- the account-status poll's `getAccountSyncStatus` and `get`, together, every two seconds.

Quick taps overlapped those. An overlapped intent that failed had an unknown outcome, so the
cache correctly held the page (`native-authority-unavailable`). The one automatic read belonged
to the newest tap only, so the hold usually lasted until the page's five-second background read.

The writer was ruled out with a compiled StillKit host under concurrency (six processes, 300
mixed intents and reads): no failed or unavailable reply. The cache and binding were ruled out with
delayed and reordered but delivered replies: no hold. Which refusal Safari applies on device
(rejected promise, lost reply or garbled reply) was not observed; the fix covers all three.

## Fix

`packages/core/src/storage/safari-native-channel.ts` gives each extension page (each runtime
object) one channel:

- sent at once when nothing is outstanding, so a single message gets no added delay;
- otherwise queued until the outstanding message is answered or counts as lost at its eight-second
  reply bound, so a slow reply is never overlapped;
- a message that cannot be sent within the reply bound of being queued is dropped unsent, so a
  hung host never makes taps wait indefinitely;
- a caller that aborts before its turn is dropped unsent; one that aborts after sending keeps the
  channel busy, because the host still has its message;
- no timers when nothing is waiting.

`ChromeStorageAdapter` sends a page's `get` and `settingsIntent` through it, and the Safari
account-status poll and the Mac hand-off do too. The poll compares the app with the page's settings
when its replies arrive; a save queued ahead of it is not a pending upload. The background's projection owner (`nativeMirror`) keeps its own
independent, bounded messages: there a hung read must not delay a later intent.

Intents are still sent once. A refused or unanswered intent still holds the page and re-reads;
nothing replays it ([lost settings replies](../logic-errors/treat-a-lost-settings-reply-as-unknown-and-reread.md)).

## Prevention

- Any new Safari page code that calls the app natively uses `sendSafariNativeMessage`, not
  `browser.runtime.sendNativeMessage` directly.
- Synthetic Safari hosts in tests should model latency and overlap. A host that answers instantly
  and tolerates overlap hid this for several releases. `safari-native.fixture.ts` has a
  `host: { latencyMs, busy: "reject" }` mode and a `nativeReads` mode that sends page reads to the
  host as a real Safari page does (jsdom otherwise routes them through the background).

## Verification

- `packages/ext-safari/entrypoints/popup/__tests__/safari-v3-rapid-toggles.test.ts`: 3, 5 and 10
  taps inside about a second on YouTube and on the main switch, signed out and signed in. Before
  the fix 12 of 12 showed a hold; after it, none, the last tap wins and nothing else changes.
- `packages/core/src/storage/__tests__/safari-native-channel.test.ts`: order, no overlap, refusal,
  lost reply, abort before and after sending, independent pages, no leftover timers.
- These model Safari's transport; only an installed package on a Mac and an iPhone exercises the
  real one.
