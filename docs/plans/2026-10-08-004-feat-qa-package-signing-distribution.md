---
title: "Installable, signed sandbox QA packages for every supported surface"
status: active
date: 2026-10-08
owner_lane: Claude Code L1-L2 (signing, distribution, package assembly); coordinator owns backend, hosted activation and mobile capabilities
branch: feat/v31-qa-packaging-signing-20261008
---

# Sandbox QA package signing and distribution

## Goal

Personally installable QA packages for Chrome desktop, Firefox desktop and Android, Still and Safari
on Mac, and Still and Safari on iPhone (iPad is an owner exception: no device). Each package must be
built from one matched source and configuration cohort, carry an identity that cannot be confused
with or replaced by a store build, and be incapable of a real charge.

## Routes chosen

| Surface | Route | Why | External action |
|---|---|---|---|
| Chrome | Unpacked folder in a separate Chrome profile, named "Still QA Sandbox (not for release)" | No store involvement; the store can never update it | None |
| Firefox desktop + Android | Separate never-listed add-on `still-qa-sandbox@chartash.com`, signed on AMO's unlisted channel (`scripts/qa/firefox-qa-sign.mjs`) | Persistent install on both platforms; the public listing (where Continue can publish) is never touched; listed updates can never replace it | Owner AMO API key, then approval of the first `--submit` |
| iPhone | Development-signed `Still.ipa` (`apple-ios-device`) installed on the owner's registered iPhone | Device-limited builds cannot be submitted to the App Store; StoreKit uses the sandbox; no upload | Owner says "go" with the iPhone unlocked |
| Mac | Development-signed `Still-mac.zip` (`apple-macos-device`) for this registered Mac | Same as iPhone | Owner replaces the App Store app while testing |

TestFlight stays a later option. The local App Store export currently fails because the Xcode-managed
store profiles predate the Distribution certificate created on 8 October; regenerating them is a
portal write that needs separate approval.

## Done (local branch, not pushed)

- `04fa4cb5` QA package identity: separate Firefox id and visible QA name; refused without the sandbox
  route and sandbox access trust; never forwarded into store packages. 486 extension unit tests and
  48 QA/release script tests pass; real WXT builds checked.
- `95e0bbb7` Development-signed Apple device targets with signing verification (team, device-limited
  unexpired profile, bundle id, App Group in both bundles). Checked on real exports.
- `01cd813d` AMO unlisted signer: refuses the store id, credentials only from a private 0600 file,
  JWT only to AMO, no automatic retry after an upload, signed payload compared with the upload.
- Pipeline rehearsal with placeholder public inputs: all four targets (`apple-ios-device`,
  `apple-macos-device`, `firefox`, `chrome`) built and issued receipts from a clean tree at
  `01cd813d`. Outputs quarantined as NOT-A-CANDIDATE; never installed.

## Remaining

1. Real public inputs for the cohort: hosted sandbox access public key, QA Supabase URL and
   publishable key, Apple RevenueCat `appl_` key (coordinator, after U6 activation).
2. Native pre-purchase environment guard (refuse checkout unless `AppTransaction` reports sandbox or
   Xcode): proposed to the coordinator as a P1.
3. Firefox: owner AMO API key and approval; a unique QA version for each signing.
4. Build the matched cohort, sign, install on the owner's devices, verify persistence after restart,
   and record artifact hashes, versions and device/OS/browser versions in the owner QA status sheet.
5. Analytics test designation: `docs/plans/2026-10-08-005-feat-qa-analytics-test-designation.md`.
6. Before any App Store archive (production phase): `apps/apple/scripts/release-env-state.mjs` and the
   web build stamp report only configuration/modern/atomic state, so a stray QA-only setting
   (`VITE_ANALYTICS_BUILD_CHANNEL`, `VITE_PACKAGE_IDENTITY`, or the earlier sandbox route/trust names)
   in a developer shell or package `.env` file would reach an Apple store archive. Add a set/unset
   token for every `DELIBERATELY_UNPACKAGED` name and refuse it in `archive.sh` (paid-sandbox QA builds
   must keep working). Chrome and Firefox store packaging already strips them.

## Verification still owed

Nothing here establishes provider, hosted-backend or physical-device acceptance. Installed-device
journeys, sandbox purchases, refunds, Restore and transfer remain owner QA rows.
