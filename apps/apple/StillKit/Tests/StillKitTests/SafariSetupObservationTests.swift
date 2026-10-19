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

  func testIOSBeforeTheDirectPageIsAlwaysUnknownEvenIfSuppliedEnabledOrDisabled() throws {
    // Before iOS 26.2 a containing app cannot read the extension's state; the app declares the app
    // page there, and the reply never claims a status it could not read.
    for status in [SafariExtensionStatus.enabled, .disabled, .unknown] {
      let observation = SafariSetupObservation(
        platform: .ios, extensionStatus: status, enableLocation: .settingsAppStillPage)
      XCTAssertEqual(observation.extensionStatus, .unknown)
      XCTAssertFalse(observation.extensionStatus.isConfirmedEnabled)
      try assertReply(
        observation, platform: "ios", status: "unknown", location: "settingsAppStillPage")
    }
  }

  func testIOSWithTheDirectExtensionPageCarriesTheRealStatus() throws {
    // ISS-0082: on iOS 26.2+ the app reads the real state and opens Still's Safari extension page
    // directly (ISS-0074), so the web view gets both and can show the setup card when it is off.
    for (status, name) in [
      (SafariExtensionStatus.enabled, "enabled"), (.disabled, "disabled"), (.unknown, "unknown"),
    ] {
      let observation = SafariSetupObservation(
        platform: .ios, extensionStatus: status, enableLocation: .settingsAppSafariExtensionPage)
      XCTAssertEqual(observation.extensionStatus, status)
      XCTAssertEqual(observation.enableLocation, .settingsAppSafariExtensionPage)
      try assertReply(
        observation, platform: "ios", status: name, location: "settingsAppSafariExtensionPage")
    }
    let mac = SafariSetupObservation(
      platform: .macos, extensionStatus: .enabled, enableLocation: .settingsAppSafariExtensionPage)
    XCTAssertEqual(mac.enableLocation, .safariExtensionSettings)
    try assertReply(mac, platform: "macos", status: "enabled", location: "safariExtensionSettings")
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
