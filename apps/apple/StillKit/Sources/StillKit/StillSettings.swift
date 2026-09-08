import Foundation

// The single settings set, mirroring the TypeScript `StillSettings` (packages/shared-types) so the
// app, the Safari extension, and the WKWebView-hosted web UI all read/write the same JSON shape.
// Keys are intentionally camelCase to match the web side exactly.

public struct StillServices: Codable, Equatable, Sendable {
  public var youtube: Bool
  public var instagram: Bool
  public var tiktok: Bool
  public var facebook: Bool

  public init(youtube: Bool = true, instagram: Bool = true, tiktok: Bool = true, facebook: Bool = true) {
    self.youtube = youtube
    self.instagram = instagram
    self.tiktok = tiktok
    self.facebook = facebook
  }

  private enum CodingKeys: String, CodingKey {
    case youtube
    case instagram
    case tiktok
    case facebook
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    // Mirror TypeScript parseServices(): absent service keys default off for back-compat, while
    // present-but-malformed values still throw and reject the blob.
    youtube = try container.decodeIfPresent(Bool.self, forKey: .youtube) ?? false
    instagram = try container.decodeIfPresent(Bool.self, forKey: .instagram) ?? false
    tiktok = try container.decodeIfPresent(Bool.self, forKey: .tiktok) ?? false
    facebook = try container.decodeIfPresent(Bool.self, forKey: .facebook) ?? false
  }
}

public struct StillSettings: Codable, Equatable, Sendable {
  /// Master kill switch.
  public var globalOn: Bool
  /// Per-service master toggles.
  public var services: StillServices
  /// eTLD+1 hosts the user has paused.
  public var pauses: [String]
  /// Epoch milliseconds of the last write — the last-write-wins key (matches JS `Date.now()`).
  public var updatedAt: Int

  public init(globalOn: Bool, services: StillServices, pauses: [String], updatedAt: Int) {
    self.globalOn = globalOn
    self.services = services
    self.pauses = pauses
    self.updatedAt = updatedAt
  }

  private enum CodingKeys: String, CodingKey {
    case globalOn
    case services
    case pauses
    case updatedAt
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    globalOn = try container.decode(Bool.self, forKey: .globalOn)
    services = try container.decode(StillServices.self, forKey: .services)
    // Mirror TypeScript parseSettings(): absent pauses defaults to [] for older blobs; a present
    // malformed pauses value still throws.
    pauses = try container.decodeIfPresent([String].self, forKey: .pauses) ?? []
    updatedAt = try container.decode(Int.self, forKey: .updatedAt)
  }

  /// Fresh-install defaults: everything on, nothing paused (matches the web `DEFAULT_SETTINGS`).
  public static let `default` = StillSettings(
    globalOn: true,
    services: StillServices(),
    pauses: [],
    updatedAt: 0,
  )
}

public struct SettingsSyncMetadata: Codable, Equatable, Sendable {
  public var version: Int
  public var serverUpdatedAt: String
  public var lastWriteId: String?

  public init(version: Int, serverUpdatedAt: String, lastWriteId: String?) {
    self.version = version
    self.serverUpdatedAt = serverUpdatedAt
    self.lastWriteId = lastWriteId
  }
}

public struct StoredSettingsRecord: Codable, Equatable, Sendable {
  public var settings: StillSettings
  public var syncMetadata: SettingsSyncMetadata?

  /// How many times a sign-in has repointed the device that wrote this record at a different
  /// account, counted rather than named.
  ///
  /// `syncMetadata.version` above orders writes within ONE account's settings row and says nothing
  /// when the row itself changes, which is exactly what happens when one person signs out of a
  /// shared iPhone or Mac and the next person signs in: the newcomer's account can sit on a lower
  /// version than the one left behind. Without this counter the shared store keeps the previous
  /// person's settings and hands them back, and they end up published into the newcomer's account.
  ///
  /// The web layer mints it (`StoredSettingsRecord.syncEpoch` in packages/core) and this record
  /// carries it across the bridge in both directions, so the app, the Safari extension and the
  /// shared container all order records the same way.
  ///
  /// Absent, rather than zero, on a record written before this field existed. Absent means the
  /// record has never been repointed, so ordering ranks it exactly where zero ranks.
  public var syncEpoch: Int?

  public init(settings: StillSettings, syncMetadata: SettingsSyncMetadata?, syncEpoch: Int? = nil) {
    self.settings = settings
    self.syncMetadata = syncMetadata
    self.syncEpoch = syncEpoch
  }

  private enum CodingKeys: String, CodingKey {
    case settings
    case syncMetadata
    case syncEpoch
  }

  public init(from decoder: Decoder) throws {
    if let container = try? decoder.container(keyedBy: CodingKeys.self),
       container.contains(.settings) {
      settings = try container.decode(StillSettings.self, forKey: .settings)
      syncMetadata = try container.decodeIfPresent(SettingsSyncMetadata.self, forKey: .syncMetadata)
      // Forgiving on purpose, and on the same terms as the web validator: a counter that is not a
      // whole number of repoints is read as absent rather than taking the whole record down, which
      // would strand the settings on the far side of the bridge.
      let decodedEpoch = try? container.decodeIfPresent(Int.self, forKey: .syncEpoch)
      syncEpoch = decodedEpoch.flatMap { $0 >= 0 ? $0 : nil }
      return
    }
    settings = try StillSettings(from: decoder)
    syncMetadata = nil
    syncEpoch = nil
  }
}
