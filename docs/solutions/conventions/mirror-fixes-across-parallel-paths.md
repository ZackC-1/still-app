---
title: When you harden one path, check the parallel path for the same gap
category: conventions
problem_type: logic_error
track: knowledge
module: packages/core
tags: [coupling, sign-out, account-deletion, revenuecat, code-review, anti-pattern]
applies_when: Fixing a teardown/reset/cleanup path that has a sibling path doing similar work
date: 2026-06-24
status: active
---

# Mirror fixes across parallel paths

## Context

During the App Store hardening work (PR #8), U2 fixed sign-out to reset the native RevenueCat identity:
the web sign-out was wired through `signOutEverywhere()` which calls `bridge.signOut()` →
`PurchaseManager.reset()` before clearing the Supabase session.

But **account deletion** is a parallel teardown path, and U4 wired it independently as
`deleteAccount: () => sync.deleteAccount()`. `sync.deleteAccount()` calls `auth.signOut()` *directly*,
bypassing `signOutEverywhere`/`bridge.signOut()`. So the exact stale-RevenueCat-identity gap U2 closed
for sign-out was **silently reopened for delete** — the deleted user's `app_user_id` stayed configured
natively. The multi-agent code review (correctness persona) caught it; tests didn't, because each path
was tested in isolation.

## Guidance

When you fix a **teardown / reset / cleanup** path, immediately ask: *what other paths reach a similar
end state?* Sign-out, account deletion, session expiry, and account switching are all "tear down the
session" — a fix to one usually belongs in all of them.

The robust fix is to route the siblings through the **same** hardened helper, not to re-implement the
fix in each:

```ts
// Both paths run the native reset; delete just does the backend delete first.
const signOutEverywhere = async () => { if (bridge.available) { try { await bridge.signOut(); } catch {} } await sync.signOut(); };
const deleteAccountEverywhere = async () => { await sync.deleteAccount(); if (bridge.available) { try { await bridge.signOut(); } catch {} } };
```

## Why This Matters

Parallel paths drift. A fix applied to one and not the other is invisible until someone exercises the
neglected path — and security/teardown gaps are exactly where that hurts (a deleted user's purchase
identity left live). Per-path unit tests don't catch it because each path passes its own test.

## When to Apply

- Any change to sign-out, logout, session teardown, cache invalidation, or "reset to default" logic —
  grep for sibling paths that should share the behavior.
- Code review: when a diff hardens one teardown path, explicitly check the parallel ones. (This is a
  good adversarial/correctness-review prompt.)

## Examples

- The fix: `packages/app-webview/src/main.ts` `signOutEverywhere` + `deleteAccountEverywhere` both run
  the native reset; `SyncService.deleteAccount` forces `SIGNED_OUT` even if the local sign-out throws.
- Related robustness sibling: error handling, too, must mirror — `onGet`/`onRestore` both needed the
  same try/catch so a rejected native call can't strand the purchase CTA in `purchasing`.
