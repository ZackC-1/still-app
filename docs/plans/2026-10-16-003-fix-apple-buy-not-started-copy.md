---
title: Honest copy when an Apple Buy never reached the App Store (ISS-0070 secondary)
date: 2026-10-16
status: active
issue: ISS-0070 (secondary, minor)
---

# Honest copy when an Apple Buy never reached the App Store

## Problem

On the Mac with no App Store (sandbox) account signed in, Get Still Pro showed "The purchase wasn't
confirmed." and "If you were charged, Restore purchase will find it." Apple never opened a purchase
sheet. The Mac log showed `AppTransaction` failing with `noAccount` and no purchase request reaching
StoreKit. The iPhone runs the same code.

## Root cause (evidence)

- `PurchaseManager.verifiedInstallEnvironment()` returns `.unavailable` when `AppTransaction.shared`
  throws (here: `noAccount`). `NativeSalesPurchaseBoundary.perform` refuses before `charge()` and
  returns the caller's `unavailable` value, which `purchasePro` maps to the native outcome
  `"unavailable"`.
- Every native path that produces `"unavailable"` for a Buy is before the charge: paid tier off,
  offer re-read mismatch, no package, the sales policy refusal and the sandbox installation check.
  The charge closure itself never returns `.unavailable` (it returns purchased, pending, cancelled
  or failed). The web bridge also returns `"unavailable"` only when it did not dispatch.
- `apple-pro-host.ts` treated `"unavailable"` like an ambiguous failure: it fell through to
  `throw` and set `purchase = { state: "failed" }`. Both the purchase view and the settings card
  render every `failed` state with the "If you were charged" copy, which is only true when a charge
  may have happened.

## Approach

- Add an optional `notCharged` flag to the Apple purchase state (`PurchaseViewProps.purchase` and
  `NativeProOfferCardProps`). The Apple host sets it only when the Buy provably never reached the
  App Store and no earlier acquisition is awaiting verification:
  - native outcome `"unavailable"` for a Buy (current call, and the account-replacement branch);
  - the host's own pre-charge offer re-read failing (the Buy button was never dispatched).
- With `notCharged`, both surfaces say "Still Pro couldn't be bought right now." and "Nothing was
  charged. Make sure you're signed in to the App Store, then try again." Try again stays.
- Ambiguous outcomes (`failed`, lost or malformed replies, timeouts, a failed signed verification)
  keep "The purchase wasn't confirmed." / "If you were charged, Restore purchase will find it."
- Native code is unchanged. The sandbox pre-charge installation check stays fail-closed: an
  unverified installation still never charges.
- No analytics events. Browser cards are unchanged: no browser state means "never dispatched".

## Tests (written first, must fail on main)

- `apple-pro-host.test.ts`: native `"unavailable"` Buy yields `{ state: "failed", notCharged: true }`
  on `props()` and `settings().pro`; native `"failed"` Buy keeps plain `failed`; offer re-read
  failure is `notCharged`; the existing account-replacement test expects `notCharged` for Buy only.
- `apple-pro-host.integration.test.ts` (real bridge parsing, mounted UI): native `"unavailable"`
  Buy shows the new copy and not the "wasn't confirmed"/"If you were charged" text; a native
  `"failed"` Buy keeps the old copy.
- `NativeProOfferCard.test.ts` and `PurchaseView.test.ts`: the flag switches the copy and keeps
  Try again; without it the old copy shows.

## Retest (owner)

MAC-46 and IOS-44/45 preconditions with no sandbox tester signed in: Get Still Pro must show the new
copy, never "If you were charged". With a tester signed in the normal purchase still opens Apple's
sheet.

## Risks

- Claiming "Nothing was charged" wrongly would be worse than the old copy. Mitigated by setting the
  flag only for outcomes that are proven pre-charge, never while an earlier acquisition is pending.
