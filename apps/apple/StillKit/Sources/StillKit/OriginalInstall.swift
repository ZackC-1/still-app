import Foundation

/// Which of Apple's two version strings an `OriginalInstallRecord.applicationVersion` holds.
///
/// `AppTransaction.originalAppVersion` is documented as returning `CFBundleVersion` on iOS, iPadOS,
/// tvOS and watchOS, and `CFBundleShortVersionString` on macOS. For Still that means the very same
/// release records a build number like "6" on iPhone and a marketing version like "1.0.1" on Mac.
/// The two are different namespaces and comparing one against the other silently misclassifies a
/// whole platform, so every record states which one it is carrying.
public enum OriginalAppVersionKind: String, Codable, Sendable {
  /// `CFBundleVersion`, Still's build number. What iOS, iPadOS, tvOS and watchOS report.
  case buildNumber
  /// `CFBundleShortVersionString`, Still's marketing version. What macOS reports.
  case marketingVersion
}

/// Local-only facts about when this device first ran a Still build that keeps this record. They are
/// retained in the App Group so an eventual paid-tier change can honor installs from the era when
/// everything was included, even for someone who never created an account. Nothing here is ever
/// sent to Still's backend.
///
/// The record has two halves, because they have very different reliability:
///
///   * The local half is written on first launch from the app's own bundle. It needs no network, no
///     Apple Account and no App Store round trip, so every install gets one.
///   * The verified half comes from Apple's `AppTransaction` and can be absent. It is richer, since
///     it describes the ORIGINAL purchase rather than this device's first launch, but it is only
///     available on newer systems and only when Apple will hand it over. In the sandbox and in
///     TestFlight, Apple documents both of its values as placeholders rather than real data, so a
///     record captured on a test build is not evidence of anything.
public struct OriginalInstallRecord: Codable, Equatable, Sendable {
  /// When this record was written: the first launch of a Still build that records it. On a new
  /// install that is the install date. On a device updating from an earlier Still it is the update
  /// date, which is still enough to place someone inside the included-access era. Means exactly the
  /// same thing on every Apple platform.
  public let firstRecordedAt: Date

  /// Still's own marketing version (`CFBundleShortVersionString`) at that first launch. The same
  /// namespace on iOS and macOS, unlike `applicationVersion` below.
  public let firstRecordedAppVersion: String

  /// Apple's verified original application version, or nil when no verified app transaction was
  /// available. Never compare this against a version number without reading
  /// `applicationVersionKind` first: on iOS it is a build number and on macOS it is a marketing
  /// version.
  public let applicationVersion: String?

  /// Which namespace `applicationVersion` is in. Nil exactly when `applicationVersion` is nil.
  public let applicationVersionKind: OriginalAppVersionKind?

  /// Apple's verified original purchase date: when this Apple Account first obtained Still, on any
  /// device. This one means the same thing on both platforms. Nil when unavailable.
  public let originalPurchaseDate: Date?

  public init(
    firstRecordedAt: Date,
    firstRecordedAppVersion: String,
    applicationVersion: String? = nil,
    applicationVersionKind: OriginalAppVersionKind? = nil,
    originalPurchaseDate: Date? = nil
  ) {
    self.firstRecordedAt = firstRecordedAt
    self.firstRecordedAppVersion = firstRecordedAppVersion
    self.applicationVersion = applicationVersion
    self.applicationVersionKind = applicationVersionKind
    self.originalPurchaseDate = originalPurchaseDate
  }
}

public enum OriginalInstall {
  static let storageKey = "still:originalInstall"

  /// How many times a device may ask Apple for its app transaction before giving up for good.
  ///
  /// Asking is not free: Apple returns the locally cached app transaction when there is one and
  /// otherwise requests it from the App Store, which can require the customer to authenticate. On a
  /// device restored from a backup, handed over from someone else, or simply not signed in to the
  /// App Store, an unbounded retry would put a sign-in sheet in front of an app that sells nothing,
  /// at launch, over and over. A small ceiling buys the extra detail where it is available and
  /// stops asking where it is not. The local half of the record survives either way.
  public static let maxVerifiedAttempts = 3

  static let verifiedAttemptsKey = "still:originalInstallVerifiedAttempts"

  /// The namespace `AppTransaction.originalAppVersion` uses on the platform this build runs on.
  /// Derived here, once, so no call site has to remember Apple's platform split.
  public static var applicationVersionKindForThisPlatform: OriginalAppVersionKind {
    #if os(macOS)
      return .marketingVersion
    #else
      return .buildNumber
    #endif
  }

  /// Write the local half exactly once. Read-before-write is the load-bearing behavior: an ordinary
  /// relaunch or an app update must return the existing record, never a fresher one, or an update
  /// would quietly move someone into a newer cohort.
  @discardableResult
  public static func ensure(
    firstRecordedAt: Date,
    appVersion: String,
    defaults: UserDefaults
  ) -> OriginalInstallRecord {
    if let existing = current(defaults) { return existing }
    let record = OriginalInstallRecord(
      firstRecordedAt: firstRecordedAt,
      firstRecordedAppVersion: appVersion
    )
    write(record, defaults: defaults)
    return record
  }

  /// True while it is still worth asking Apple for the verified half: no record yet has it, and the
  /// attempt ceiling has not been reached.
  public static func shouldRequestVerifiedValues(_ defaults: UserDefaults) -> Bool {
    if current(defaults)?.applicationVersion != nil { return false }
    return defaults.integer(forKey: verifiedAttemptsKey) < maxVerifiedAttempts
  }

  /// Count an attempt. Called BEFORE the request, so a request that hangs, fails, or never returns
  /// still moves the device toward the ceiling rather than retrying forever.
  @discardableResult
  public static func countVerifiedAttempt(_ defaults: UserDefaults) -> Int {
    let next = defaults.integer(forKey: verifiedAttemptsKey) + 1
    defaults.set(next, forKey: verifiedAttemptsKey)
    return next
  }

  /// Fill in Apple's verified values, once, leaving the local half exactly as it was written on
  /// first launch. Does nothing when there is no local record yet, or when the verified half is
  /// already present.
  @discardableResult
  public static func fillVerifiedValues(
    applicationVersion: String,
    kind: OriginalAppVersionKind,
    originalPurchaseDate: Date,
    defaults: UserDefaults
  ) -> OriginalInstallRecord? {
    guard let existing = current(defaults) else { return nil }
    guard existing.applicationVersion == nil else { return existing }
    let filled = OriginalInstallRecord(
      firstRecordedAt: existing.firstRecordedAt,
      firstRecordedAppVersion: existing.firstRecordedAppVersion,
      applicationVersion: applicationVersion,
      applicationVersionKind: kind,
      originalPurchaseDate: originalPurchaseDate
    )
    write(filled, defaults: defaults)
    return filled
  }

  public static func current(_ defaults: UserDefaults) -> OriginalInstallRecord? {
    guard let data = defaults.data(forKey: storageKey) else { return nil }
    return try? JSONDecoder().decode(OriginalInstallRecord.self, from: data)
  }

  private static func write(_ record: OriginalInstallRecord, defaults: UserDefaults) {
    if let data = try? JSONEncoder().encode(record) {
      defaults.set(data, forKey: storageKey)
    }
  }
}
