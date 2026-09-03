import Foundation

/// Local-only cohort facts reported by Apple's verified AppTransaction. They are retained in the
/// App Group so an eventual paid-tier change can honor installs from the included-access era even
/// when the user never creates an account. This record is never sent to Still's backend.
public struct OriginalInstallRecord: Codable, Equatable, Sendable {
  public let applicationVersion: String
  public let originalPurchaseDate: Date

  public init(applicationVersion: String, originalPurchaseDate: Date) {
    self.applicationVersion = applicationVersion
    self.originalPurchaseDate = originalPurchaseDate
  }
}

public enum OriginalInstall {
  static let storageKey = "still:originalInstall"

  /// Persist the first verified AppTransaction only. Later launches and app updates must not move
  /// a user into a newer cohort by overwriting the original version or purchase date.
  @discardableResult
  public static func recordIfAbsent(
    _ record: OriginalInstallRecord,
    defaults: UserDefaults
  ) -> OriginalInstallRecord {
    if let existing = current(defaults) { return existing }
    if let data = try? JSONEncoder().encode(record) {
      defaults.set(data, forKey: storageKey)
    }
    return record
  }

  public static func current(_ defaults: UserDefaults) -> OriginalInstallRecord? {
    guard let data = defaults.data(forKey: storageKey) else { return nil }
    return try? JSONDecoder().decode(OriginalInstallRecord.self, from: data)
  }
}
