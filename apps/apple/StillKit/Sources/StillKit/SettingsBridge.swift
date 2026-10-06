import Foundation

// The web ↔ native settings bridge (KTD4). The one shared Svelte UI persists through an injected
// StorageAdapter; on Apple that adapter (WKWebViewStorageAdapter, packages/core) posts JSON-string
// messages that BOTH native hosts decode with this one type:
//
//   • the app's WKWebView host (WKScriptMessageHandlerWithReply), and
//   • the Safari extension's SafariWebExtensionHandler (App-Group reconcile).
//
// Keeping the protocol here makes legacy arbitration and modern committed-action handling
// unit-testable from the terminal with `swift test`, with no WebKit, signing, or device.
//
// Wire shape (must match WKWebViewStorageAdapter exactly):
// Legacy get/set return the complete preserved record. settingsIntent returns that committed
// record plus changed/status; settingsAtomic is the explicit internal modern rollout adapter.

/// A decoded bridge request. Settings travel as JSON strings, decoded into the shared Codable model.
public enum BridgeRequest: Equatable, Sendable {
  case get
  case set(StoredSettingsRecord)
  case setPreserved(Data)
  case atomic(Data)
  case intent(path: String, value: Bool, updatedAt: Int)
  /// Safari's retained settings copy, offered after a reinstall (owner decision 30).
  case adopt(Data)

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
      _ = record
      return .setPreserved(Data(json.utf8))
    case "settingsAtomic":
      guard Set(dict.keys) == Set(["kind", "command"]), let json = dict["command"] as? String,
        json.utf8.count <= 131_072 else { return nil }
      return .atomic(Data(json.utf8))
    case "settingsAdopt":
      guard Set(dict.keys) == Set(["kind", "settings"]), let json = dict["settings"] as? String,
        json.utf8.count <= 131_072 else { return nil }
      return .adopt(Data(json.utf8))
    case "settingsIntent":
      guard Set(dict.keys) == Set(["kind", "path", "value", "updatedAt"]),
        let path = dict["path"] as? String,
        let number = dict["value"] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID(),
        let time = dict["updatedAt"] as? NSNumber, CFGetTypeID(time) != CFBooleanGetTypeID(),
        time.doubleValue.isFinite, time.doubleValue > 0, time.doubleValue <= SettingsV2Migration.maxRevision,
        time.doubleValue.rounded(.towardZero) == time.doubleValue,
        PackagedFeatureRegistry.settingsFields.contains(path) else { return nil }
      return .intent(path: path, value: number.boolValue, updatedAt: time.intValue)
    default:
      return nil
    }
  }
}

/// Processes bridge requests against a SharedSettingsStore (the App-Group container in production).
public struct SettingsBridge {
  private let store: SharedSettingsStore
  private let notifyChanged: () -> Void
  /// The app host's launch fact for its first saved record (owner decision 28). Nil in the Safari
  /// extension, which never saves a first record.
  public var firstRecord: AtomicSettingsRecord.FirstRecord?

  /// `notifyChanged` fires after a `set` that actually changed the store — the Darwin broadcast in
  /// production. Injectable so tests can assert the applied-only gating without posting real
  /// system-wide notifications (which would reach any concurrently running app/Simulator).
  public init(store: SharedSettingsStore, notifyChanged: @escaping () -> Void = SettingsBridge.postSettingsChanged,
              firstRecord: AtomicSettingsRecord.FirstRecord? = nil) {
    self.store = store
    self.notifyChanged = notifyChanged
    self.firstRecord = firstRecord
  }

  /// Return bytes captured in the same transaction as the mutation, before notifying peers.
  /// Coarse legacy sets cannot replace modern authority. A genuine empty read is distinct from
  /// unavailable coordination; modern actions allocate only through the shared store's lock.
  public func handle(_ request: BridgeRequest) -> String {
    switch request {
    case .get:
      do {
        guard let stored = try store.readCommittedRecord() else { return "" }
        return String(data: stored, encoding: .utf8) ?? "{\"status\":\"unavailable\"}"
      } catch { return "{\"status\":\"unavailable\"}" }
    case .set(let incoming):
      guard let data = try? JSONEncoder().encode(incoming) else { return "" }
      return apply(data)
    case .setPreserved(let incoming):
      return apply(incoming)
    case .atomic(let command):
      guard let committed = try? store.atomicCommand(command, firstRecord: firstRecord) else { return "{\"status\":\"unavailable\"}" }
      if committed.changed { notifyChanged() }
      return String(data: committed.data, encoding: .utf8) ?? ""
    case .adopt(let incoming):
      guard let result = try? store.adoptLeftoverCopy(incoming) else { return "{\"status\":\"unavailable\"}" }
      let status: String
      switch result.adoption {
      case .adopted: status = "adopted"
      case .kept: status = "kept"
      case .refused: status = "refused"
      }
      if status == "adopted" { notifyChanged() }
      let record: Any = result.data.flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? NSNull()
      guard let reply = try? JSONSerialization.data(withJSONObject: ["status": status, "record": record]) else { return "{\"status\":\"unavailable\"}" }
      return String(data: reply, encoding: .utf8) ?? "{\"status\":\"unavailable\"}"
    case .intent(let path, let value, let updatedAt):
      guard let committed = try? store.commitIntent(path: path, value: value, updatedAt: updatedAt) else { return "" }
      if committed.changed && store.coordinationAvailable { notifyChanged() }
      guard let object = try? JSONSerialization.jsonObject(with: committed.data),
        let reply = try? JSONSerialization.data(withJSONObject: ["record": object, "changed": committed.changed, "status": store.coordinationAvailable ? "committed" : "paused"]) else { return "" }
      return String(data: reply, encoding: .utf8) ?? ""

    }
  }

  private func apply(_ data: Data) -> String {
    guard let committed = try? store.applyEncodedRecord(data) else { return "" }
    if committed.changed { notifyChanged() }
    return committed.data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
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
