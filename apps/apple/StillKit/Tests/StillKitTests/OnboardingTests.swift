import XCTest
import Combine
@testable import StillKit

/// The testable core of onboarding (U18): the screen-3 status copy and the first-launch gate. The
/// SwiftUI screens and the SFSafariExtensionManager probe are validated on-device (human checkpoint);
/// the pure logic the UI depends on is proven here.
final class OnboardingTests: XCTestCase {
  @MainActor private func expectStatus(
    _ expected: SafariExtensionStatus, from observer: OnboardingStatusObserver,
    after action: () -> Void
  ) async {
    let changed = expectation(description: "Badge becomes \(expected)")
    let observation = observer.$status.first(where: { $0 == expected }).sink { _ in changed.fulfill() }
    defer { observation.cancel() }
    action()
    await fulfillment(of: [changed], timeout: 1)
    XCTAssertEqual(observer.status, expected)
  }

  @MainActor func testLiveStatusTracksBothDirectionsAndCoalescesChecks() async {
    let observer = OnboardingStatusObserver()
    var next = SafariExtensionStatus.enabled
    var calls = 0
    let check: () async -> SafariExtensionStatus = { calls += 1; return next }
    await expectStatus(.enabled, from: observer) {
      observer.setActive(true, check: check)
      observer.refresh(check: check)
    }
    XCTAssertEqual(calls, 1)
    next = .disabled
    await expectStatus(.disabled, from: observer) { observer.refresh(check: check) }
    next = .enabled
    await expectStatus(.enabled, from: observer) { observer.refresh(check: check) }
  }

  @MainActor func testInactiveLateReplyCannotReplaceForegroundRead() async throws {
    let observer = OnboardingStatusObserver()
    let started = expectation(description: "Original read started")
    let returned = expectation(description: "Original read returned late")
    var oldReply: CheckedContinuation<SafariExtensionStatus, Never>?
    observer.setActive(true, check: {
      let result = await withCheckedContinuation { continuation in
        oldReply = continuation
        started.fulfill()
      }
      returned.fulfill()
      return result
    })
    await fulfillment(of: [started], timeout: 1)
    let reply = try XCTUnwrap(oldReply)
    observer.refresh(check: { XCTFail("An in-flight read must be coalesced"); return .unknown })
    observer.setActive(false, check: { .unknown })
    observer.refresh(check: { XCTFail("Inactive screen must not poll"); return .enabled })
    await expectStatus(.disabled, from: observer) {
      observer.setActive(true, check: { .disabled })
    }
    reply.resume(returning: .enabled)
    await fulfillment(of: [returned], timeout: 1)
    XCTAssertEqual(observer.status, .disabled)
    observer.setActive(false, check: { .unknown })
  }

  func testStatusHeadlinesMatchBrainstormCopy() {
    XCTAssertEqual(SafariExtensionStatus.enabled.headline, "You're all set")
    XCTAssertEqual(SafariExtensionStatus.disabled.headline, "Not on yet")
    XCTAssertEqual(SafariExtensionStatus.unknown.headline, "Turn it on in Safari")
  }

  func testOnlyEnabledIsConfirmed() {
    XCTAssertTrue(SafariExtensionStatus.enabled.isConfirmedEnabled)
    XCTAssertFalse(SafariExtensionStatus.disabled.isConfirmedEnabled)
    XCTAssertFalse(SafariExtensionStatus.unknown.isConfirmedEnabled)
  }

  // ── Screen-3 enable-step copy (OnboardingCopy) ─────────────────────────────────────────────────

  private let walkThroughs = [
    OnboardingCopy.enableSteps(for: .settingsAppStillPage, iOS18OrLater: true),
    OnboardingCopy.enableSteps(for: .settingsAppStillPage, iOS18OrLater: false),
  ]
  private var directPage: [String] { OnboardingCopy.enableSteps(for: .settingsAppSafariExtensionPage) }

  func testEnableStepCountsPerDestination() {
    for steps in walkThroughs { XCTAssertEqual(steps.count, 4, "the walk-through is four steps") }
    XCTAssertEqual(directPage.count, 3, "landing on the extension page leaves nothing to navigate")
    XCTAssertEqual(OnboardingCopy.macOSEnableSteps.count, 4)
    XCTAssertEqual(OnboardingCopy.enableSteps(for: .safariExtensionSettings), OnboardingCopy.macOSEnableSteps)
  }

  func testSiteListsFollowTheOwnerOrderInstagramFacebookYouTubeTikTok() {
    let order = ["Instagram", "Facebook", "YouTube", "TikTok"]
    let lists = walkThroughs.map { $0[2] } + [directPage[1], OnboardingCopy.macOSEnableSteps[2]]
    for line in lists {
      let positions = order.compactMap { line.range(of: $0)?.lowerBound }
      XCTAssertEqual(positions.count, 4, line)
      XCTAssertEqual(positions, positions.sorted(), "sites must read Instagram, Facebook, YouTube, TikTok: \(line)")
    }
  }

