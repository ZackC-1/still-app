---
title: Keep Safari popups responsive during quick switch taps (ISS-0050)
date: 2026-10-15
status: active
issue: ISS-0050
---

# Keep Safari popups responsive during quick switch taps (ISS-0050)

## Problem

On QA package 2.1.1.361 both Safari popups froze after three or four quick taps on a site blocker
or on the main "Still is active" switch: every switch went muted, the sync card said "Settings are
unavailable." with Try again, Try again did nothing visible, and the popup recovered by itself a
few seconds later. Safari on the Mac (signed out) and Safari on the iPhone (signed in) both did it.
The native Mac app, with the same shared settings screen and the same App Group store, did not.

The earlier fix (PR430, consolidated in PR435) repaired a persistent signed-out `ordering-hold` in
the stored record. It did not touch how a Safari page talks to the app, and the freeze reproduced
with it present.

## Root cause evidence

- The Safari popup and the Mac app share the settings cache, the popup binding and the native
  writer (`SharedSettingsStore.commitIntent`). They differ only in transport: the app's web view
  calls its handler in process; a Safari page sends `browser.runtime.sendNativeMessage` messages
  to the app's Safari extension handler, a separate request each.
- A Safari popup sends several of those messages at once. Each tap sends a `settingsIntent`; its
  reply is mirrored into browser storage, whose change event makes the page send a `get`; the
  popup's account-status poll sends `getAccountSyncStatus` and `get` together every two seconds.
  Quick taps make an intent overlap the previous tap's read, the next intent and the poll.
- When any one of those intent replies is refused or lost, `SettingsCache.executeIntent` holds the
  whole page (`native-authority-unavailable`, correctly: the outcome is unknown). The one automatic
  read after a failed tap belongs only to the newest tap, so an earlier failure was left holding
  until the page's five-second background read accepted a fresh record. That matches "recovers by
  itself after a few seconds".
- The native side is not the cause: a compiled StillKit host stress test (six processes, 300
  concurrent intents and reads, signed-out and never-linked records) returned no failed or
  unavailable reply. The JS cache and binding hold nothing when replies are delayed or reordered
  but delivered (tests below).
- Reproduced in tests with a native host that refuses a page's second message while one is still
  outstanding: 12 of 12 quick-tap cases (3, 5 and 10 taps, YouTube and main switch, signed in and
  signed out) held or showed "Settings are unavailable." on current code.

Not verified: the exact refusal Safari applies on device (refused promise, lost reply or garbled
reply). The fix removes the overlap for all three.

## Approach

1. `packages/core/src/storage/safari-native-channel.ts`: one native channel per Safari extension
   page (per runtime object). A message is sent at once when nothing is outstanding; otherwise it
   waits until the outstanding message is answered, or for at most a two-second busy bound when a
   reply is lost. A caller that aborts while queued is dropped unsent; one that aborts after
   sending keeps the channel busy, because its message is still outstanding at the host. The
   caller's own reply bound stays eight seconds.
2. `ChromeStorageAdapter` (Safari page only, not the background's projection owner): native `get`
   and `settingsIntent` go through the channel. Intents are still sent once and never replayed;
   an unknown outcome still holds and re-reads.
3. `ext-safari/lib/account-status.ts`: the popup's account poll uses the same channel, one message
   after the other.

No change to the cache, the popup binding, the Svelte screens, the Swift handler or the store.
The background (projection owner) keeps its independent, bounded messages: a hung background read
must still not delay a later intent there (existing tests).

## Tests (written first, failing on current code)

- `packages/ext-safari/entrypoints/popup/__tests__/safari-v3-rapid-toggles.test.ts`, real Safari V3
  popup over a synthetic native host whose page reads go native, as on device:
  - 3, 5 and 10 taps inside about one second on YouTube and on the main switch, signed out
    (previous-account record, Mac popup) and signed in (acknowledged account record, phone
    popup): no hold or "Settings are unavailable." at any 5 ms sample, final stored value equals
    the last tap, no other field changes, at most one intent per tap, and the page never overlaps
    its own messages. Failed on current code (12 of 12).
  - delayed and out-of-order replies (first reply slowest): same assertions, signed in and out.
    Passes on current code too; kept as a regression guard.
  - Try again after an unreachable tap clears the hold within one second by reading only.
- `packages/core/src/storage/__tests__/safari-native-channel.test.ts`: idle send is synchronous,
  order, no overlap, refusal, lost reply (busy bound and reply bound), abort before and after
  sending, independent pages, no leftover timers.
- `packages/ext-safari/lib/__tests__/settings-storage.test.ts`: the slow-poll supersede test now
  allows the new read to wait for the busy bound behind the unanswered poll; the obsolete reply is
  still never applied.

Swift tests: none added, because the bridge and store are not part of the cause (stress evidence
above).

## Retest (owner, installed successor package)

- MAC-07 Safari popup follow-up: rapid YouTube Blocker and main switch taps (3, 5, 10), then Try
  again if anything holds.
- MAC-08: YouTube switchable in the signed-out Safari Mac popup, then the Home Shorts check.
- IOS-06 follow-up: iPhone Safari popup rapid YouTube Blocker and main switch taps, signed in.
- IOS-31: first tap after a full phone restart applies once.
- Control: native Mac app rapid toggles stay responsive.
- ISS-0058 live sync (XD-01, XD-03) still converges in about 1-2 seconds.

## Risks

- A lost reply delays the page's next message by up to two seconds (was: messages overlapped).
- Two Safari pages open at once (popup and settings page) still have separate channels.
- If Safari also refuses overlap with the background's own messages, a residual hold remains
  possible; the background sends settings messages only at start, on a page-load nudge and after
  a failed projection write.
