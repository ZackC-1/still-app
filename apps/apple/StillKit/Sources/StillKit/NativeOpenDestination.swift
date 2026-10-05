import Foundation

/// The only places the Apple app's web view may ask native to open (`openDestination` bridge
/// message, WebBridgeRouter). Each is a fixed system location chosen here; the page names one of
/// these values and nothing else, so no URL, path, bundle id or query ever comes from the page.
///
///   • `safariExtensionSettings`: Safari's Extensions settings with Still selected (macOS).
///   • `settingsAppStillPage`: Still's own page in the Settings app (iOS), the closest entry a
///     containing app can open on the iPhone versions this build supports.
///   • `safari`: the Safari app itself (macOS). iOS has no public way to open Safari specifically
///     (an `https` link opens whichever browser the person chose as default), so it is not
///     offered there and the D12 "Open Safari" button stays disabled on iOS.
///
/// The raw values match `EnableLocation` in the `safariSetupState` reply, so the web view opens
/// exactly the location that read described.
public enum NativeOpenDestination: String, CaseIterable, Equatable, Sendable {
  case safariExtensionSettings
  case settingsAppStillPage
  case safari

  /// Safari's bundle identifier, the one application `safari` may launch on macOS.
  public static let safariBundleIdentifier = "com.apple.Safari"

  /// What this platform can actually open. Anything else is refused before native acts.
  public static func supported(on platform: SafariSetupObservation.Platform) -> Set<NativeOpenDestination> {
    switch platform {
    case .macos: return [.safariExtensionSettings, .safari]
    case .ios: return [.settingsAppStillPage]
    }
  }
}

/// The script-message frame facts `ViewController` reads off a `WKScriptMessage`, passed through so
/// the open decision re-checks the trust boundary itself instead of relying only on the outer guard.
public struct BridgeFrame: Equatable, Sendable {
  public let isMainFrame: Bool
  public let url: URL?
  public let bundledURL: URL

  public init(isMainFrame: Bool, url: URL?, bundledURL: URL) {
    self.isMainFrame = isMainFrame
    self.url = url
    self.bundledURL = bundledURL
  }

  /// `BridgeTrust.isTrusted` for this frame: the bundled main frame only.
  public var isTrusted: Bool {
    BridgeTrust.isTrusted(isMainFrame: isMainFrame, url: url, bundledURL: bundledURL)
  }
}

/// Validation for `{ kind: "openDestination", destination }`. Pure, so every refusal is testable
/// with `swift test`.
public enum NativeOpenRequest {
  public static let messageKind = "openDestination"

  public enum Refusal: String, Error, Equatable, Sendable {
    /// Not exactly `{ kind: "openDestination", destination: <one fixed value> }`.
    case malformed
    /// Not the bundled main frame.
    case untrustedFrame
    /// A fixed destination this platform cannot open.
    case unsupported
    /// The app is not frontmost, so no tap in it can be the cause.
    case inactive
  }

  /// Decide whether to open, and where. Refused unless the message came from the bundled main
  /// frame, is exactly the two expected keys (an extra `url` or anything else is refused, never
  /// ignored), names one fixed destination this platform supports, and arrives while the app is
  /// the active app.
  ///
  /// A script message carries no user-gesture flag in WebKit, so native cannot prove a tap. The
  /// web side posts only from a tap and checks the page's user activation where WebKit exposes it;
  /// native adds the strongest signal it has, that the app is frontmost. Opening any destination
  /// moves the person out of the app, so a page that keeps posting cannot open twice without the
  /// person coming back first.
  public static func authorize(
    body: Any,
    frame: BridgeFrame,
    platform: SafariSetupObservation.Platform,
    appIsActive: Bool
  ) -> Result<NativeOpenDestination, Refusal> {
    guard frame.isTrusted else { return .failure(.untrustedFrame) }
    guard let dict = body as? [String: Any],
          Set(dict.keys) == ["kind", "destination"],
          dict["kind"] as? String == messageKind,
          let raw = dict["destination"] as? String,
          let destination = NativeOpenDestination(rawValue: raw)
    else { return .failure(.malformed) }
    guard NativeOpenDestination.supported(on: platform).contains(destination) else {
      return .failure(.unsupported)
    }
    guard appIsActive else { return .failure(.inactive) }
    return .success(destination)
  }

  /// The reply after native opened `destination`.
  public static func reply(_ destination: NativeOpenDestination) -> [String: Any] {
    ["ok": true, "destination": destination.rawValue]
  }
}
