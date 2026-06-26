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
