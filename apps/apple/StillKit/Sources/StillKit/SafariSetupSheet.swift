import Foundation

/// Validation for `{ kind: "presentSafariSetup" }`, the settings Help card's "Safari setup" link
/// (ISS-0075). The web view asks native to show onboarding screen 3 ("Turn on Still in Safari")
/// again, as a sheet the person can close. Pure, so every refusal is testable with `swift test`.
///
/// The message names nothing: no screen, URL or destination comes from the page. Native shows its
/// one fixed sheet, whose "Open Settings" button opens the same enable location as onboarding and
/// the setup card. Showing it never reads, completes or resets `OnboardingGate`, so first-run
/// onboarding is unchanged.
public enum SafariSetupSheetRequest {
  public static let messageKind = "presentSafariSetup"

  public enum Refusal: String, Error, Equatable, Sendable {
    /// Not exactly `{ kind: "presentSafariSetup" }`.
    case malformed
    /// Not the bundled main frame.
    case untrustedFrame
    /// The app is not frontmost, so no tap in it can be the cause.
    case inactive
  }

  /// Why the sheet must not be shown, or nil to show it. Refused unless the message came from the
  /// bundled main frame, is exactly the one expected key (anything extra is refused, never
  /// ignored), and arrives while the app is the active app. As with `openDestination`, WebKit gives
  /// native no gesture flag; the web side posts only from a tap and checks the page's activation.
  public static func refusal(body: Any, frame: BridgeFrame, appIsActive: Bool) -> Refusal? {
    guard frame.isTrusted else { return .untrustedFrame }
    guard let dict = body as? [String: Any],
          Set(dict.keys) == ["kind"],
          dict["kind"] as? String == messageKind
    else { return .malformed }
    guard appIsActive else { return .inactive }
    return nil
  }

  /// The reply after native presented the sheet.
  public static func reply() -> [String: Any] { ["ok": true] }
}
