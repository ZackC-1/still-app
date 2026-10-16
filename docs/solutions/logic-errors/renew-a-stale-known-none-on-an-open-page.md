---
title: An open page must renew short-lived "known none" evidence after it is replaced, not only before it lapses
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
  again" shows only when that re-check does not confirm "none". A failed renewal clears the memory,
  so it cannot loop.
- The renewal allowance (`KEEP_ALIVE_LIMIT`, now about an hour) restarts whenever the page is shown
  or its window is focused. Window focus re-checks like showing the page. A stale known none is
  renewed on show or focus regardless of the 30 s spacing.

## Prevention

- When an offer depends on negative evidence with a deadline, test both ways it ends: the clock
  passing **and** an unrelated event replacing it (sync, token refresh, record write).
- A bound on background renewals needs a reset tied to the person returning (show, focus).
  Otherwise "left open a while" becomes a false error state.
- Fake-timer tests should run past the old bound (here 20 minutes against a 7.5 minute cap) and
  include a hidden → visible return.
