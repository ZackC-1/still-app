---
title: Apple Get Still Pro offers sign-in first, skippable (ISS-0071, option B)
status: in_progress
date: 2026-10-16
issues: ISS-0071
design: docs/plans/2026-10-16-005-design-apple-signin-before-buy-and-pro-tag.md (sections 1-4, 6-7)
---

# Apple Get Still Pro offers sign-in first, skippable (ISS-0071)

## Problem

The Mac app and the Safari popup showed "You have Still Pro." next to a sync card that said
"Sign in". The owner wants a buyer to end up signed in with Still Pro. Apple never tells Still the
buyer's email, so the app has to ask. Requiring sign-in would repeat the macOS 1.0 (3) rejection
under Guideline 5.1.1(v), so the owner chose option B: sign-in first, always skippable (D543,
ADR 0005).

## Change

- `apple-pro-host.ts`: Get Still Pro, signed out on a build that can sign in, opens the app's
  sign-in (`signInForPurchase`). A confirmed sign-in continues to the unchanged StoreKit purchase
  without a second tap. `buyWithoutAccount()` goes straight to Apple as before. Cancelling
  (`signInDismissed()`) or leaving the Still Pro screen drops it, so a later sign-in buys nothing.
  A purchase started signed in is linked after verification through the existing `confirmLink`
  path, only when the account and session are unchanged and the device can prove a purchased
  (not family-shared) purchaser; otherwise Still Pro stays local, and a failed link shows the
  existing Try again card. Restore is unchanged and never asks for sign-in.
- `SignInSheet.svelte`: optional `note` (one line) and `skip` (a link), supplied only by the Apple
  host when Get Still Pro opened the sheet.
- `AppleSettingsHost.svelte`: wires `canSignIn`, the note ("Sign in first, so Still Pro stays with
  your account.") and the skip link ("Buy without an account"); clears the purchase sign-in
  whenever the sheet closes signed out; shows the accountless holder's card when signed out.
- `AppleSettings.svelte`: the invitation reads "Sign in to keep Still Pro with your account." with
  Sign in and Not now, and may sit beside a concluded Restore.
- `PurchaseView.svelte`: "Payment is handled by Apple." (no "No account needed").
- Docs: ADR 0005 (amends ADR 0003), D543 in the V3 record, `CONCEPTS.md`, `docs/PRODUCT.md`, the
  Apple runbook and store listing copy (review notes with a "[review account]" placeholder).
  `STRATEGY.md` rechecked: its "without an account" lines are about blocking and sync and stay true.

Review follow-ups (same PR): the continuation is re-armed at most once and only for the same
account id (a sign-out or another account drops it); the automatic link reads eligibility inside
the guarded link, once more after an overlapping access refresh, and ends in the failed card with
Try again instead of silently skipping; an overlapping refresh no longer cancels a link in flight;
"signed out" for Get Still Pro is based on the session, not on the address being known; and the
sign-in card shows right after a purchase made without an account. A purchase Apple completes
later (Ask to Buy, or one recovered after an interrupted reply) is not linked automatically, by
design; the link card offers it (ADR 0005).

No server function, Swift or StillKit change. The Safari popup's Get Still Pro still hands off to
the app; Chrome and Firefox purchase is unchanged.

## Decision number

The design note proposed D526. The V3 record's "Next decision ID" line was stale: the local-only
decision log already holds D527–D542 (and D530/D531 appear in the record itself). This decision is
recorded as **D543**, and the record's next ID is now D544.

## Verification

Red first (saved before implementing): 21 failing tests across `apple-pro-host.test.ts`,
`apple-pro-host.integration.test.ts`, `AppleSettings.test.ts` and `PurchaseView.test.ts` (signed-out
Get Still Pro opens sign-in, cancel opens nothing, sign-in continues without a second tap, skip buys
accountless, signed-in purchase auto-links, link failure keeps local Pro with Try again, new copy,
no "No account needed"). Guard tests (account switch or sign-out mid-flow never links; an unprovable
purchaser is never linked; Restore never asks for sign-in) passed before and after.

Review round: 10 further tests failed first (sign-out or account switch during the continued check
through the real host, re-arm at most once, overlapping eligibility refresh, unprovable purchaser
ends in Try again, session without an address, the card right after an accountless purchase). The
cancel test now signs in after cancelling and fails if the host's dismissal effect is removed.

Gates (local, this branch, unconfigured):

- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm test` (core 5,407 passed / 39 skipped; chromium 794; safari 395; owner-admin 58)
- [x] `pnpm build`
- [x] `pnpm exec playwright test --project=fixtures` (356 passed, 25 skipped)
- [ ] CI green (unconfigured and configured lanes): see the PR

Screenshots (the real `AppleSettingsHost` composed with the in-repo native-bridge fakes, iPhone
width, `docs/release/history/v3/screenshots/iss0071/`): the signed-out Get Still Pro sign-in step
with the added line and "Buy without an account", and the reworded card for an accountless holder.

## Remaining (device QA, QA lead)

The QA programme rewrites in section 7 of the design note (IOS-42..49, MAC-44..49, DB-13/14, and
the new steps for sign-in-first, cancel, and accountless holders) belong to the QA lead. A QA
package of this change needs its sandbox sales allowlist line before the purchase sitting.
