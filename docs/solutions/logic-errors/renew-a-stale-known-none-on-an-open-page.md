---
title: An open page must renew short-lived "known none" and "known owned" evidence after it is replaced, not only before it lapses
category: logic-errors
track: bug
problem_type: logic_error
module: packages/ext-chromium
applies_when: A long-lived page shows an offer that depends on short-lived negative evidence ("this account does not own it") that the background can also invalidate on its own
date: 2026-10-16
status: active
tags:
  - entitlement
  - access-state
  - settings
  - chrome
  - firefox
---

# Renew a stale "known none" on an open page

## Symptom

On Chrome (ISS-0072), a signed-in Settings tab that showed **Get Still Pro** was left open with no
reload. About ten minutes later it showed "Still Pro needs to be verified again." with only Restore
purchase. It also happened on return from a cancelled checkout. A reload always fixed it.

## Cause

- A signed-in "does not own Still Pro" answer is evidence that lasts 60 seconds
  (`createAccountAccessReconciler().evidenceStatus()` in
  [account-access-transport.ts](../../../packages/core/src/entitlement/account-access-transport.ts)).
  Past it, the Still Pro rows resolve to `verification_required` until a fresh reconcile.
- The background also drops that evidence early. Every Supabase auth state change, including the
  hourly token refresh, bumps the reconciler's epoch. Any material change to the stored access
  record (a sync, a checkout operation ending) also makes pages observe access again.
- The Settings card host
  ([browser-pro.ts](../../../packages/ext-chromium/lib/browser-pro.ts)) renewed a visible "none"
  every 45 s, but only 10 times per page life. Once the answer had become "verify", it never
  re-checked: `observe()` cleared the renewal timer, and the timer only renewed a current "none".

So the page renewed the evidence *before it lapsed* for a few minutes. It never renewed it *after
the evidence was replaced*, whether by the deadline or by a background event.

## Fix

- The host remembers that this account was last seen conclusively without Still Pro. When that
  answer turns into "verify" on a visible page, it runs the same scoped re-check once. The card
  shows its existing "Checking your Still Pro access…" state meanwhile (`renewing`). "Verify
  again" shows only when that re-check does not confirm "none". Re-checks share one flight, so a
  renewal can join a check that started before the answer went stale; one fresh check then decides.
  A failed renewal clears the memory, so it cannot loop.
- The renewal allowance (`KEEP_ALIVE_LIMIT`, now about an hour) restarts whenever the page is shown
  or its window is focused. Window focus re-checks like showing the page. A stale known none is
  renewed on show or focus regardless of the 30 s spacing.

## The same fault on the other answer (ISS-0077, 2026-10-18)

The fix above remembered only a conclusive "none". A signed-in account that **owns** Still Pro
has the same short-lived evidence, so on 2.1.1.385 an open Chrome Settings page read "Purchased",
then "Still Pro needs to be verified again." at about ten minutes, then "Purchased" again once the
next background refresh reconciled. The host now remembers a conclusive "owned" as well
(`knownOwned`) and renews whichever answer is remembered when a visible page's answer turns into
"verify": the re-check must confirm the remembered answer, otherwise both memories are dropped and
"verify again" stands. Plan:
[2026-10-18-003](../../plans/2026-10-18-003-fix-iss0077-renew-stale-owned-answer-on-open-page.md).

## Offline is not "verify again" (ISS-0090, 2026-10-19)

On 2.1.1.392, Chrome offline, an account that never bought Still Pro pressed Restore. The error was
right ("We couldn't finish checking. Nothing changed."), but the card still changed: Get Still Pro
vanished, then the card and every Pro row asked to verify Still Pro again, and an offline page said
"Still Pro can't be bought here yet." Three causes, three fixes:

- The background reconciler dropped its last conclusive "none" at the start of every reconcile, so a
  check that never reached the server erased it. It now keeps that answer for the rest of its own
  60 seconds; any server answer, a refused session or an auth boundary still replaces it. The
  Boolean `read()` is unchanged.
- The settings page treated a *failed* Restore like one still checking and hid Get Still Pro. Only a
  Restore that is checking (or asking to verify) holds the Still Pro card now.
- The host renewed a stale known none even offline, and a failed renewal dropped it, giving
  "verify again". Offline (`navigator.onLine` false) it now keeps the known none and the card says
  "Still can't check right now. Try again when you're online."; the window's `online` event renews
  it. A sales answer of "no" while offline says the same instead of "can't be bought here yet". A
  known *owned* answer is not held: an owner whose answer lapses still sees "verify again".

A page loaded fresh while offline, after the minute has passed, has no memory of the earlier "none"
and still shows "verify again"; the access authority cannot tell a never-bought account from an
owner without reaching the server.

## Prevention

- When an offer or a status depends on evidence with a deadline, positive or negative, test both
  ways it ends: the clock passing **and** an unrelated event replacing it (sync, token refresh,
  record write). Fixing one answer and not its opposite leaves the same fault for the other.
- A bound on background renewals needs a reset tied to the person returning (show, focus).
  Otherwise "left open a while" becomes a false error state.
- Fake-timer tests should run past the old bound (here 20 minutes against a 7.5 minute cap) and
  include a hidden → visible return.
