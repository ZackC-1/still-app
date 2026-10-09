---
title: Deliver Apple sandbox QA builds as device-limited development exports
category: conventions
track: knowledge
module: apps/apple/scripts
applies_when: Producing installable iPhone or Mac QA packages that must never take a real payment or reach the App Store
date: 2026-10-08
status: active
tags:
  - qa
  - apple-signing
  - storekit
  - distribution
---

# Apple QA builds: device-limited development exports

A QA build for the owner's own devices does not need TestFlight. The `apple-ios-device` and
`apple-macos-device` targets in [paid-sandbox-qa.mjs](../../../apps/apple/scripts/paid-sandbox-qa.mjs)
archive, then export with Apple's development (`debugging`) method to a local folder, without
`-allowProvisioningUpdates` and without upload. A device-limited profile cannot be submitted to the
App Store, and StoreKit in a development build only uses the sandbox. No portal state changes.

## What went wrong first

- **Reading identity counts from certificate names.** `security find-identity` shows
  `Apple Development: Name (XXXXXXXXXX)`, where the parenthesised value is the certificate's own id,
  not the team. Counting team identities from that string reported zero Development identities. The
  team is the leaf certificate's OU; check it with
  `security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject`.
- **Assuming App Store profiles stay valid.** Creating a new Apple Distribution certificate leaves the
  existing Xcode-managed App Store profiles bound to the old one, so a local App Store export fails
  with "Provisioning profile … doesn't include signing certificate". Fixing it means regenerating the
  profiles, which is a portal write that needs approval. Development profiles were unaffected.

## Checks that make the export safe to hand over

The receipt is refused unless both the app and the Safari extension carry the reviewed team's
unexpired profile for the exact bundle id, with a non-empty device list and not all devices, and the
shared App Group appears in the **signed** entitlements. Profiles are decoded in a temporary directory
outside the bundle, the bundle is re-verified with `codesign --verify --deep --strict` right before it
is packaged, and a refused export, archive and DerivedData are removed on every exit. Receipts carry
device counts and expiry dates, never device identifiers.

## Owner-facing consequence

The QA app shares the store app's bundle id, so installing it replaces the App Store app on that
device until the owner reinstalls from the App Store. Say so before installing. Purchases show
Apple's "[Environment: Sandbox]" label; tell the owner to cancel if it is missing.
