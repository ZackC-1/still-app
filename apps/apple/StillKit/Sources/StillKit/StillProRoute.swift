import Foundation

/// One fixed, navigation-only app destination. URLs never carry account, price or purchase input.
public enum StillProRoute {
  public static let url = "still://pro"
  public static let changed = Notification.Name("StillProRouteChanged")
  @MainActor private static var revision = 0
  @MainActor private static var pendingRevision: Int?

  public static func accepts(_ url: URL) -> Bool {
    guard let value = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
    return value.scheme == "still" && value.host == "pro" &&
      (value.path.isEmpty || value.path == "/") && value.user == nil && value.password == nil &&
      value.port == nil && value.query == nil && value.fragment == nil
  }

  /// Works before the web view exists (cold launch) and notifies an already mounted host (warm).
  @MainActor @discardableResult public static func receive(_ url: URL) -> Bool {
    guard accepts(url), revision < 9_007_199_254_740_991 else { return false }
    revision += 1
    pendingRevision = revision
    NotificationCenter.default.post(name: changed, object: nil)
    return true
  }

  @MainActor public static func pending() -> [String: Any]? {
    pendingRevision.map { ["route": "pro", "revision": $0] }
  }

  /// A late acknowledgment cannot clear a newer navigation request.
  @MainActor public static func acknowledge(_ expectedRevision: Int) -> Bool {
    guard pendingRevision == expectedRevision else { return false }
    pendingRevision = nil
    return true
  }
}
