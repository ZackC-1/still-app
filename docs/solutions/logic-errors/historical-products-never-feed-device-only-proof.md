---
title: A historical product must never feed device-only purchase proof
category: logic-errors
track: bug
problem_type: logic_error
module: apps/apple/Still/Shared (App)/Purchases/PurchaseManager.swift
applies_when: Adding or reading an Apple product in a device-only ownership, evidence, purchase or Restore path
date: 2026-11-06
status: active
tags: [apple, storekit, entitlements, historical-purchase, ISS-0132]
---

# A historical product must never feed device-only purchase proof

An Apple ID whose only Still purchase was the 1.x/2.x product `still_sync` was stuck on "Still Pro
needs to be verified again." on iPhone and Mac, with no Get Still Pro button, a Restore that did
nothing and Safari Pro rows that looked unlocked but would not toggle (ISS-0132, TestFlight 3.0
(12)).

## Root cause

The device-only paths scanned `ApplePurchaseCatalog.all` (`still_pro_v3` and `still_sync`), but
the server accepts only `still_pro_v3` as device evidence (`isAppleEvidence` in
`supabase/functions/_shared/apple-access.ts`). So a verified `still_sync`:

- made the ownership read report purchase history, which resolves every Pro row to
  `verification_required`, and the card offers Get Still Pro only when ownership is `none`;
- made Restore report "restored", after which the device verification sent `still_sync` evidence
  and got HTTP 400, leaving the state at verify;
- made the check before a purchase say "already owned", so even a shown Buy would not reach Apple.

Every piece was correct alone; the mismatch was between what the device counted and what the
server would ever accept.

## Fix

`ApplePurchaseCatalog.deviceProofProducts` (`[stillProV3]`) is the only list the device-only paths
read: the ownership scan (`AppleOwnershipScan`, now in StillKit so the rule is tested), the local
purchase evidence, the V3 purchase pre-check (receipt and RevenueCat entitlement) and the Still Pro
Restore check and reply. The historical product is still read for refunds (published, never
counted), and `all` stays for account linking, the RevenueCat attach and the 2.x purchase path.

A historical-only device now reads exactly like a non-buyer. A separate display-only bridge fact,
`appleHistoricalPurchase`, lets the page ask a signed-out holder "Bought Still Pro before? Sign in
to restore it." instead of offering a purchase. Signed in, the server's paid legacy right
(`revenuecat-access.ts`) restores Still Pro; without one the person gets the ordinary offer.

## Rule

Device-only proof may count only a product the server accepts as device evidence. When a product
is restored through some other authority (an account), surface it as a separate, non-granting fact
and route the person to that authority. Never let it set an ownership state that only the device
verification could clear.

## Verification

StillKit `swift test` (545 tests, including `HistoricalPurchaseDeviceProofTests`: historical-only
history reads as no purchases and locks rows in the app and in Safari; refunds still publish;
source checks pin the wiring). Vitest covers the host, card, purchase screen, bridge reply and the
compiled purchase executor (a historical-only V3 Buy charges once; a `still_pro_v3` owner and the
2.x path never charge twice). Unsigned Xcode builds succeed for iOS Simulator and macOS. Not yet
verified on a device with a real `still_sync` purchase.
