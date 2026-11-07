---
title: StoreKit decides a purchase the store SDK reports late or wrong
category: logic-errors
track: bug
problem_type: logic_error
module: apps/apple/Still/Shared (App)/Purchases/PurchaseManager.swift
applies_when: Mapping a native Apple purchase, Restore or bounded bridge wait into what the page shows, or reading a background right install into the settings screen
date: 2026-11-07
status: active
tags: [apple, storekit, revenuecat, purchase, entitlements, ISS-0134, ISS-0136, ISS-0137]
---

# StoreKit decides a purchase the store SDK reports late or wrong

TestFlight 3.0 (13), production backend, owner QA on 7 November 2026:

- ISS-0136 (blocker): a signed-in sandbox purchase the owner confirmed on Apple's sheet ended at
  "The purchase wasn't confirmed. If you were charged, Restore purchase will find it." PostHog had
  `purchase_started` then `purchase_failed reason unknown` 15 s later. The production functions saw
  no `verify-apple-access` call. Tapping Restore purchase then verified the same purchase (HTTP 200)
  and unlocked Still Pro.
- ISS-0134 (minor): a sheet left to time out came back as "Your purchase needs to be verified."
  with no `purchase_cancelled`; the `purchase_failed reason unknown` arrived 121 s after
  `purchase_started`.
- ISS-0137 (major): on the Mac, the launch-time local verification installed a device right in the
  background, but the Pro card kept "Still Pro needs to be verified again." until a relaunch.

## Root causes

**ISS-0136.** The card copy "wasn't confirmed" without a verify line is reachable only through the
host's catch with no pending verification (`apple-pro-host.ts` `transact`). A rejected or slow
bridge reply becomes `pending` (`boundedNativeRead`), and a thrown verification keeps the verify
line, so both are excluded: native replied `outcome: "failed"` after the sheet. The only post-sheet
`failed` is the store SDK's `purchase(package:)` throwing after Apple completed the charge
(`PurchaseManager.purchaseStillPro` catch). Its reply still carried `receipt: entitled` and
`productId: still_pro_v3` (the post-purchase receipt read), and both `ApplePurchaseActionResult`
and the web `parseProResult` ignored the receipt for a failed outcome, so the host threw and never
ran the local verification that Restore runs from the same `verifyLocalPurchase`.

**ISS-0134.** `PurchaseManager.purchasePro` bounded one page wait at 120 s with
`fallback: .pending`. `pending` means "the store accepted, verify later", so the host set a pending
verification, ran it, found no transaction, and showed the sticky verify copy. The 121 s gap in
PostHog is that bound.

**ISS-0137.** `main.ts` ran `authority.verifyLocalPurchase()` at launch, which installs the right
natively and reads benefits directly, while the screen reads the settings authority's
`EntitlementCache`, which next asks native at its minute refresh. Nothing told the cache a right
had just been installed. The code does not explain the further minutes the owner saw; the new
native log lines (`access: benefit read with StoreKit ...`, every `bridge: ... refused: ...`) show
what each minute read resolved or which guard refused it.

## Fix

- StoreKit is the authority after an SDK failure. `AppleSDKPurchaseFailure.classify` (StillKit,
  tested) turns a thrown SDK purchase into `purchased` when the sellable receipt now reads entitled
  (the pre-flight was not entitled, so that is this charge), `pending` only for the SDK's own
  Ask-to-Buy error, else `failed`. `ApplePurchaseActionResult` and `parseProResult` both map a
  `failed` or `staleIdentity` with an entitled `still_pro_v3` receipt to `pending`, so the page
  verifies locally. The host's own `failed` Buy branch runs `verifyLocalPurchase` once before
  showing "wasn't confirmed": owned is the purchase, a held install keeps verification recovery,
  nothing on the device keeps the failed card with Try again, never a verify state.
- A bounded wait is `unsettled`, never `pending`. The host waits again with
  `purchasePro(offer, { join: true })`, which native answers from the purchase already in flight
  (or the result that settled meanwhile, `unclaimedPurchaseResult`), never a second charge. Waits
  that run out end as one `purchase_cancelled`, as a closed sheet does, and never emit
  `purchase_failed`.
- `createAppleSettingsAuthority` takes `pendingLocalVerification`; when it fulfils, the cache is
  read twice (finish any read in flight, then read the committed record). `main.ts` passes the
  launch verification.
- `staleIdentity` is refused before any charge, so the page now says nothing was charged.
- Evidence reads retry pending revocation commits before the fence can refuse them, and every
  refusal on the purchase, Restore, evidence and benefit paths is logged with its fixed reason and
  the fence state (no identifiers).

## Rule

A store SDK's error after Apple's sheet is not the outcome; the device's verified receipt is. Any
reply that carries an entitled sellable receipt goes to the same local verification Restore uses.
A bounded wait that ends before the store answers is unknown, not accepted: never label it
`pending`. When native changes the access record in the background, hand the page's cache a reason
to read again instead of waiting for its timer.

## Verification

- StillKit `swift test`: 554 tests, 0 failures, including `AppleLifetimeOfferingTests`
  (failed+entitled is pending, unsettled passes through), `PurchaseDecisionTests` (the SDK failure
  rule) and `PurchaseConfirmationWiringTests` (the app wires the rule, the unsettled bound, the
  join, the evidence retry and the logs).
- `apple-pro-host.test.ts`, `apple-pro-host.integration.test.ts` and `native-pro.test.ts`: the
  rescue through local verification, the failed card without a verify state, the unsettled join
  loop ending in one cancel, the stale-identity copy, the bridge mapping.
- `apple-settings-host.launch-verification.test.ts`: the cache reads again when the launch
  verification installs a right, finishes an in-flight read first, and reads nothing after stop
  or a rejected verification.
- Device QA still has to confirm: which SDK error domain and code the sandbox purchase produces
  (now logged), that the purchase completes on iPhone build 14, and what the minute benefit reads
  resolve on the Mac.

## Related

- [Preserve restore feedback through local purchase verification](preserve-restore-feedback-through-local-verification.md)
- [A historical product must never feed device-only purchase proof](historical-products-never-feed-device-only-proof.md)
- [Verify signed Apple local rights before atomic native install](../security-issues/verify-signed-apple-local-rights-before-atomic-native-install.md)
