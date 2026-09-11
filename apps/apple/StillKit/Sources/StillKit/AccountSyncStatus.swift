import Foundation

/// Local display state published by the authenticated containing app. Never an entitlement or
/// part of client-writable settings. Times are milliseconds since epoch, not server versions.
public struct AccountSyncStatus: Codable, Equatable, Sendable {
  public let accountId: String
  public let email: String?
  public let lastSyncedAt: Double?
  public let pendingUpload: Bool
  public let cloudReachable: Bool
  public let updatedAt: Double

  private enum CodingKeys: String, CodingKey {
    case accountId, email, lastSyncedAt, pendingUpload, cloudReachable, updatedAt
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    accountId = try container.decode(String.self, forKey: .accountId)
    email = try container.decode(String?.self, forKey: .email)
    lastSyncedAt = try container.decode(Double?.self, forKey: .lastSyncedAt)
    pendingUpload = try container.decode(Bool.self, forKey: .pendingUpload)
    cloudReachable = try container.decode(Bool.self, forKey: .cloudReachable)
    updatedAt = try container.decode(Double.self, forKey: .updatedAt)
    guard accountId.utf16.count == 36, UUID(uuidString: accountId) != nil,
          (email?.utf16.count ?? 0) <= 320,
          updatedAt.isFinite, updatedAt >= 0, updatedAt <= 8.64e15,
          lastSyncedAt.map({ $0.isFinite && $0 >= 0 && $0 <= 8.64e15 }) ?? true
    else {
      throw DecodingError.dataCorrupted(.init(
        codingPath: decoder.codingPath, debugDescription: "Invalid account sync status"))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(accountId, forKey: .accountId)
    try container.encode(email, forKey: .email)
    try container.encode(lastSyncedAt, forKey: .lastSyncedAt)
    try container.encode(pendingUpload, forKey: .pendingUpload)
    try container.encode(cloudReachable, forKey: .cloudReachable)
    try container.encode(updatedAt, forKey: .updatedAt)
  }
}

/// Uses the same injectable backing as the settings and entitlement stores, with its own fixed key.
/// Only the trusted WK router calls `save`; the Safari native handler delegates to `readReply`.
public final class AccountSyncStatusStore {
  private let backing: SettingsBacking

  public init(backing: SettingsBacking) {
    self.backing = backing
  }

  public static func appGroup(_ identifier: String = StillAppGroup.identifier) -> AccountSyncStatusStore {
    AccountSyncStatusStore(
      backing: AppGroupBacking(appGroupId: identifier, key: "still:account-sync-status") ?? InMemoryBacking())
  }

  public func peek() -> AccountSyncStatus? {
    guard let data = backing.read() else { return nil }
    return try? JSONDecoder().decode(AccountSyncStatus.self, from: data)
  }

  @discardableResult
  public func save(rawStatus: Any) -> Bool {
    if rawStatus is NSNull {
      clear()
      return true
    }
    guard JSONSerialization.isValidJSONObject(rawStatus),
          let data = try? JSONSerialization.data(withJSONObject: rawStatus),
          let record = try? JSONDecoder().decode(AccountSyncStatus.self, from: data),
          let encoded = try? JSONEncoder().encode(record)
    else { return false }
    backing.write(encoded)
    return true
  }

  /// Erases the account fields synchronously. A JSON null fits the existing backing's write API
  /// without retaining personal data or coupling this lane to settings storage migrations.
  public func clear() {
    backing.write(Data("null".utf8))
  }

  /// The extension's read-only native lane. Unknown kinds (including setters) do not touch storage.
  public func readReply(rawBody: Any) -> [String: Any]? {
    guard let body = rawBody as? [String: Any], body["kind"] as? String == "getAccountSyncStatus"
    else { return nil }
    guard let record = peek(), let data = try? JSONEncoder().encode(record),
          let json = String(data: data, encoding: .utf8)
    else { return ["accountSyncStatus": NSNull()] }
    return ["accountSyncStatus": json]
  }
}
