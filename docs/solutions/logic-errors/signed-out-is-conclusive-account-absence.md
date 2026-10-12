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
  the SDK did not return, or unreadable storage all stay `undefined`. A paid build with no sign-in at
  all (no session spine) is always signed out.
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
- The browser settings card offers Get Still Pro to a signed-out install wherever the build sells. The
  background's availability answer is yes for a signed-out page without a policy request; the button
  opens the normal sign-in, and Buy then asks the fresh sales allowance as before.

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
- Settings and popup host tests cover Get Still Pro leading to sign-in, no offer where the build does
  not sell, and the checking seed before the background answers.
- `tests/playwright/pro-access-signed-out.spec.ts` checks both CI lanes, where the paid tier is
  compiled off: rows are dormant, shown locked, and nothing says verify. When it was run locally
  against paid-on builds (unconfigured, and configured with the QA sandbox route and modern settings),
  every Pro row was locked with the Still Pro lock and settings showed Get Still Pro. The same spec
  failed on those builds without the fix.

These checks cover browser hosts only. Safari takes its answer from the native app
(`nativeObservation`) and needs its own conclusive "not owned" from StoreKit or RevenueCat.

## Prevention

- When a type documents distinct "unknown" and "known none" values, check that some producer can
  emit each one, and add a test that requires it.
- Any new rule that treats `absent` as expiring must exempt signed-out absence, or carry a deadline
  that cannot be in the past.
