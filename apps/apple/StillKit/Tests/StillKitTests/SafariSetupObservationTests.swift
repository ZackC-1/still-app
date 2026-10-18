import XCTest

@testable import StillKit

final class SafariSetupObservationTests: XCTestCase {
  func testAllMacStatusesAndExactEnvelope() throws {
    for (status, name) in [
      (SafariExtensionStatus.enabled, "enabled"), (.disabled, "disabled"), (.unknown, "unknown"),
    ] {
      let observation = SafariSetupObservation(
        platform: .macos, extensionStatus: status, enableLocation: .safariExtensionSettings)
      XCTAssertEqual(observation.extensionStatus, status)
      try assertReply(
        observation, platform: "macos", status: name, location: "safariExtensionSettings")
    }
  }

  func testIOSAlwaysUnknownEvenIfSuppliedEnabledOrDisabled() throws {
    for status in [SafariExtensionStatus.enabled, .disabled, .unknown] {
      let observation = SafariSetupObservation(
        platform: .ios, extensionStatus: status, enableLocation: .settingsAppStillPage)
      XCTAssertEqual(observation.extensionStatus, .unknown)
      XCTAssertFalse(observation.extensionStatus.isConfirmedEnabled)
      try assertReply(
        observation, platform: "ios", status: "unknown", location: "settingsAppStillPage")
    }
  }

  func testTheIOSDirectExtensionPageKeepsTheWebViewContractUnchanged() throws {
    // ISS-0074: on iOS 26.2+ the SwiftUI onboarding opens Still's Safari extension page directly,
    // but the web view's setup reply keeps its one iOS shape (unknown, settingsAppStillPage), which
    // is what the bundled web UI parses and what `openDestination` can open there.
    let observation = SafariSetupObservation(
      platform: .ios, extensionStatus: .enabled, enableLocation: .settingsAppSafariExtensionPage)
    XCTAssertEqual(observation.enableLocation, .settingsAppStillPage)
    XCTAssertEqual(observation.extensionStatus, .unknown)
    try assertReply(observation, platform: "ios", status: "unknown", location: "settingsAppStillPage")
    let mac = SafariSetupObservation(
      platform: .macos, extensionStatus: .enabled, enableLocation: .settingsAppSafariExtensionPage)
    XCTAssertEqual(mac.enableLocation, .safariExtensionSettings)
  }

  func testIncompatibleDestinationCannotEscapeItsActualPlatform() throws {
    let ios = SafariSetupObservation(
      platform: .ios, extensionStatus: .enabled, enableLocation: .safariExtensionSettings)
    XCTAssertEqual(ios.enableLocation, .settingsAppStillPage)
    try assertReply(ios, platform: "ios", status: "unknown", location: "settingsAppStillPage")
    let mac = SafariSetupObservation(
      platform: .macos, extensionStatus: .disabled, enableLocation: .settingsAppStillPage)
    XCTAssertEqual(mac.enableLocation, .safariExtensionSettings)
    try assertReply(mac, platform: "macos", status: "disabled", location: "safariExtensionSettings")
  }

  private func assertReply(
    _ observation: SafariSetupObservation, platform: String, status: String, location: String
  ) throws {
    let data = try JSONSerialization.data(withJSONObject: observation.bridgeReply)
    let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    XCTAssertEqual(
      decoded,
      ["ok": true, "platform": platform, "extensionStatus": status, "enableLocation": location]
        as NSDictionary)
  }
}
