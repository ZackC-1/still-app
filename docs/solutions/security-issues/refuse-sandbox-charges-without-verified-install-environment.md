---
title: Refuse sandbox Apple charges until Apple confirms a sandbox installation
category: security-issues
track: bug
problem_type: security_issue
module: apps/apple/StillKit
applies_when: A build configured for sandbox purchases calls StoreKit or RevenueCat to charge
date: 2026-10-08
status: active
tags:
  - payments
  - storekit
  - sandbox
  - qa
---

# Sandbox charges need a pre-charge installation check

Classifying a purchase as Sandbox or Production from the verified transaction is too late: StoreKit has
already charged. A paid-sandbox QA build that ever ran as an App Store installation would take a real
payment before the sandbox backend refused the production proof.

[NativeSalesPurchaseBoundary](../../../apps/apple/StillKit/Sources/StillKit/NativeSalesPurchaseBoundary.swift)
now takes Apple's verified installation environment (`AppTransaction.environment`). When the policy
runtime is sandbox (`ProductPolicyRuntime.requiresSandboxInstallation`: sandbox route or sandbox
context) it charges only for a verified `.sandbox` or `.xcode` installation. Production, unverified,
unreadable, a timed-out read and an OS before iOS 16 / macOS 13 all refuse, with no fallback. The
attestation parameter defaults to `.unavailable`, so a sandbox caller that forgets it is refused.
Production builds and Restore are unchanged.

## Ordering details that review caught

- The new await is a suspension point. Ask the sales policy again **after** Apple answers: a fresh
  approval lasts five seconds and Apple can take far longer.
- Bound the read and cancel it on timeout, or a late answer or App Store sign-in sheet overlaps the
  next Buy tap.
- Keep the identity re-check inside the charge closure, after every await and immediately before
  `Purchases.shared.purchase`.
- `MonetizationConfigTests` limits where the app asks Apple for its app transaction, because that can
  raise a sign-in sheet while Still sells nothing. Admit the new read by exact count per file and pin
  it structurally to the pre-charge function; comparing a `Set` of files let a second read through.
