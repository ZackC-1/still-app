---
title: iPhone onboarding opens Still's Safari extension page directly on iOS 26.2+ (ISS-0074)
date: 2026-10-18
status: active
issue: ISS-0074 (major)
related: ISS-0075 (setup guidance reachable at any time; design pending the owner)
---

# iPhone onboarding opens Still's Safari extension page directly on iOS 26.2+

## Problem

On a fresh install of 2.1.1.383 (iPhone 17 Pro, iOS 27.0.1), onboarding screen 3 "Turn on Still in
Safari" has an Open Settings button that landed on Settings → Still ("Allow Still to Access": Apple
Intelligence & Siri, Search, Cellular Data). Nothing there is about Safari. The written step "then
tap ‹ Settings" did not match iOS 27 either, where the back control is a bare chevron. The owner:
"telling people how to get the app working is one of the most critical steps", and wants Open
Settings to land straight on Settings → Apps → Safari → Extensions → Still.

## Cause

`SafariExtensionBridge.enableLocation` returned `.settingsAppStillPage` on every iOS version and
`openEnableLocation()` used `UIApplication.openSettingsURLString`, by design: the deployment target
is iOS 15, and the direct API arrived only in iOS 26.2. The code's own comments said an availability
fork was the way to use it. The step copy quoted the back button's label, which iOS 26 removed.

## Change

- StillKit `Onboarding.swift`: a third `EnableLocation`, `.settingsAppSafariExtensionPage` (iOS
  26.2+, `SFSafariSettings.openExtensionsSettings(forIdentifiers:)`). `OnboardingCopy.enableSteps(
  for:iOS18OrLater:)` writes the steps for the destination: three steps for the direct page ("Tap
  “Open Settings” below", "Turn on Allow Extension, then allow Instagram, Facebook, YouTube, and
  TikTok", "Close Safari, then reopen it"); the walk-through for the app page keeps four, and its
  step 1 now reads "Tap “Open Settings” below, then go back", which is true whether or not the back
  control carries a label. Both iPhone buttons read "Open Settings". Copy stays minimal (owner).
- `SafariExtensionBridge.swift`: on iOS 26.2+ `enableLocation` is the extension page,
  `openEnableLocation()` opens it (falling back to the app's page if the system refuses), and
  `currentStatus()` reads the live enabled state through `SFSafariExtensionManager`, so the badge
  and the primary button ("Continue" once enabled) work on the iPhone as on the Mac. The state
  read is bounded to two seconds, because the rating prompt and the analytics context await it
  and a reply that never comes must not hold them. Earlier iOS is unchanged.
- `QAHooks.swift` / `OnboardingPresenter.swift` (DEBUG only): `STILL_QA_ONBOARDING_OPEN=1` performs
  the Open Settings action after the forced onboarding step, so the simulator lane can show where
  the button lands on a Mac without the Simulator app (this build Mac has none). The web view's `safariSetupState` reply keeps its one iOS shape (unknown, app page):
  `SafariSetupObservation` still coerces iOS to it, and `NativeOpenDestination` is unchanged, so
  the bundled web UI's parser and the iPhone inventory are unaffected. Carrying the direct page to
  the web view belongs to the ISS-0075 design.
- `OnboardingView.swift`: the steps come from the declared destination.
- Tests (`OnboardingTests.swift`, `SafariSetupObservationTests.swift`): per-destination step counts,
  site order, step 1 names the button, the label never claims Safari on a Settings-app page, only
  the walk-through reaches "Safari → Extensions", no quoted back-button label, the direct page's
  exact steps, and the unchanged web-view contract for the new location.

## Verification

- StillKit `swift test`: 492 tests, 0 failures (the first run failed to compile until the bridge
  reply's switch covered the new case, which the contract test now pins).
- `xcodebuild build` for "Still (iOS)" on the iOS 26.2 simulator and "Still (macOS)": both succeed.
- iOS 26.2 simulator (iPhone 17 Pro, debug build, `STILL_ONBOARDING_STEP=2`): screen 3 shows the
  three new steps and "Open Settings", and the badge is live: the state read answers
  `enabled=false` ("Not on yet") where the old build could only say "Turn it on in Safari".
- The Open Settings action on that simulator (through the DEBUG hook) opens the Settings app at
  its top level, with no error reported to the completion handler. The simulator's Settings app
  is not the device's, so this neither proves nor disproves the deep link; the owner's iPhone
  (iOS 27) is the device check. Known reports about this API (lapcat/SafariExtensions#71,
  FB21458882): it is rate-limited to two calls a minute, and on some betas it sometimes stops at
  the extension list instead of Still's page. A refused call falls back to the app's own page.
- No iOS simulator runtime earlier than 26.2 is installed on the build Mac, so the walk-through
  copy for older iOS is proven by `swift test` only; the owner has no older device.

## Owner retests

IOS-02, IOS-03, IOS-04 on a fresh install of the fixed package, and the ISS-0075 steps once that
design is agreed.
