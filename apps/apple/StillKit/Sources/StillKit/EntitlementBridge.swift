import Foundation

// The entitlement lane of the App-Group bridge. The paid "Still Pro" surfaces are applied by the
// Safari extension's content scripts, but the entitlement authority lives with the app: the
// WKWebView's SyncService reconciles it against Supabase and mirrors the result here after every
// state change. The Safari extension's background then pulls it ({kind:"getEntitlement"}) into
// browser.storage, where the content scripts' EntitlementCache reads it.
//
// Deliberately a SEPARATE App-Group key from the settings blob: settings sync is last-write-wins
// and client-writable, while the entitlement value is only ever written from the app's
// server-reconciled state (monetization-design §6 — never inside StillSettings). The stored
// `updatedAt` is the last server-confirmed time; the extension keeps it and applies its 30-day TTL
// against it, so a device that never reaches the server again downgrades to free on schedule.
//
// Wire shape:
//   web/app → native:  { "kind": "setEntitlement", "entitled": Bool }
//   extension → native: { "kind": "getEntitlement" }
//   native → caller:   "{\"entitled\":Bool,\"updatedAt\":Int}" or "" when nothing is stored.

public struct EntitlementRecord: Codable, Equatable, Sendable {
  public let entitled: Bool
  /// Milliseconds since epoch of the write (the app writes only after a server reconcile).
  public let updatedAt: Int

  public init(entitled: Bool, updatedAt: Int) {
    self.entitled = entitled
    self.updatedAt = updatedAt
  }
}

/// The App-Group-backed entitlement store, mirroring SharedSettingsStore's backing seam so tests
/// run in-memory with `swift test`.
public final class SharedEntitlementStore {
  private let backing: SettingsBacking
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(backing: SettingsBacking) {
    self.backing = backing
  }

  public func peek() -> EntitlementRecord? {
    guard let data = backing.read(),
          let record = try? decoder.decode(EntitlementRecord.self, from: data)
    else { return nil }
    return record
  }

  public func save(_ record: EntitlementRecord) {
    guard let data = try? encoder.encode(record) else { return }
    backing.write(data)
  }

  /// The production store in the shared App Group container, falling back to in-memory when the
  /// App Group isn't provisioned (same degradation as SharedSettingsStore.appGroup()).
  public static func appGroup(_ identifier: String = StillAppGroup.identifier) -> SharedEntitlementStore {
    SharedEntitlementStore(
      backing: AppGroupBacking(appGroupId: identifier, key: "still:entitlement") ?? InMemoryBacking())
  }
}

/// A decoded entitlement bridge request.
public enum EntitlementRequest: Equatable, Sendable {
  case get
  case set(entitled: Bool)

  /// Parse a raw message body into a request; nil means "not an entitlement message" so hosts can
  /// fall through to the settings bridge or reject.
  public static func parse(_ body: Any) -> EntitlementRequest? {
    guard let dict = body as? [String: Any], let kind = dict["kind"] as? String else { return nil }
    switch kind {
    case "getEntitlement":
      return .get
    case "setEntitlement":
      guard let entitled = dict["entitled"] as? Bool else { return nil }
      return .set(entitled: entitled)
    default:
      return nil
    }
  }
}

/// Processes entitlement requests against a SharedEntitlementStore. `set` stamps `updatedAt` with
/// the injected clock (tests pass a fixed one); both requests reply with the stored record JSON.
public struct EntitlementBridge {
  private let store: SharedEntitlementStore
  private let now: () -> Int

  public init(
    store: SharedEntitlementStore,
    now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
  ) {
    self.store = store
    self.now = now
  }

  public func handle(_ request: EntitlementRequest) -> String {
    switch request {
    case .get:
      guard let stored = store.peek() else { return "" }
      return Self.encode(stored)
    case .set(let entitled):
      let record = EntitlementRecord(entitled: entitled, updatedAt: now())
      store.save(record)
      return Self.encode(record)
    }
  }

  /// Parse + handle in one call; nil when the body isn't an entitlement request.
  public func handle(rawBody body: Any) -> String? {
    guard let request = EntitlementRequest.parse(body) else { return nil }
    return handle(request)
  }

  static func encode(_ record: EntitlementRecord) -> String {
    guard let data = try? JSONEncoder().encode(record),
          let string = String(data: data, encoding: .utf8)
    else { return "" }
    return string
  }
}