  func testIOSWalkThroughVariantsShareEverythingButTheSettingsPath() {
    let ios18 = walkThroughs[0]
    let earlier = walkThroughs[1]
    XCTAssertEqual(ios18[0], earlier[0], "step 1 is shared verbatim")
    XCTAssertEqual(ios18[2], earlier[2], "step 3 is shared verbatim")
    XCTAssertEqual(ios18[3], earlier[3], "step 4 is shared verbatim")
    XCTAssertNotEqual(ios18[1], earlier[1], "only the Settings path differs")
  }

  func testIOSSettingsPathMatchesEachOSGeneration() {
    XCTAssertEqual(
      walkThroughs[0][1],
      "Go to Apps → Safari → Extensions → Still",
      "iOS 18 moved Safari's settings under Apps"
    )
    XCTAssertEqual(walkThroughs[1][1], "Go to Safari → Extensions → Still")
  }

  func testTheWalkThroughNeverQuotesABackButtonLabel() {
    // ISS-0074: on iOS 26 the back control in Settings is a bare chevron, while earlier versions
    // label it "Settings". A step quoting either label is wrong for the other, so step 1 says to go
    // back without naming the control.
    for steps in walkThroughs {
      XCTAssertEqual(steps[0], "Tap “Open Settings” below, then go back")
      XCTAssertFalse(steps[0].contains("‹"), steps[0])
      XCTAssertFalse(steps[0].contains("tap Settings"), steps[0])
    }
  }

  func testTheDirectPageStepsAreTheSwitchTheWebsitesAndTheReopen() {
    // ISS-0074: on iOS 26.2 and later the button lands on Still's Safari extension page itself.
    XCTAssertEqual(
      directPage,
      [
        "Tap “Open Settings” below",
        "Turn on Allow Extension, then allow Instagram, Facebook, YouTube, and TikTok",
        "Close Safari, then reopen it",
      ])
  }

  func testStepOneNamesTheButtonUnderIt() {
    // The first thing onboarding asks a person to do is tap the button on the same screen, so the
    // step has to call it what the button calls itself. These two drifted apart once already, when
    // the button was renamed to one cross-platform phrase and the steps kept the old iOS and macOS
    // names, leaving first-launch users and App Review told to tap a control that was not there.
    for location in [EnableLocation.settingsAppStillPage, .settingsAppSafariExtensionPage, .safariExtensionSettings] {
      for iOS18OrLater in [true, false] {
        let steps = OnboardingCopy.enableSteps(for: location, iOS18OrLater: iOS18OrLater)
        XCTAssertTrue(
          steps[0].contains("“\(OnboardingCopy.openButtonTitle(for: location))”"),
          "step 1 must name the button as it reads: \(steps[0])"
        )
      }
    }
  }

  func testTheButtonLabelDescribesWhereThatButtonActuallyGoes() {
    // Matching the step is not enough. The pair agreed once on a phrase that was false: on iOS the
    // button opens the Settings app (Still's own page before iOS 26.2, Still's Safari extension
    // page from 26.2), because that is as close as a containing app can get. A label naming Safari
    // there promises a screen nothing opens.
    for location in [EnableLocation.settingsAppStillPage, .settingsAppSafariExtensionPage] {
      XCTAssertTrue(location.isSettingsApp)
      XCTAssertEqual(OnboardingCopy.openButtonTitle(for: location), "Open Settings")
      XCTAssertFalse(
        OnboardingCopy.openButtonTitle(for: location).lowercased().contains("safari"),
        "a Settings-app button cannot claim to open anything in Safari"
      )
    }
    // macOS does land in Safari's own settings, at the Extensions pane, through
    // SFSafariApplication.showPreferencesForExtension, so there the label says so.
    XCTAssertFalse(EnableLocation.safariExtensionSettings.isSettingsApp)
    XCTAssertTrue(
      OnboardingCopy.openButtonTitle(for: .safariExtensionSettings).lowercased().contains("safari"),
      "the Safari-settings button should say where it goes"
    )
  }

  func testOnlyTheJourneyThroughStillsAppPageWalksTheReaderToSafari() {
    // The count of steps is not the point; who has to do the walking is. Before iOS 26.2 the button
    // stops one screen short, so a step has to carry the reader the rest of the way. On macOS and on
    // iOS 26.2+ the button arrives, so no step should be sending them off to find it.
    for steps in walkThroughs {
      XCTAssertTrue(
        steps.contains { $0.contains("Safari → Extensions") },
        "the button stops at Still's page in Settings, so the steps have to reach Safari: \(steps)"
      )
    }
    for steps in [directPage, OnboardingCopy.macOSEnableSteps] {
      XCTAssertFalse(
        steps.contains { $0.contains("Safari → Extensions") || $0.contains("go back") },
        "the button already opened the extension's settings, so nothing should navigate there: \(steps)"
      )
    }
  }

  func testGateShowsUntilMarkedComplete() {
    let defaults = UserDefaults(suiteName: "still.onboarding.tests")!
    OnboardingGate.reset(defaults)
    XCTAssertTrue(OnboardingGate.shouldShow(defaults), "fresh install should show onboarding")

    OnboardingGate.markComplete(defaults)
    XCTAssertFalse(OnboardingGate.shouldShow(defaults), "completed onboarding must not re-show")

    OnboardingGate.reset(defaults)
    XCTAssertTrue(OnboardingGate.shouldShow(defaults), "reset re-enables onboarding")
  }
}
