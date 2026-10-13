import Foundation

/// Fixed, navigation-only app destinations. URLs never carry account, price or purchase input.
///
///   still://pro   the Still Pro offer (the same screen the Settings card's Get Still Pro opens)
///   still://sync  the Settings sync card; signed out, the sign-in sheet opens over it
///
/// Every other `still:` URL, and any of these two with a path, query, fragment, user or port, is
/// refused. The Safari extension asks for one by name only (`extensionOpenRequest`), never with a
/// URL, so it cannot make the app open anything else.
public enum StillAppRoute {
  public enum Destination: String, CaseIterable, Sendable {
    case pro
    case sync

    /// The one URL for this destination, spelled the same as `STILL_*_APP_URL` in
    /// packages/core/src/native/bridge.ts.
    public var url: URL { URL(string: "still://\(rawValue)")! }
  }

  public static let changed = Notification.Name("StillAppRouteChanged")
  @MainActor private static var revision = 0
  @MainActor private static var pendingRequest: (destination: Destination, revision: Int)?

  /// The destination a URL names, or nil when it is not exactly one of the fixed routes.
  public static func destination(for url: URL) -> Destination? {
    guard let value = URLComponents(url: url, resolvingAgainstBaseURL: false),
          value.scheme == "still", let host = value.host, let destination = Destination(rawValue: host),
          value.path.isEmpty || value.path == "/", value.user == nil, value.password == nil,
          value.port == nil, value.query == nil, value.fragment == nil
    else { return nil }
    return destination
  }

  public static func accepts(_ url: URL) -> Bool { destination(for: url) != nil }

  /// Works before the web view exists (cold launch) and notifies an already mounted host (warm).
  /// The latest request wins: a newer destination replaces one the page has not taken yet.
  @MainActor @discardableResult public static func receive(_ url: URL) -> Bool {
    guard let destination = destination(for: url), revision < 9_007_199_254_740_991 else { return false }
    revision += 1
    pendingRequest = (destination, revision)
    NotificationCenter.default.post(name: changed, object: nil)
    return true
  }

  @MainActor public static func pending() -> [String: Any]? {
    pendingRequest.map { ["route": $0.destination.rawValue, "revision": $0.revision] }
  }

  /// A late acknowledgment cannot clear a newer navigation request.
  @MainActor public static func acknowledge(_ expectedRevision: Int) -> Bool {
    guard pendingRequest?.revision == expectedRevision else { return false }
    pendingRequest = nil
    return true
  }

  /// The Safari extension's request to open the app at a fixed destination:
  /// exactly `{ kind: "openAppRoute", route: "pro" | "sync" }`. Anything else, including a URL,
  /// extra keys or another route name, is nil. Returns nil for every other message kind, so the
  /// native handler can fall through to its other lanes.
  public static func extensionOpenRequest(rawBody: Any) -> ExtensionOpenRequest? {
    guard let body = rawBody as? [String: Any], body["kind"] as? String == openAppRouteKind else { return nil }
    guard Set(body.keys) == ["kind", "route"], let name = body["route"] as? String,
          let destination = Destination(rawValue: name)
    else { return .refused }
    return .open(destination)
  }

  public static let openAppRouteKind = "openAppRoute"

  public enum ExtensionOpenRequest: Equatable, Sendable {
    case open(Destination)
    case refused

    /// The reply the extension receives: `{ openAppRoute: { ok, route|null } }`.
    public func reply(opened: Bool) -> [String: Any] {
      switch self {
      case .open(let destination):
        return [StillAppRoute.openAppRouteKind: ["ok": opened, "route": destination.rawValue]]
      case .refused:
        return [StillAppRoute.openAppRouteKind: ["ok": false, "route": NSNull()]]
      }
    }
  }
}
