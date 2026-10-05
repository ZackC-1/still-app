import Foundation

/// Read-only native extension state. Enabled is not a site-permission or completion receipt.
public struct SafariSetupObservation: Equatable, Sendable {
  public enum Platform: String, Sendable { case ios, macos }

  public let platform: Platform
  public let extensionStatus: SafariExtensionStatus
  public let enableLocation: EnableLocation

  public init(
    platform: Platform, extensionStatus: SafariExtensionStatus, enableLocation: EnableLocation
  ) {
    self.platform = platform
    self.extensionStatus = platform == .ios ? .unknown : extensionStatus
    let expected: EnableLocation =
      platform == .ios ? .settingsAppStillPage : .safariExtensionSettings
    self.enableLocation = enableLocation == expected ? enableLocation : expected
  }

  public var bridgeReply: [String: Any] {
    let status: String
    switch extensionStatus {
    case .enabled: status = "enabled"
    case .disabled: status = "disabled"
    case .unknown: status = "unknown"
    }
    let destination: String
    switch enableLocation {
    case .safariExtensionSettings: destination = "safariExtensionSettings"
    case .settingsAppStillPage: destination = "settingsAppStillPage"
    }
    return [
      "ok": true, "platform": platform.rawValue, "extensionStatus": status,
      "enableLocation": destination,
    ]
  }
}
