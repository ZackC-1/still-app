import XCTest
@testable import StillKit

/// The testable core of onboarding (U18): the screen-3 status copy and the first-launch gate. The
/// SwiftUI screens and the SFSafariExtensionManager probe are validated on-device (human checkpoint);
/// the pure logic the UI depends on is proven here.
final class OnboardingTests: XCTestCase {
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

  func testEnableStepListsAlwaysHaveFourSteps() {
    XCTAssertEqual(OnboardingCopy.enableSteps(iOS18OrLater: true).count, 4)
    XCTAssertEqual(OnboardingCopy.enableSteps(iOS18OrLater: false).count, 4)
    XCTAssertEqual(OnboardingCopy.macOSEnableSteps.count, 4)
  }

  func testIOSVariantsShareEverythingButTheSettingsPath() {
    let ios18 = OnboardingCopy.enableSteps(iOS18OrLater: true)
    let earlier = OnboardingCopy.enableSteps(iOS18OrLater: false)
    XCTAssertEqual(ios18[0], earlier[0], "step 1 is shared verbatim")
    XCTAssertEqual(ios18[2], earlier[2], "step 3 is shared verbatim")
    XCTAssertEqual(ios18[3], earlier[3], "step 4 is shared verbatim")
    XCTAssertNotEqual(ios18[1], earlier[1], "only the Settings path differs")
  }

  func testIOSSettingsPathMatchesEachOSGeneration() {
    XCTAssertEqual(
      OnboardingCopy.enableSteps(iOS18OrLater: true)[1],
      "Go to Apps → Safari → Extensions → Still",
      "iOS 18 moved Safari's settings under Apps"
    )
    XCTAssertEqual(
      OnboardingCopy.enableSteps(iOS18OrLater: false)[1],
      "Go to Safari → Extensions → Still"
    )
  }

  func testStepOneNamesTheButtonUnderIt() {
    // The first thing onboarding asks a person to do is tap the button on the same screen, so the
    // step has to call it what the button calls itself. These two drifted apart once already, when
    // the button was renamed to one cross-platform phrase and the steps kept the old iOS and macOS
    // names, leaving first-launch users and App Review told to tap a control that was not there.
    for steps in [
      OnboardingCopy.enableSteps(iOS18OrLater: true),
      OnboardingCopy.enableSteps(iOS18OrLater: false),
      OnboardingCopy.macOSEnableSteps,
    ] {
      XCTAssertTrue(
        steps[0].contains(OnboardingCopy.openButtonTitle),
        "step 1 must name the button as it reads: \(steps[0])"
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
