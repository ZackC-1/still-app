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

  /// The fixed DOM event native dispatches on the page once the sheet is gone, so the settings
  /// screen re-reads the extension state (a sheet never hides the page, so no visibility change
  /// tells it). Mirrors `SAFARI_SETUP_CLOSED_EVENT` in packages/core; a core test pins the two.
  public static let closedEvent = "still:safari-setup-closed"
}

/// One Safari setup sheet, from shown to gone (ISS-0075). Apple's rating sheet is held (`.setup`)
/// for as long as it is up, whichever way it goes: Close, Escape, "I've turned it on", a
/// "Check again" that confirms Still is on, or a swipe down on the iPhone. Closing runs once: a
/// second tap, or a tap after the sheet already went, dismisses nothing and tells the page nothing.
@MainActor public final class SafariSetupSheetLifecycle {
  private var hold: RatingHold.Token?
  private let finished: () -> Void
  public private(set) var isClosed = false

  /// Starts holding the rating sheet. `finished` runs once, when the sheet is gone.
  public init(ratingHold: RatingHold = .app, finished: @escaping () -> Void) {
    hold = ratingHold.hold(.setup)
    self.finished = finished
  }

  /// The sheet asked to close: `dismiss` runs once, then the sheet is finished.
  public func close(dismiss: () -> Void) {
    guard !isClosed else { return }
    dismiss()
    finish()
  }

  /// The sheet is gone (closed here, or dismissed by the system): ends the hold, tells the page.
  public func finish() {
    guard !isClosed else { return }
    isClosed = true
    hold?.end()
    hold = nil
    finished()
  }
}
