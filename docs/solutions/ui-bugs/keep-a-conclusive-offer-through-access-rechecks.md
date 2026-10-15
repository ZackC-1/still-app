---
title: Keep a conclusive Still Pro offer through access re-checks
category: ui-bugs
track: bug
problem_type: ui_bug
module: packages/core
component: frontend
severity: medium
symptoms:
  - The popup's Still Pro card and the "Still Pro" lock chips vanish after a setting change or sync.
  - Pro rows briefly show as plain disabled switches instead of lock chips.
  - A first popup opening shows no Still Pro card; the second opening does.
root_cause: async_timing
resolution_type: code_fix
date: 2026-10-15
status: active
tags: [popup, entitlement, access, offer, retry, safari]
related:
  - docs/solutions/ui-bugs/fence-delayed-popup-work-before-publishing-effects.md
---

# Keep a conclusive Still Pro offer through access re-checks

## Problem

Offer surfaces drew straight from inputs that legitimately go "unsure" for a moment. Each moment of
doubt removed the offer, and nothing brought it back until the popup was reopened.

## Root cause

- `EntitlementCache` holds every non-free Pro row as `verification_required` while it re-confirms
  access (record change, passed freshness deadline, failed read), and after a failed read it used to
  wait 60 s before asking again. The hold is correct for the entitlement authority: a signed-in
  "none" is fresh evidence that expires. But the popup read the held state as "not conclusively
  locked" and dropped the card and the lock chips.
- The Chrome/Firefox popup re-asked "would Settings offer Get Still Pro?" on every binding
  publication. Signed in, that is a fresh network sales check, so any momentary failure answered
  "no" and hid the card. Its startup retries covered only about 1.5 s, less than a cold Firefox
  background can take.

## Solution

- Presentation latch (`createProOfferLatch` in `packages/core/src/ui/v3/presentation.ts`): once a
  view has seen Pro access conclusively locked, a later `checking` / `verification_required` hold is
  drawn as `locked`. Any purchased or protected Pro row ends it at once. A locked row has no switch,
  so the latch can never make a Pro row usable. Popups (navigation only) and the Safari hand-off
  card use it. On the Chrome/Firefox settings page only the rows use it, and Buy still reads the
  real snapshot, so nothing asks for money while Still is unsure.
- Popup readiness: a live "yes" holds for the popup's life (checkout re-checks on its own). Each
  ask times out after 3 s, and retries back off over about 7.5 s.
- Cache recovery: a failed read retries after 1, 2, 4 and 8 s before the minute cadence. Any success
  resets it.

## Prevention

- Do not drive an offer's visibility straight from a value that the authority is allowed to
  "hold". Decide at the presentation layer what a hold means for that surface, and test
  "conclusive answer, then hold, then setting change" as well as the first render.
- Display-only stickiness is fine for navigation entries. Purchase entries must keep reading the
  real snapshot.
- A "yes" that only enables navigation does not need to be re-asked on every state change. Re-ask
  only until the first yes.
