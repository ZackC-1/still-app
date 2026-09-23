import Foundation

/// Product-analytics identity for the Apple apps and their Safari extensions, mirroring
/// `packages/core/src/analytics/identity.ts`:
///
///   * `installId` names this device's copy of Still. It lives in the App Group, so the app and its
///     Safari extension on the same device report as one install.
///   * `anchorId` is the anonymous person id. The app shares it through iCloud key-value storage,
///     so an iPhone and a Mac on the same Apple ID are recognised as one person without signing in.
///     A device with iCloud unavailable, or where the extension ran before the app, uses its
///     install id instead.
///
/// No device trait, IP address or advertising identifier is involved. Nothing here is sent
/// anywhere by StillKit; the web layer reads it through the native bridge and reports it only
/// while the person shares usage data (`consent`).
public struct AnalyticsInstall: Codable, Equatable, Sendable {
  public let installId: String
  public let anchorId: String
}

/// What the app's web view needs at launch.
public struct AnalyticsAppContext: Equatable, Sendable {
  public let install: AnalyticsInstall
  /// True on the launch that created this device's install record.
  public let created: Bool
  /// A new install whose person anchor was already in iCloud: this Apple ID had Still before.
  public let returning: Bool
  /// The version this device last ran, when it differs from the current one. On the first launch
  /// of the build that introduced analytics, an earlier install is recognised by its original-
  /// install record, and this carries the version that record first saw.
  public let previousVersion: String?
  public let consent: Bool
  public let noticeSeen: Bool
  /// The anonymous id this device reported under before the app adopted `install.anchorId` (the
  /// Safari extension's provisional id, or a local anchor replaced by one that synced late through
  /// iCloud). The web layer merges it into the new anchor once.
  public let previousAnchorId: String?
}

/// A minimal key-value slot so tests need neither an App Group nor iCloud.
public protocol AnalyticsKeyValue: AnyObject {
  func string(forKey key: String) -> String?
  func object(forKey key: String) -> Any?
  func set(_ value: Any?, forKey key: String)
}

extension UserDefaults: AnalyticsKeyValue {}

/// `NSUbiquitousKeyValueStore` has the same three methods; the app passes `.default`.
extension NSUbiquitousKeyValueStore: AnalyticsKeyValue {}

public final class AnalyticsIdentityStore {
  static let installKey = "still.analytics.install"
  static let anchorKey = "still.analytics.anchor"
  static let consentKey = "still.analytics.consent"
  static let noticeKey = "still.analytics.notice-seen"
  static let lastVersionKey = "still.analytics.last-version"
  /// The anchor this device used before adopting its current one. Kept (not only returned once) so
  /// the merge is sent whenever sharing allows; the web layer sends it once.
  static let previousAnchorKey = "still.analytics.previous-anchor"
  /// Set once the app has read the install record. The Safari extension can create the record
  /// first (it runs on page loads); the app's first read still has to report the install or update
  /// and share the anchor through iCloud.
  static let appSeenKey = "still.analytics.app-seen"
  /// Used as `previousVersion` when an earlier install is certain but its version is not.
  public static let unknownEarlierVersion = "0"

  /// Whether this device ran Still before this launch, judged from App Group state that every
  /// earlier release wrote (onboarding completion, the install-generation id, synced settings).
  /// Must be read at the very start of a launch, before this launch writes any of them.
  public static func earlierInstallEvidence(_ defaults: UserDefaults) -> Bool {
    defaults.object(forKey: "still.onboarding.completed.v1") != nil
      || defaults.object(forKey: "still.installGeneration.v1") != nil
      || defaults.object(forKey: "still:settings") != nil
  }

  /// Captured by the app delegate at launch; see `earlierInstallEvidence`.
  nonisolated(unsafe) public static var earlierInstallAtLaunch = false

  private let group: AnalyticsKeyValue
  private let newId: () -> String

  public init(group: AnalyticsKeyValue, newId: @escaping () -> String = { UUID().uuidString.lowercased() }) {
    self.group = group
    self.newId = newId
  }

  public static func appGroup(_ identifier: String = StillAppGroup.identifier) -> AnalyticsIdentityStore {
    AnalyticsIdentityStore(group: UserDefaults(suiteName: identifier) ?? .standard)
  }

  /// The iCloud key holding the person anchor (for code that waits on iCloud's initial sync).
  public static var iCloudAnchorKey: String { anchorKey }

  /// Whether the app has read this device's record before; a first read waits for iCloud.
  public var appHasReadRecord: Bool { group.object(forKey: Self.appSeenKey) != nil }

  // MARK: Install record

  public func storedInstall() -> AnalyticsInstall? {
    guard let raw = group.string(forKey: Self.installKey), let data = raw.data(using: .utf8),
          let install = try? JSONDecoder().decode(AnalyticsInstall.self, from: data),
          Self.isId(install.installId), Self.isId(install.anchorId)
    else { return nil }
    return install
  }

  private func save(_ install: AnalyticsInstall) {
    if let data = try? JSONEncoder().encode(install), let raw = String(data: data, encoding: .utf8) {
      group.set(raw, forKey: Self.installKey)
    }
  }

