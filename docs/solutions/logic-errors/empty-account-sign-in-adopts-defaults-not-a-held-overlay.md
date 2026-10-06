---
title: An empty-account sign-in by another owner adopts the defaults; never hold the old choices over it
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: Atomic (modern) settings sync pauses with ownership-hold, or switches stay disabled after signing in to a new or recreated account
date: 2026-10-06
status: active
tags: [sync, account-isolation, atomic-settings, stillkit, recovery]
---

**Symptom.** A browser that had been linked to account X, holding choices that differ from the
defaults, signs in to a brand new account Y (or the same email after X was deleted, which is a new
account id). The popup and settings page then say "Settings are unavailable.", every switch is
disabled and the status stays "Syncing your settings." forever. Try again, a worker restart and
signing out do not recover. The page shows X's value while blocking enforces Y's default. A
never-linked install is not affected.

**Cause.** `AtomicSettingsWriter.acknowledge` treated an empty account read under the
`ownership-unconfirmed` pause as "keep every differing local choice held over the account" and set
`paused: "ownership-hold"`. Nothing could clear that state: acknowledgement only dropped held values
that already matched the account, `resolvedPause` needs an empty overlay, sign-out (`enterScope(null)`)
kept the pause, the popup disables every command while any pause is set, and its Try again is a
local reread that cannot change the record. StillKit's `AtomicSettingsRecord` had the same branch.

**Rule (approved CP-019/020; docs/PRODUCT.md first-sign-in table).** A previous, other or unknown
local owner entering a definitively empty account starts from the agreed defaults, and the account
wins. The earlier owner's choices are never uploaded (scope change already retires their queued
requests). A missing marker is unknown, never pristine. Only a never-linked install seeds its
explicit choices into an empty account. The durable previous-account marker survives sign-out and
deletion.

**Fix (TypeScript writer and StillKit twin, kept in step by the shared writer vectors).**
- Acknowledging an account read under `ownership-unconfirmed` or a stored `ownership-hold` adopts
  the account state and clears the overlay and the pause, for empty and non-empty accounts alike.
- Sign-out releases `ownership-unconfirmed` / `ownership-hold` back to local-only control (the saved
  settings, which blocking already enforces, stay as they are).
- A wake (`initialize`) releases that pause if an earlier build left it on a signed-out record.
- Try again on "Settings are unavailable" also asks sync to read the account when the reason is an
  ownership pause (`App.svelte` `recoverSettings`).

The empty account is not given a stamped "defaults" write: an account row that does not exist
already reads as the defaults, and untouched defaults acquire no stamp (so a later never-linked
device can still seed it). The device holds Y's receipt and lineage from the authenticated read, and
Y's next real choice is an ordinary write bound to that receipt.

**Do not** reintroduce a held overlay that only a matching remote change can clear. Any pause that
disables every command needs a reachable exit through retry, restart and sign-out.

**Verification.** `packages/core/src/sync/__tests__/atomic-sync.test.ts` ("VD-15 empty-account
ownership": switch, recreate, 2.x unknown upgrader, A to B to A, never-linked seed, same-account
offline edit, and recovery of a stored hold through retry, restart and sign-out);
`atomic-settings.test.ts` (writer and compiled native bridge); writer vectors
`baseline/previous-account-into-empty-account-seeds-defaults`, `baseline/a-b-a-returns-to-the-account`,
`baseline/*ownership-hold*` replayed by `AtomicSettingsWriterVectorTests.swift`;
`committed-popup-recovery.test.ts` ("Try again on an ownership hold"). An end-to-end run on the
local QA stack reproduced the lock-up on the previous build and showed the fixed build adopting Y's
defaults with usable switches, Y holding only Y's own change, and restart and sign-out staying usable.
