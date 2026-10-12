---
title: Treat an authoritative sign-out as conclusive account absence, not unavailable verification
category: logic-errors
track: bug
problem_type: logic_error
module: packages/core
applies_when: A paid-tier access decision distinguishes "verification unavailable" from "known not owned", and a signed-out user can reach it
date: 2026-10-12
status: active
tags:
  - entitlement
  - access-state
  - sign-out
  - chrome
  - firefox
---

# Treat an authoritative sign-out as conclusive account absence

## Symptom

On a fresh, signed-out, never-bought install of a paid-tier build (Chrome, Firefox and Firefox for
Android; ISS-0030), every Still Pro row was a greyed, disabled switch. There was no "Still Pro" lock,
no "See Still Pro", and the settings card said "Still Pro needs to be verified again." with Restore
purchase. Waiting or reopening never changed it. The Mac and iPhone apps showed "Get Still Pro" for
the same person.

## Cause

`TrustedAccessContext.session` already documented three meanings: a verified session, `null` for an
authoritative local sign-out, and `undefined` for verification unavailable. Nothing ever produced
`null`:

- The background's session read (`packages/ext-chromium/entrypoints/background.ts`) returned
  `undefined` whenever `getSession()` had no session.
- `createAccountAccessReconciler().evidenceStatus()`
  ([account-access-transport.ts](../../../packages/core/src/entitlement/account-access-transport.ts))
  answered `absent` only for a signed-in session with a fresh (under sixty seconds) "none"
  reconciliation, so a signed-out install was always `unknown`.
- `resolveBenefitAccess` maps `unknown` to `verification_required`. The row renders a disabled switch
  for that state, and the popup and settings card only offer the purchase when every Pro row is
  `locked`.

A second trap sat behind the obvious fix. The benefit adapter treats explicit `absent` with a null
captured deadline as already expired (see
[preserve the original access deadline](preserve-original-access-freshness-across-shared-requests.md)).
Returning `absent` for a signed-out session with the reconciler's null deadline would make every
observation throw "Access observation expired", so the page would hold `verification_required` and
retry once a minute.

## What was rejected

Treating "the SDK returned no session" as signed out on its own. The extension's auth storage
adapter reads a torn or failed storage read as signed out, so an empty SDK answer can also come from a
storage failure. Signing out also clears account proofs from the access record durably, so a false
`null` would show a paying customer a lock until the next reconciliation.

## Solution

- `readAccessSession` ([auth-storage.ts](../../../packages/ext-chromium/lib/auth-storage.ts)) answers
  `null` only when the SDK reads no session without an error **and** a direct read of the persisted
  auth record succeeds and finds nothing. An SDK error, claims that do not verify, a persisted record
  the SDK did not return, or unreadable storage all stay `undefined`. A paid build that cannot set up
  sign-in (no session spine) is signed out only while no persisted session exists, so a misconfigured
  build cannot drop an earlier account's rights.
- `evidenceStatus(null)` is `absent`. The background also maps `null` to `absent` when the build has
  no account reconciler.
- [chrome-adapter.ts](../../../packages/core/src/entitlement/chrome-adapter.ts) gives signed-out
  absence no sixty-second deadline. The auth boundary that ends it (sign-in) already invalidates the
  context, and the snapshot still refreshes on its normal cadence.
- Independent local rights still resolve first, and an unverifiable stored right or unreadable local
  protection still yields `verification_required`.
- `initialAccessSnapshot` seeds supported paid extras as `checking`, not `verification_required`. The
  seed means nothing is known yet, so the first paint shows the checking state rather than a false
  "verify again". A failed or expired authority read still turns it into `verification_required`
  (`EntitlementCache.holdAccess`).
- A page's first storage event is compared with the value it replaced, and a record that never had
  a session is already signed out (no lifecycle bump). Without this, the page's own first
  observation write (and Firefox's event for identical writes) was treated as a material change.
  That held the just-resolved answer as `verification_required` for a moment on every open.
- The browser settings card offers Get Still Pro to a signed-out install wherever the build sells. The
  background's availability answer is yes for a signed-out page without a policy request; the button
  opens the normal sign-in, and Buy then asks the fresh sales allowance as before. Only a conclusive
  sign-out (the same `readAccessSession` null) counts. The session's `userId: null` alone can also
  mean a failed read or an expired-token refresh error, which answers no.

## Verification

- [signed-out-access.test.ts](../../../packages/core/src/entitlement/__tests__/signed-out-access.test.ts)
  covers: null session is locked, including ten minutes later; undefined is
  `verification_required`; signed in with a fresh "none" is locked, then expires; signed in with an
  unavailable server stays `verification_required`; signed out with unreadable protection or a
  tampered right stays `verification_required`; signing out after a purchase locks and clears account
  rights; signing back in is purchased after the next reconciliation.
- The background suite (`lib/__tests__/background-scoped-access.test.ts`) runs the real background:
  signed out with no auth record is locked without any reconcile request; an unreadable auth record
  or SDK error stays `verification_required`; a build without sign-in is locked; sign-out after a
  purchase locks. The existing "missing SDK session is unknown" case now models a persisted record.
- Settings, popup host and `browser-pro` unit tests cover: Get Still Pro leading to sign-in; no offer
  where the build does not sell; a signed-out answer being dropped when someone signs in; and the
  checking seed before the background answers. The background suite also signs in on a signed-out
  install through the real auth wiring (locked, then `verification_required`, then purchased after
  reconciling), and a local Apple right still grants while signed out.
- `tests/playwright/pro-access-signed-out.spec.ts` is only a dormancy guard in CI, because both CI
  lanes compile the paid tier off (rows are dormant, shown locked, and nothing says verify). During
  this fix it was also run by hand against paid-on builds (unconfigured, and configured with the QA
  sandbox route and modern settings). Every Pro row was locked with the Still Pro lock and settings
  showed Get Still Pro. Without the fix, the same builds failed it.
- Firefox for Android runs the same background and settings page as desktop Firefox, so these tests
  cover it through that shared code. No test exercises an Android-only path.

These checks cover browser hosts only. Safari takes its answer from the native app
(`nativeObservation`) and needs its own conclusive "not owned" from StoreKit or RevenueCat.

## Known limits

- By design, a signed-out observation removes account-bound rights from the stored access record
  (local Apple rights stay). Signing back in restores them on the next account check, normally
  within a minute.

- The SDK itself removes a session after a refresh that fails with a non-retryable error once the
  access token has expired (for example a rate-limit or a captive-portal page). From then on the
  install really is signed out, so its rows show locked with the offer instead of "verify". The
  account rights come back on the next sign-in. Plain offline refresh failures keep the session and
  stay `undefined`.
- A signed-out page never fetches the sales policy, so a remote sales-off switch appears only after
  sign-in ("Still Pro can't be bought here yet").

## Prevention

- When a type documents distinct "unknown" and "known none" values, check that some producer can
  emit each one, and add a test that requires it.
- Any new rule that treats `absent` as expiring must exempt signed-out absence, or carry a deadline
  that cannot be in the past.