  /// The app's launch read. Creates the install record on first launch, consulting iCloud for the
  /// person anchor, and records this version as the last one run.
  public func appContext(
    appVersion: String,
    ubiquitous: AnalyticsKeyValue?,
    earlierInstallVersion: String?
  ) -> AnalyticsAppContext {
    // "Created" from the app's point of view: the first time the app reads the record, whether it
    // makes it now or the Safari extension made it earlier on a page load.
    let created = group.object(forKey: Self.appSeenKey) == nil
    var returning = false
    var install: AnalyticsInstall
    var hadRecord = false
    if let existing = storedInstall() {
      install = existing
      hadRecord = true
    } else {
      let installId = newId()
      install = AnalyticsInstall(installId: installId, anchorId: installId)
    }
    let startingAnchor = install.anchorId
    if created {
      if let ubiquitous {
        if let shared = ubiquitous.string(forKey: Self.anchorKey), Self.isId(shared) {
          returning = shared != install.anchorId
          install = AnalyticsInstall(installId: install.installId, anchorId: shared)
        } else {
          // A record made by the extension carries its install id as the anchor; share a separate
          // anchor so the install id itself never leaves the device through iCloud.
          if install.anchorId == install.installId { install = AnalyticsInstall(installId: install.installId, anchorId: newId()) }
          ubiquitous.set(install.anchorId, forKey: Self.anchorKey)
        }
      }
      save(install)
      group.set(true, forKey: Self.appSeenKey)
    } else if group.string(forKey: Self.previousAnchorKey) == nil,
              let ubiquitous, let shared = ubiquitous.string(forKey: Self.anchorKey), Self.isId(shared),
              shared != install.anchorId {
      // At most once per device: a second adoption would alias into an id that was itself an alias
      // destination, which PostHog refuses. The first adopted anchor stays canonical.
      // iCloud delivered this person's anchor after this device had made its own (a first launch
      // before sync arrived, or two devices racing). Adopt it; the old one is merged below.
      install = AnalyticsInstall(installId: install.installId, anchorId: shared)
      save(install)
    }
    // Only an id something may already have reported under needs merging. Remember it until a
    // later change replaces it, so a merge discarded while sharing was off is sent later.
    if hadRecord && startingAnchor != install.anchorId {
      group.set(startingAnchor, forKey: Self.previousAnchorKey)
    }
    let stored = group.string(forKey: Self.previousAnchorKey)
    let previousAnchorId = stored.flatMap { Self.isId($0) && $0 != install.anchorId ? $0 : nil }

    let last = group.string(forKey: Self.lastVersionKey)
    var previousVersion: String?
    if let last, last != appVersion {
      previousVersion = last
    } else if last == nil, created, let earlier = earlierInstallVersion, earlier != appVersion {
      // Still ran here before analytics existed: this is an update, not a new install.
      previousVersion = earlier
    }
    group.set(appVersion, forKey: Self.lastVersionKey)

    return AnalyticsAppContext(
      install: install,
      created: created,
      returning: returning && previousVersion == nil,
      previousVersion: previousVersion,
      consent: consent,
      noticeSeen: group.object(forKey: Self.noticeKey) as? Bool ?? false,
      previousAnchorId: previousAnchorId
    )
  }

  /// The Safari extension's read. Reuses the app's record; if the extension runs first, it creates
  /// one without an iCloud anchor (the extension has no iCloud access), which the app then adopts.
  public func extensionInstall() -> AnalyticsInstall {
    if let existing = storedInstall() { return existing }
    let installId = newId()
    let install = AnalyticsInstall(installId: installId, anchorId: installId)
    save(install)
    return install
  }

  // MARK: Consent (the app's "Share usage data" switch; the extension follows it)

  /// On unless the person turned it off.
  public var consent: Bool {
    group.object(forKey: Self.consentKey) as? Bool ?? true
  }

  public func setConsent(_ enabled: Bool) {
    group.set(enabled, forKey: Self.consentKey)
  }

  public func acknowledgeNotice() {
    group.set(true, forKey: Self.noticeKey)
  }

  // MARK: Native message lanes

  /// The Safari extension's read-only lane: `{kind:"analyticsContext"}` →
  /// `{analytics:{installId, anchorId, consent, platform, device}}`. Unknown kinds return nil.
  /// `platform` ("ios"/"macos") and `device` ("phone"/"tablet"/"desktop") come from the native
  /// handler, which knows them for certain; the browser's own platform report can mistake an iPad.
  public func extensionReply(rawBody: Any, platform: String, device: String) -> [String: Any]? {
    guard let body = rawBody as? [String: Any], body["kind"] as? String == "analyticsContext"
    else { return nil }
    let install = extensionInstall()
    return ["analytics": [
      "installId": install.installId,
      "anchorId": install.anchorId,
      "consent": consent,
      "platform": platform,
      "device": device,
    ]]
  }

  /// This device's class for analytics, from compile-time platform and the interface idiom.
  public static func deviceClass(isPad: Bool) -> String {
    #if os(macOS)
    return "desktop"
    #else
    return isPad ? "tablet" : "phone"
    #endif
  }

  public static var platformName: String {
    #if os(macOS)
    return "macos"
    #else
    return "ios"
    #endif
  }

  static func isId(_ value: String) -> Bool {
    value.count == 36 && UUID(uuidString: value) != nil
  }
}
