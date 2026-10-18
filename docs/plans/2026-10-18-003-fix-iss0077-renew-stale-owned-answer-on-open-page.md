---
title: An open browser Settings page renews a stale "owned" answer instead of asking to verify again (ISS-0077)
date: 2026-10-18
status: active
issue: ISS-0077 (minor, transient)
related: ISS-0072 (the same page renewing a stale "none"), docs/solutions/logic-errors/renew-a-stale-known-none-on-an-open-page.md
---

# An open browser Settings page renews a stale "owned" answer

## Problem

Chrome, package 2.1.1.385, signed in as an account that holds web Still Pro (QA-Web-Chrome). The
Settings page was left open with no reload. It read "Purchased" at the start and after five
minutes, then "Still Pro needs to be verified again." with only Restore purchase at ten minutes,
then "Purchased" again at fifteen and twenty minutes. Nothing had failed; the person is told to
verify something that the next background refresh then confirms on its own.

## Cause

The same mechanism as ISS-0072, on the other answer. The account's "owns Still Pro" evidence is
short-lived (the reconciler's evidence status), and the background also drops it early on auth
state changes and record writes. Past it, the rows resolve to `verification_required` until a
fresh reconcile. The Settings card host (`packages/ext-chromium/lib/browser-pro.ts`) remembered
only a conclusive "none" (`knownNone`) and renewed only that: `engage()` returned early for
"owned", and a later "verify" renewed nothing when `knownNone` was false. So an owned answer that
went stale showed "verify again" until something else (the hourly token refresh, a sync) made the
background reconcile.

## Change

- The host also remembers a conclusive "owned" (`knownOwned`), set when the account's rows resolve
  to owned and cleared when the account signs out, resolves to none or hidden, or changes.
- `renew()` renews whichever answer is remembered: a visible "verify" after a known none re-checks
  and confirms "none"; after a known owned it re-checks and confirms "owned". The card shows its
  existing "Checking your Still Pro access…" state (`renewing`) meanwhile. A re-check that does
  not confirm the remembered answer clears both memories, so "verify again" is shown and nothing
  loops. `engage()` triggers the renewal on show, focus and the keep-alive tick for either memory.
- The renewal allowance (`KEEP_ALIVE_LIMIT`), its reset on show or focus, and the single shared
  flight are unchanged.

## Verification

- `packages/ext-chromium` Vitest: four new tests under "an open page whose owned answer goes stale
  (ISS-0077)", two of them red before the fix (re-check at once when owned turns into verify,
  showing renewing meanwhile; leave verify again only when the re-check does not confirm owned,
  without looping), plus the ISS-0072 tests unchanged: 62 passed.
- Repository gates on the branch: lint, typecheck, test, build, Playwright fixtures (recorded in
  the pull request).
- Not verified on a live extension yet: the Chrome freshness hold that found the issue
  (`qa-program-20261018/chrome/C-pro-account/hold-20min.log`) is the retest, on the next package
  that carries this change.

## Owner retests

Chrome and Firefox: sign in as a web Pro holder, leave Settings open twenty minutes without a
reload, and read the Still Pro card every five minutes: it must stay "Purchased" (or show the
checking state briefly), never "needs to be verified again".
