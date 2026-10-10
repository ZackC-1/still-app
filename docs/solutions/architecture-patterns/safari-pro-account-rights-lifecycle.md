---
title: Carry a signed-in account's Still Pro rights into Safari, and take them away again
category: architecture-patterns
track: feature
problem_type: authentication_error
module: StillKit
applies_when: Changing how the Apple app or the Safari extension reads, keeps or removes account-held Still Pro rights (web purchases, linked Apple purchases) in paid builds
date: 2026-10-10
status: active
tags:
  - entitlement
  - apple
  - safari
  - signed-proof
  - paid-tier
---

## Problem

Owner decision (10 Oct 2026), "one purchase everywhere": a Still Pro purchase made on the web must
unlock the Mac and iPhone apps and their Safari extensions for the same signed-in account. The app
already fetched, verified and stored the account's server-signed proofs (`reconcileAccountAccess`
→ `NativeAccountAccessRuntime` → `installAccountAccess`) and its own Pro screen read them. The
Safari extension, which applies the extras, did not, and once it could, nothing took the rights
away again for an ended account.

## What went wrong

- **Wrong reply lane.** `SafariWebExtensionHandler` answers `getBenefitAccess` under `entitlement`;
  the Safari background read `settings`. Paid builds never got a snapshot, Apple purchases included.
  Fixed through a folded `if (PAID_TIER_ENABLED)` branch (`lib/native-benefits.ts`).
- **No account in the read.** The read-only bridge resolved benefits with an empty context, so an
  account-held proof never matched its holder. `EntitlementBridge.safariExtension` now reads under
  the account and session the app itself verified with hosted Auth and committed to the record.
- **Ended accounts kept Pro.** A failed Auth check left the binding and proofs, so Safari stayed
  Pro for up to the 30-day proof window after a deletion or revoked session.
- **"Verify Still Pro" forever.** With no StoreKit evidence of its own, Safari could never say
  "locked", so non-buyers never reached See Pro.

## Rules that now hold

**Removing account rights.** Native asks hosted Auth for a three-way answer
(`NativeAccessSessionCheck`). Only `user_not_found`, `session_not_found` or `user_banned` on a
401/403/404, read from either the default (`error_code`) or the 2024-01-01 (`code` string) error
format, is a refusal. The router clears account rights (`clearAccessAccount`) only when the
refused token's own subject is the account still bound, with unchanged lineage. Offline, timeouts,
5xx and an expired token (`bad_jwt`) keep everything.

The web view reads the SDK bearer before verifying it, because supabase-js discards a revoked
session and announces sign-out (advancing the account epoch) before `getUser` rejects. That
held-token hand-off to native is deliberately not gated by the epoch; native's subject check is
the scope. If the SDK holds no session at all, the app ends its session the ordinary way, which
publishes signed-out to native.

Accepted trade-off: the SDK can also drop a session after some refresh failures once the token has
expired (a 429 or an unparseable 4xx). Still treats that as signed out. It only ever removes
access, and signing in again restores it.

Refunds need no extra path: the server keeps revocations and returns all of them on every
successful reconcile, and `installAccountAccess` removes any known right they name.

**Locked versus verification required (display only).** The app records its conclusive StoreKit
answer and each reconcile's answer (`OwnershipEvidence`, paid mode only, explicit members so a
rewrite replaces the stored value). Safari shows Pro rows "locked" only when:

- the Apple answer was "no purchase" within seven days (`ownershipAbsenceWindowMilliseconds`,
  no clock rollback), and
- the account the app displays matches the record: no account on both sides, or the same account
  with a fresh "none" answer for the current session generation.

Between sign-in and the first successful check, after a refusal while the app still shows the
account, or with an unreadable display status, the answer is "verification required".

Accepted, display only: a seven-day-old "no purchase" can still show Locked after a purchase on
another device until the app checks again, and a fresh device's StoreKit `.noPurchases` counts as
an Apple "none". Neither grants anything; See Pro opens the app, which checks again.

## Verification

- `SafariAccessLaneTests`, `NativeAccountAccessTests` (StillKit `swift test`), and
  `native-account-router.test.ts`, which compiles and runs the real router arm.
- `apple-purchase-authority.test.ts` covers the production SDK order (sign-out before rejection).
- Shipped 2.x bundles stay byte-identical: see
  [add paid-only code without changing shipped bundles](../conventions/add-paid-only-code-without-changing-shipped-bundles.md).
