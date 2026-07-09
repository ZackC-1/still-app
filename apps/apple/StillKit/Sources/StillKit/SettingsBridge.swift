import Foundation

// The web ↔ native settings bridge (KTD4). The one shared Svelte UI persists through an injected
// StorageAdapter; on Apple that adapter (WKWebViewStorageAdapter, packages/core) posts JSON-string
// messages that BOTH native hosts decode with this one type:
//
//   • the app's WKWebView host (WKScriptMessageHandlerWithReply), and
//   • the Safari extension's SafariWebExtensionHandler (App-Group reconcile).
//
// Keeping the protocol here makes the conflict logic (last-write-wins, stale acknowledgments)
// unit-testable from the terminal with `swift test`, with no WebKit, signing, or device.
//
// Wire shape (must match WKWebViewStorageAdapter exactly):
//   web → native:  { "kind": "get" }  |  { "kind": "set", "settings": "<StillSettings JSON>" }
//   native → web:  a StillSettings JSON string, or "" when `get` finds nothing stored.

/// A decoded bridge request. Settings travel as JSON strings, decoded into the shared Codable model.
public enum BridgeRequest: Equatable, Sendable {
  case get
  case set(StoredSettingsRecord)

  /// Parse a raw message body (WKScriptMessage.body or SFExtensionMessageKey userInfo) into a
  /// request. Returns nil for an unknown shape, a missing `settings` string, or undecodable JSON —
  /// callers treat nil as "ignore", never as a silent default.
  public static func parse(_ body: Any) -> BridgeRequest? {
    guard let dict = body as? [String: Any], let kind = dict["kind"] as? String else { return nil }
    switch kind {
    case "get":
      return .get
    case "set":
      guard let json = dict["settings"] as? String,
            let record = try? JSONDecoder().decode(StoredSettingsRecord.self, from: Data(json.utf8))
      else { return nil }
      return .set(record)
    default:
      return nil
    }
  }
}

/// Processes bridge requests against a SharedSettingsStore (the App-Group container in production).
public struct SettingsBridge {
  private let store: SharedSettingsStore
  private let notifyChanged: () -> Void

  /// `notifyChanged` fires after a `set` that actually changed the store — the Darwin broadcast in
  /// production. Injectable so tests can assert the applied-only gating without posting real
  /// system-wide notifications (which would reach any concurrently running app/Simulator).
  public init(store: SharedSettingsStore, notifyChanged: @escaping () -> Void = SettingsBridge.postSettingsChanged) {
    self.store = store
    self.notifyChanged = notifyChanged
  }

  /// Handle a request, mutating the store on `set` by last-write-wins, and return the JSON string the
  /// web side receives: the resolved current settings, or "" for `get` against an empty store. On
  /// `set`, the reply is always the *resolved* value — so a stale incoming write (a lower `updatedAt`)
  /// is ignored and the web cache learns the newer value the App Group already held (KTD4).
  public func handle(_ request: BridgeRequest) -> String {
    switch request {
    case .get:
      guard let stored = store.peekRecord() else { return "" }
      return Self.encodeRecord(stored)
    case .set(let incoming):
      // Broadcast the change (Darwin — see StillSettingsChangedNotification) only when the write
      // actually changed the store: both native hosts route their settings writes through this one
      // `set`, and gating on the applied result means a stale/echoed write can't ping-pong
      // notifications between the app and the extension.
      if store.applyRecord(incoming) {
        notifyChanged()
      }
      return Self.encodeRecord(store.currentRecord())
    }
  }

  /// Convenience for hosts that receive a raw message body: parse + handle in one call. Returns nil
  /// when the body isn't a valid request (the host should then not reply / reply empty).
  public func handle(rawBody body: Any) -> String? {
    guard let request = BridgeRequest.parse(body) else { return nil }
    return handle(request)
  }

  /// Post the cross-process change signal on the Darwin notify center — the shared write path for
  /// both hosts, so the app's WKWebView learns about extension writes (and vice versa) immediately.
  /// Public only as the injectable default for `init(store:notifyChanged:)`.
  public static func postSettingsChanged() {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(StillSettingsChangedNotification.name as CFString),
      nil, nil, true)
  }

  static func encode(_ settings: StillSettings) -> String {
    guard let data = try? JSONEncoder().encode(settings),
          let string = String(data: data, encoding: .utf8)
    else { return "" }
    return string
  }

  static func encodeRecord(_ record: StoredSettingsRecord) -> String {
    guard let data = try? JSONEncoder().encode(record),
          let string = String(data: data, encoding: .utf8)
    else { return "" }
    return string
  }
}
