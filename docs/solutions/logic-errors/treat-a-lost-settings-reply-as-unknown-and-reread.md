---
title: Treat a lost settings reply as unknown, re-read the saved record, never resend
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core/src/storage
applies_when: A page asks another process (extension worker, native host) to save a settings choice and the reply can be lost after the save is already durable
date: 2026-10-05
status: active
tags:
  - settings
  - atomic-storage
  - lost-acknowledgement
  - chromium
  - safari
  - stillkit
---

# Treat a lost settings reply as unknown, re-read the saved record, never resend

## Context

Extension pages that change settings (popup, settings) do not write them themselves; the
first-run page only observes them. A page sends one committed-action message to the single
writer: the background worker on Chrome and Firefox, the app's native handler on Safari and in
the Apple app. The writer saves one complete record and only then replies. The worker or native
host can be terminated in between, so the save is durable and the reply never arrives.

## Root cause

The Safari and Apple paths already treated every missing or malformed reply as a typed
`SettingsStorageRecovery`: the shared cache enters a hold, the popup's "a failed action permits one
read" rule re-reads the saved record, and the screen shows what is really stored.

The Chrome/Firefox page path did that only for a reply that said `unavailable`. In atomic-local
mode, when the worker died before replying, `chrome.runtime.sendMessage` rejected with a plain
error ("message channel closed before a response was received"). The cache took no hold, the popup's re-read rule did not match
the plain `write-failed` outcome, and the switch kept showing the old value even though the new
choice was saved. Only an incidental `storage.onChanged` event repaired it.

## Solution

`ChromeStorageAdapter.commitIntent` maps a rejected intent message to the same
`SettingsStorageRecovery("authority-unavailable")` as an `unavailable` reply. The outcome is unknown,
so the page holds and never resends the intent.

What happens next depends on the popup authority:

- **Atomic-local mode** (the modern settings opt-in, atomic record): the popup automatically re-reads
  the stored record once and returns to ready, showing whatever is saved.
- **Legacy popup authority** (configured builds without the modern opt-in): unchanged from before.
  The popup shows "Settings are unavailable." with Try again. Only Try again re-reads, once, and
  nothing is replayed.

## Why it works

- Intents are desired values evaluated by the writer against the current record under its lock or
  queue. A duplicate of the same choice is a no-op on both writers (no new step, request, sequence or
  write). A different later choice is a new deliberate action, not a retry.
- Nothing replays a choice automatically, so a lost reply cannot rewind a newer choice made in
  another page or process before recovery.
- The saved record carries the pending immutable sync request, so a restarted worker resumes it
  with the same write ID and body.
- The screen claims a save (the toggle report and analytics) only from a received `committed` reply.

## Prevention

- Every page-to-authority transport rejection must map to a typed `SettingsStorageRecovery`. A plain
  error skips the hold and the recovery read.
- Recovery after a failed or unanswered choice is a read, never a resend.

## Where it does not apply

- The automatic recovery read is atomic-local only. Legacy mode recovers when the person taps Try
  again.
- It does not make blocking effects atomic with the saved choice. A Chromium worker killed before
  it updates the Shorts DNR rule leaves that rule stale until the next worker start. Safari tabs that
  are already open catch up at their next reconcile nudge.
- A reply that is delayed rather than lost (the Safari page gives up after 8 seconds) can still land
  later in the writer's lock order. Recovery shows whatever is saved at read time.

## Verification

- `packages/ext-chromium/entrypoints/popup/__tests__/committed-popup-mount.test.ts`, "Chromium popup
  when the worker dies before replying" (change events withheld, atomic-local mode): after-write,
  before-write, and a newer choice on a different field saved before recovery.
- `packages/ext-chromium/entrypoints/popup/__tests__/legacy-popup-mount.test.ts`, "a reply lost
  after the durable write holds until Try again re-reads once, with no replay" (legacy mode).
- `packages/core/src/storage/__tests__/atomic-settings.test.ts`: compiled StillKit host killed
  (SIGKILL) after its App Group write and before its reply, plus a Safari page over that host.
  These two-process tests run only on macOS (`describe.skipIf(process.platform !== "darwin")`). They
  are local evidence and are skipped on Linux CI.
- `packages/core/src/storage/__tests__/atomic-settings-lost-ack.test.ts` and
  `apps/apple/StillKit/Tests/StillKitTests/AtomicSettingsLostAckTests.swift`: restarted writer,
  pending-limit boundary, unknown-owner Off, and an unrenamed orphan file.
- Negative controls: removing the mapping fails the after-write and newer-field popup tests (the
  saved choices are not shown). An injected replay fails all three atomic popup tests and the legacy
  test. Removing either writer's same-value guard fails the
  duplicate tests, and disabling the orphan cleanup fails the orphan test.

Related: [recover-settings-uploads-without-losing-newer-edits](recover-settings-uploads-without-losing-newer-edits.md)
covers the server-side acknowledgement; this document covers the local writer-to-page reply.
