import Foundation

/// The trust boundary for the WKWebView native bridge (P0 hardening). The app only ever loads the
/// bundled web build from a `file://` URL, so any navigation away from it — and any script message
/// from a non-main-frame or non-bundled origin — must be refused before it can drive privileged
/// native actions (Sign in with Apple, configure/purchase/restore RevenueCat).
///
/// Pure Foundation (URL only) so every decision is unit-testable from the terminal (`swift test`)
/// without WebKit, a device, or an Xcode target. `ViewController` pulls the inputs off the live
/// `WKScriptMessage` / `WKNavigationAction` and delegates the decision here.
public enum BridgeTrust {
  /// Whether a script message in a frame described by `isMainFrame`, whose request URL is `url`,
  /// should be trusted to drive privileged native actions, given the bundled index `bundledURL`.
  /// Trust requires the main frame AND a same-origin (bundled-directory) `file://` URL.
  public static func isTrusted(isMainFrame: Bool, url: URL?, bundledURL: URL) -> Bool {
    guard isMainFrame, let url else { return false }
    return isBundledOrigin(url, bundledURL: bundledURL)
  }

  /// Whether a top-level navigation to `url` may load in the web view. Only the bundled content (the
  /// index file or any resource under its directory) and `about:blank` may load; everything else —
  /// remote `http(s)`, other schemes — is cancelled by the caller.
  public static func allowsNavigation(to url: URL?, bundledURL: URL) -> Bool {
    guard let url else { return false }
    if url.scheme?.lowercased() == "about" { return true } // about:blank / same-document
    return isBundledOrigin(url, bundledURL: bundledURL)
  }

  /// The shipped support address. Mirrors `SUPPORT_EMAIL` in packages/core/src/ui/config.ts; a
  /// StillKit test reads that source so the two cannot drift apart.
  public static let supportEmailAddress = "support@stillapp.fit"

  /// Whether a cancelled navigation should instead be handed to the system — a user-initiated
  /// `http(s)` link (e.g. the in-app privacy-policy link) opens in the browser, and a `mailto:` link
  /// opens in the mail app only when it is exactly `mailto:<supportEmailAddress>` (no other
  /// recipient, no query, no fragment, no encoded variant). Every other scheme stays cancelled. The
  /// caller cancels the in-web-view navigation and hands the allowed ones to the OS.
  public static func opensExternally(_ url: URL?) -> Bool {
    guard let url, let scheme = url.scheme?.lowercased() else { return false }
    switch scheme {
    case "http", "https":
      return true
    case "mailto":
      return isSupportMailto(url)
    default:
      return false
    }
  }

  /// Exact match on everything after `mailto:`, so `?subject=`/`?cc=`/`?body=`, extra recipients,
  /// fragments, authority forms (`mailto://`) and percent-encoded spellings are all refused.
  private static func isSupportMailto(_ url: URL) -> Bool {
    let raw = url.absoluteString
    guard let colon = raw.firstIndex(of: ":") else { return false }
    return raw[raw.index(after: colon)...] == supportEmailAddress
  }

  /// A URL is the bundled origin when it is a `file://` URL at, or under, the bundle index's
  /// directory (the `allowingReadAccessTo` root). Paths are standardized so `..` traversal can't
  /// escape the root.
  private static func isBundledOrigin(_ url: URL, bundledURL: URL) -> Bool {
    guard url.isFileURL, bundledURL.isFileURL else { return false }
    let rawRoot = bundledURL.deletingLastPathComponent().standardizedFileURL.path
    let root = rawRoot.hasSuffix("/") ? String(rawRoot.dropLast()) : rawRoot
    let target = url.standardizedFileURL.path
    return target == root || target.hasPrefix(root + "/")
  }
}
