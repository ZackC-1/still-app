---
title: iPhone app shows "Turn on Still in Safari" when the extension is off (ISS-0082)
date: 2026-10-19
status: implemented (awaiting review and the owner device retest)
issue: ISS-0082
related: ISS-0074 (direct Safari extension page on iOS 26.2+), ISS-0075 (setup guidance any time)
---

# iPhone app shows "Turn on Still in Safari" when the extension is off

## Problem

Owner rule (19 Oct 2026): when Still is not enabled (the Safari extension is switched off later),
the app shows on open a note that it is not enabled plus the steps to turn it back on. The Mac app
does this through the settings screen's setup card; the iPhone app never shows it.

## Cause

The card is built only for a macOS "disabled" observation. On iOS the web view's
`safariSetupState` reply is forced to `{ extensionStatus: "unknown", enableLocation:
"settingsAppStillPage" }` by `SafariSetupObservation`, even though since ISS-0074 the app reads the
real state on iOS 26.2+ (`SFSafariExtensionManager.stateOfExtension`) and can open Still's Safari
extension page directly (`SFSafariSettings.openExtensionsSettings`). The web view also cannot ask
native to open that page: `NativeOpenDestination` allows only Still's app page on iOS.

## Change

1. StillKit `SafariSetupObservation`: an iOS observation whose enable location is the direct
   Safari extension page (only declared on iOS 26.2+, where the state is readable) keeps its real
   status and replies `enableLocation: "settingsAppSafariExtensionPage"`. Any other iOS
   observation keeps the old shape (unknown, app page). macOS unchanged.
2. StillKit `NativeOpenDestination`: a new `settingsAppSafariExtensionPage` destination, allowed on
   iOS only when the host says the direct page exists (`extensionPageAvailable`). The router passes
   `SafariExtensionBridge.enableLocation == .settingsAppSafariExtensionPage`.
3. App `SafariExtensionBridge`: one shared helper opens the direct page (ISS-0074 call) and falls
   back to Still's app page when the system refuses (Apple rate-limits this open to about two per
   minute). The SwiftUI onboarding and the web view's `openDestination` both use it. A fallback
   replies "open failed" so the reply never names a page that did not open.
4. Core `bridge.ts`: the iOS direct-page observation shape is accepted by the parser; anything
   unrecognised is still null. `NativeOpenDestination` gains the new value.
5. Core `appleSettingsSetup`: an iOS "disabled" observation shows the card: same title and detail
   as the Mac, the three owner-approved direct-page steps from `OnboardingCopy.enableSteps`
   (one TypeScript constant, pinned to the Swift source by a test), action "Open Settings" that
   opens `settingsAppSafariExtensionPage`. Unknown, missing or late observations never show it.
6. Foreground re-read: `watchAppleSetup` already re-observes on `visibilitychange`; no change.

## Tests (red before the fix, green after)

- StillKit: `SafariSetupObservationTests` (iOS direct page keeps real status; old iOS shape kept),
  `NativeOpenDestinationTests` (iOS direct page only when available; never on macOS).
- Core vitest: `bridge-safari-setup-state.test.ts` (new shape accepted, mismatched pairs rejected),
  `bridge-open-destination.test.ts` (new destination posts), `apple-settings-host.test.ts` (iOS
  card, opener, steps pinned to Onboarding.swift, rendered host posts the fixed destination).

## Verification

- Red first: the rewritten StillKit tests failed (`SafariSetupObservationTests`: 8 assertion
  failures in the new direct-page test; `NativeOpenDestinationTests`: did not compile without the
  new destination and flag). Nine new core vitest cases failed before the TypeScript change.
- StillKit `swift test`: 493 tests, 0 failures.
- `xcodebuild build` (Debug, signing off) for "Still (iOS)" on the iOS simulator SDK and for
  "Still (macOS)": both succeed with no warnings in the changed files.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (core 5508 passed), `pnpm build`: pass.
- `pnpm exec playwright test --project=fixtures`: unconfigured lane 356 passed, configured lane
  (synthetic public configuration rebuild, as CI does) 199 passed.

## Not covered

No device build or on-device run from this lane. The owner's iPhone retest is required: turn the
extension off in Settings, open Still (card shows), tap Open Settings (lands on Still's Safari
extension page), turn it on, return (card gone without relaunch). Earlier-than-26.2 iPhones are
covered by tests only (no runtime or device). The paid-tier-on Playwright lane was not run here;
this change does not touch the extensions.
