import XCTest
@testable import StillKit

/// One gate, one presenter: the App Group "completed" flag is read by exactly one of the SwiftUI
/// flow or the web D12 flow, chosen once per launch from the app's Info.plist.
final class OnboardingGatePresenterTests: XCTestCase {
  private var defaults: UserDefaults!

  override func setUp() {
    super.setUp()
    defaults = UserDefaults(suiteName: "still.onboarding.presenter.tests")!
    OnboardingGate.reset(defaults)
  }

  override func tearDown() {
    OnboardingGate.reset(defaults)
    super.tearDown()
  }

  private var appleRoot: URL {
    // …/apps/apple/StillKit/Tests/StillKitTests/<this file> → …/apps/apple
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }

  /// A deliberate tripwire. Nothing presents onboarding in the web view until the web app wires the
  /// D12 host, so the web presenter must not be selectable from any shipped Info.plist or build
  /// setting. Update this expectation in the same change that wires the web onboarding.
  func testShippedBuildsDoNotSelectTheWebPresenter() throws {
    let files = [
      "Still/iOS (App)/Info.plist",
      "Still/macOS (App)/Info.plist",
      "Still/iOS (Extension)/Info.plist",
      "Still/macOS (Extension)/Info.plist",
      "Still/Still.xcodeproj/project.pbxproj",
    ]
    for path in files {
      let url = appleRoot.appendingPathComponent(path)
      let text = try String(contentsOf: url, encoding: .utf8)
      XCTAssertFalse(
        text.contains(OnboardingGate.presenterInfoKey),
        "\(path) selects an onboarding presenter before the web onboarding is wired")
    }
    // The key read by the app must be the one this tripwire searches for.
    XCTAssertEqual(OnboardingGate.presenterInfoKey, "StillOnboardingPresenter")
  }

  func testShippedConfigurationKeepsSwiftUI() {
    // No key is what every shipped Info.plist has today.
    XCTAssertEqual(OnboardingGate.presenter(fromInfoValue: nil), .swiftUI)
  }

  func testOnlyTheExactWebStringSelectsTheWebFlow() {
    XCTAssertEqual(OnboardingGate.presenter(fromInfoValue: "web"), .web)
    for value: Any in ["", "Web", "WEB", " web", "web ", "swiftui", "native", true, 1, ["web"]] {
      XCTAssertEqual(
        OnboardingGate.presenter(fromInfoValue: value), .swiftUI,
        "\(value) must fall back to the shipped SwiftUI presenter")
    }
  }

  func testTheTwoPresentersNeverBothShow() {
    for presenter in OnboardingPresenterChoice.allCases {
      for completed in [false, true] {
        for debugStep in [nil, 0, 2] as [Int?] {
          OnboardingGate.reset(defaults)
          if completed { OnboardingGate.markComplete(defaults) }
          let native = OnboardingGate.nativeInitialStep(
            presenter: presenter, defaults: defaults, debugForcedStep: debugStep) != nil
          let web = OnboardingGate.webShouldShow(presenter: presenter, defaults: defaults)
          XCTAssertFalse(
            native && web,
            "both presenters showed: presenter=\(presenter) completed=\(completed) debug=\(String(describing: debugStep))")
        }
      }
    }
  }

  func testSwiftUIPresenterBehavesExactlyAsBefore() {
    XCTAssertEqual(OnboardingGate.nativeInitialStep(presenter: .swiftUI, defaults: defaults), 0)
    XCTAssertFalse(OnboardingGate.webShouldShow(presenter: .swiftUI, defaults: defaults))
    OnboardingGate.markComplete(defaults)
    XCTAssertNil(OnboardingGate.nativeInitialStep(presenter: .swiftUI, defaults: defaults))
    // The DEBUG screenshot hook still bypasses the gate for the SwiftUI flow, as it did before.
    XCTAssertEqual(
      OnboardingGate.nativeInitialStep(presenter: .swiftUI, defaults: defaults, debugForcedStep: 2), 2)
  }

  func testWebPresenterOwnsTheGateAndTheNativeFlowStaysDown() {
    XCTAssertTrue(OnboardingGate.webShouldShow(presenter: .web, defaults: defaults))
    XCTAssertNil(OnboardingGate.nativeInitialStep(presenter: .web, defaults: defaults))
    XCTAssertNil(
      OnboardingGate.nativeInitialStep(presenter: .web, defaults: defaults, debugForcedStep: 1),
      "the DEBUG hook must not stack the native sheet over the web onboarding")

    XCTAssertTrue(OnboardingGate.completeFromWeb(presenter: .web, defaults: defaults))
    XCTAssertFalse(OnboardingGate.shouldShow(defaults), "web completion writes the one shared gate")
    XCTAssertFalse(OnboardingGate.webShouldShow(presenter: .web, defaults: defaults))
    XCTAssertTrue(OnboardingGate.completeFromWeb(presenter: .web, defaults: defaults), "idempotent")
  }

  func testWebCannotCompleteTheSwiftUIFlowsGate() {
    XCTAssertFalse(OnboardingGate.completeFromWeb(presenter: .swiftUI, defaults: defaults))
    XCTAssertTrue(OnboardingGate.shouldShow(defaults), "a refused completion writes nothing")
  }

  func testStateReplyCarriesTheGateAndHostFacts() {
    let reply = OnboardingGate.webStateReply(
      presenter: .web, defaults: defaults, platform: .ios, osMajorVersion: 17)
    XCTAssertEqual(reply["ok"] as? Bool, true)
    XCTAssertEqual(reply["shouldShow"] as? Bool, true)
    XCTAssertEqual(reply["platform"] as? String, "ios")
    XCTAssertEqual(reply["osMajorVersion"] as? Int, 17)
    XCTAssertEqual(reply.count, 4)

    let native = OnboardingGate.webStateReply(
      presenter: .swiftUI, defaults: defaults, platform: .macos, osMajorVersion: 15)
    XCTAssertEqual(native["shouldShow"] as? Bool, false, "the web never shows while SwiftUI presents")
    XCTAssertEqual(native["platform"] as? String, "macos")
  }
}
