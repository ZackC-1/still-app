import Foundation

/// Read-only native extension state. Enabled is not a site-permission or completion receipt.
public struct SafariSetupObservation: Equatable, Sendable {
  public enum Platform: String, Sendable { case ios, macos }

  public let platform: Platform
  public let extensionStatus: SafariExtensionStatus
  public let enableLocation: EnableLocation

  /// macOS keeps the status it read and always names Safari's extension settings. On iOS the status
  /// is real only with the direct Safari extension page, which the app declares on iOS 26.2 and
  /// later, the versions where it can also read the extension's state (ISS-0074). Any other iOS
  /// observation is "unknown" on Still's app page, so an earlier iPhone never claims a status.
  public init(
    platform: Platform, extensionStatus: SafariExtensionStatus, enableLocation: EnableLocation
  ) {
    self.platform = platform
    switch platform {
    case .macos:
      self.extensionStatus = extensionStatus
      self.enableLocation = .safariExtensionSettings
    case .ios where enableLocation == .settingsAppSafariExtensionPage:
      self.extensionStatus = extensionStatus
      self.enableLocation = .settingsAppSafariExtensionPage
    case .ios:
      self.extensionStatus = .unknown
      self.enableLocation = .settingsAppStillPage
    }
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
    case .settingsAppSafariExtensionPage: destination = "settingsAppSafariExtensionPage"
    }
    return [
      "ok": true, "platform": platform.rawValue, "extensionStatus": status,
      "enableLocation": destination,
    ]
  }
}
