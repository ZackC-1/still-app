---
title: Keep analytics work fenced only by a confirmation that left its owner as it was
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: A woken extension background confirms the account at its start and a Still screen's event was observed just before that confirmation
date: 2026-11-07
status: active
tags:
  - analytics
  - extension
  - race-condition
  - cross-platform
---

# Keep work fenced only by a confirmation that left its owner as it was

When a Still popup wakes a sleeping extension background, the background's start-up account check
and the popup's event race. The start's confirmation changes the client's stamp, so the popup's
`opened`, observed a moment before, is stale and is dropped. This happened on Safari (iPhone and
Mac), Chrome and Firefox, for signed-out people (ISS-0115) and for signed-in people with a
per-device identity (ISS-0127).

## Cause

`AnalyticsClient` stamps work with the account generation, the consent epoch and the hold count.
Any account change makes earlier stamps stale. On a fresh background:

- Signed out: the start's `confirm(null, { forget: true })` bumps the generation and the epoch.
- Signed in: the start holds the client for the account (`holdForAccount`, which on a fresh start
  fences nothing), and the identity then continues that hold (`confirm` with `accountId`). Only
  work observed under the hold stays current (ISS-0108); work observed before the hold is stale.
  This is deliberate: on a fresh start, the pre-hold work can be an earlier account's use.

## Solution

`AnalyticsClient.revive` maps a stale stamp across a list of "same owner" fences, each a
`{ before, after }` stamp pair. A fence is recorded only after the confirmation is installed and
only when that confirmation could not change who owns the earlier work:

- A sign-out that lets go of nobody: no stored identity, no hold, nothing forgotten.
- A fresh start's hold continued by the identity already stored for the same account: the stored
  `userId` equals the confirmed identity, the stored `accountRef` equals the account, nothing is
  forgotten, and nothing (stamp, epoch or another hold) changed between the hold and the identity.
  The fence's `before` is the stamp from just before the hold.

`revive` also requires the permission to be the same one the work was observed under. Safari's
`checkAccount` keeps an overtaken check's work when its own answer was readable and, after the
newer checks finish, the device is still as that answer said (signed out with nothing held, or
`accountInForce` equals the account it read). Then it calls `revive`.

## What still drops the work

A sign-out of someone, another account, another identity for the same account, a deletion not yet
verifiably dropped, a sharing change (also between the hold and the identity), or a hold, sign-in
or sharing change after the confirmation. An event is never sent under an identity other than the
one the install already reported as.

## Verification

- Core: `ISS-0115` and `ISS-0127` blocks in
  [races.test.ts](../../../packages/core/src/analytics/__tests__/races.test.ts).
- Safari end to end, iPhone and Mac, one and two popup events, plus negative controls:
  [default-on-analytics.test.ts](../../../packages/ext-safari/lib/__tests__/default-on-analytics.test.ts).
- Chrome and Firefox end to end, plus a cached other-account negative control:
  [default-on-analytics.test.ts](../../../packages/ext-chromium/lib/__tests__/default-on-analytics.test.ts).
- The new positive tests fail without the fix. Removing the stored-identity guard or the account
  guard makes the matching negative controls fail.

## Prevention

- Do not widen `isCurrent` to rescue a race. Add a fence that `revive` reads, so only host paths
  that opt in can keep stale work.
- Record a fence only after the confirmation is installed, and judge "same owner" from the stored
  state before the install.
- Every new rescue needs a negative control for each change it must still drop.
