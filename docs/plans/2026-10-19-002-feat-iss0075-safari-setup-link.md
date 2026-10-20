---
title: "Safari setup" link in the app's Help card opens onboarding screen 3 as a sheet (ISS-0075)
date: 2026-10-19
status: implemented (awaiting review and the owner device check)
issue: ISS-0075
related: ISS-0074 (direct Safari extension page on iOS 26.2+), ISS-0082 (setup card when off)
---

# "Safari setup" link in the Help card

## Owner decision (19 Oct 2026)

Add a "Safari setup" link to the Help card on the iPhone and Mac apps. It opens onboarding screen 3
("Turn on Still in Safari") as a sheet with the same steps and buttons. Open Settings goes where
ISS-0074 goes. "I've turned it on" (or a successful check) closes the sheet instead of advancing
onboarding, and there is a plain way to close it. First-run onboarding does not change.

## Change

1. Core `AppleSettings.svelte`: a "Safari setup" link after "Setup guide" in the condensed Help
   card (same `link` style, disabled when the host supplies no opener). `help.onSafariSetup` is new
   in `AppleSettingsProps`; `appleSettingsHelp(open, safariSetup?)` supplies it.
2. Core `bridge.ts`: a new hand-routed kind `{ kind: "presentSafariSetup" }` posted by the
   standalone `presentNativeSafariSetup()`, from a tap only (the same user-activation check as
   `openNativeDestination`), true only for `{ ok: true }` within the deadline.
3. App entry `main.ts`: the D04 help wiring passes `() => void presentNativeSafariSetup()`.
4. StillKit `SafariSetupSheetRequest`: refuses anything but exactly that one key, an untrusted
   frame, or an inactive app. `OnboardingStatusObserver.refresh(check:then:)` lets a "Check again"
   tap get the answer it read (joining a read in flight, never answering an abandoned one).
5. App `WebBridgeRouter`: routes the kind; `ViewController` supplies the presenter.
6. App `OnboardingPresenter.presentSafariSetup(from:)`: presents `OnboardingView` on screen 3 with
   `onClose` set (form sheet on iOS, swipe also closes; the existing fixed-size sheet on macOS).
   It never touches `OnboardingGate` and refuses while anything else is presented.
7. App `OnboardingView`: with `onClose` set, a Close button (Escape on the Mac) replaces the
   progress dots, the primary button closes the sheet, and "Check again" closes it when the read
   confirms Still is on. The background poll only updates the badge, as on screen 3, so opening the
   sheet while Still is already on does not close it by itself. Without `onClose` nothing changes.
8. DEBUG-only QA hook `STILL_QA_SAFARI_SETUP=1` shows the sheet after the settle time, so the
   headless simulator lane (no Simulator app to tap) can capture it.

## Tests

- StillKit: `SafariSetupSheetTests` (exact shape, trusted frame, active app, reply) and three
  `OnboardingTests` cases for the answered check.
- Core vitest: `bridge-safari-setup-sheet.test.ts`; `AppleSettings.test.ts` (link order, click,
  disabled without opener, both platforms); `apple-settings-host.test.ts` (rendered host posts
  exactly one `presentSafariSetup` from a tap and nothing without activation, helper shape,
  `main.ts` wiring).

## Verification

- StillKit `swift test`: 503 tests, 0 failures.
- `xcodebuild build` (Debug, signing off) for "Still (iOS)" (iOS simulator) and "Still (macOS)":
  both succeed, no warnings in the changed files.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`: pass.
- iOS 26 simulator (QA lane, light): the sheet renders with Close, the iOS 26.2 direct-page steps,
  Open Settings, Check again and "I've turned it on".

## Not covered

No device run. The owner check: on iPhone and Mac, tap Safari setup in Help, confirm the sheet,
tap Open Settings (iPhone: Settings › Apps › Safari › Extensions › Still on iOS 26.2+; Mac:
Safari › Settings › Extensions), return, tap "I've turned it on" or Check again (closes), and
Close. The Help card link itself was not seen on the simulator: an unsigned simulator build has
no App Group container, so its settings screen shows "Settings are unavailable".
