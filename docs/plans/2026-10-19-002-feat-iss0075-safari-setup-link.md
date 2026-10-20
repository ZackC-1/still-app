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

### Review follow-ups

9. Rating hold: StillKit `SafariSetupSheetLifecycle` holds `RatingHold` `.setup` (a new
   `RatingHold.hold(_:)` token that counts once and ends itself if released) from present until
   the sheet is gone, so Apple's review sheet cannot appear over it when the person returns from
   Settings. It ends on Close, Escape, "I've turned it on", a confirming Check again and the iPhone
   swipe down (the sheet's hosting controller reports a dismissal in `viewDidDisappear`).
10. Close runs once and dismisses only the sheet it presented (captured at present time), so two
    quick taps, or Check again plus Close, never dismiss twice or pick another sheet on the Mac.
11. Page refresh: once the sheet is gone, native dispatches the fixed DOM event
    `still:safari-setup-closed` (StillKit `SafariSetupSheetRequest.closedEvent`, pinned to core's
    `SAFARI_SETUP_CLOSED_EVENT`). `watchAppleSetup` re-reads the setup state on it and on window
    focus, so the Mac's extension-off card drops without a visibility change.
12. Wording: with Still confirmed on, the sheet's primary button reads "Done" (onboarding keeps
    "Continue"). Check again stays visible before iOS 26.2, as on onboarding (owner copy call).
13. The WebKit QA lane's native model answers `presentSafariSetup` the way the router does.

## Tests

- StillKit: `SafariSetupSheetTests` (exact shape, trusted frame, active app, reply),
  `SafariSetupSheetLifecycleTests` (hold while up, close once, swipe then close, release on
  deinit, token counts once, event name) and three `OnboardingTests` cases for the answered check.
- Core vitest: `bridge-safari-setup-sheet.test.ts`; `AppleSettings.test.ts` (link order, click,
  disabled without opener, both platforms); `apple-settings-host.test.ts` (rendered host posts
  exactly one `presentSafariSetup` from a tap and nothing without activation, helper shape,
  `main.ts` wiring, re-read on the closed event and window focus, the Mac card dropping on the
  closed event, the event name pinned to the Swift source).
- WebKit QA lane: the shim refuses an extra key and answers `{ ok: true }`; a real click on
  "Safari setup" posts exactly one `presentSafariSetup`.

## Verification

- StillKit `swift test`: 509 tests, 0 failures.
- `xcodebuild build` (Debug, signing off) for "Still (iOS)" (iOS simulator) and "Still (macOS)":
  both succeed, no warnings in the changed files.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (core 5567 passed), `pnpm build`: pass.
- `pnpm exec playwright test --project=fixtures` (unconfigured lane): 356 passed, 25 skipped.
- WebKit QA lane (V3 opt-in builds): the two new cases pass; 21 passed, 3 failed, and the same
  three fail on main (shipped-entry onboarding, the D12 fill diagnostic, the Safari paid-off page).
- iOS 26 simulator (QA lane, light): the sheet renders with Close, the iOS 26.2 direct-page steps,
  Open Settings, Check again and "I've turned it on".

## Residual risks

- On iOS 26.2 and later Apple rate-limits the direct Safari extension page open to about two a
  minute. The sheet is a third place that spends it (with onboarding and the extension-off card).
- After that fallback the person lands on Still's own Settings page while the sheet's steps still
  describe the extension page.

## Not covered

No device run. The owner check: on iPhone and Mac, tap Safari setup in Help, confirm the sheet,
tap Open Settings (iPhone: Settings › Apps › Safari › Extensions › Still on iOS 26.2+; Mac:
Safari › Settings › Extensions), return, tap "I've turned it on" or Check again (closes), and
Close. The Help card link itself was not seen on the simulator: on a fresh unsigned simulator the
settings screen shows "Settings are unavailable" with Try again, the same on main without this
change, so the link is covered by the component and host tests only.
