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
