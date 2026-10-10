import Foundation
import CoreFoundation

/// Product-analytics identity for the Apple apps and their Safari extensions, mirroring
/// `packages/core/src/analytics/identity.ts`:
///
///   * `installId` names this device's copy of Still. It lives in the App Group, so the app and its
///     Safari extension on the same device report as one install.
///   * `anchorId` is the anonymous person id. A new device takes the anchor iCloud key-value storage
///     already holds for this Apple ID, so an iPhone and a Mac are one person without signing in; the
///     first device shares its own. Ids never change once made: a device whose record was made
///     before iCloud delivered an anchor (or by the Safari extension first) keeps its own, and
///     signing in merges it into the account.
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
    if let existing = storedInstall() {
      // Ids never change once made (the extension may have made them): changing one would split
      // this device's own history, and merging anonymous ids safely needs a record of every merge
      // across devices, which nothing has. Signing in merges installs into the account instead.
      install = existing
    } else {
      install = AnalyticsInstall(installId: newId(), anchorId: newId())
    }
    if created {
      if let ubiquitous {
        let shared = ubiquitous.string(forKey: Self.anchorKey)
        if let shared, Self.isId(shared) {
          // This Apple ID already has Still somewhere. A new record takes that person's anchor; a
          // record the extension already made keeps its own (see above) but is still "returning".
          returning = true
          if storedInstall() == nil { install = AnalyticsInstall(installId: install.installId, anchorId: shared) }
        } else {
          ubiquitous.set(install.anchorId, forKey: Self.anchorKey)
        }
      }
      save(install)
      group.set(true, forKey: Self.appSeenKey)
    }

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
      noticeSeen: group.object(forKey: Self.noticeKey) as? Bool ?? false
    )
  }

  /// The Safari extension's read. Reuses the app's record; if the extension runs first, it creates
  /// one (the extension has no iCloud access), which the app then keeps and shares.
  public func extensionInstall() -> AnalyticsInstall {
    if let existing = storedInstall() { return existing }
    let install = AnalyticsInstall(installId: newId(), anchorId: newId())
    save(install)
    return install
  }

  // MARK: Consent (the app's "Share usage data" switch; the extension follows it)

  /// On unless the person turned it off.
  public var consent: Bool {
    if let permission = analyticsPermission { return permission["state"] as? String == "granted" }
    return group.object(forKey: Self.consentKey) as? Bool ?? true
  }

  public func setConsent(_ enabled: Bool) {
    // A legacy switch must never recreate a combined permission or discard its stop authority.
    if var permission = analyticsPermission {
      if !enabled, permission["state"] as? String == "granted" {
        permission["state"] = "stopped"
        guard let generation = Self.integer(permission["generation"]) else { return }
        permission["generation"] = min(9_007_199_254_740_991, generation + 1)
        _ = commitAnalyticsPermission(permission)
      }
      return
    }
    group.set(enabled, forKey: Self.consentKey)
  }

  /// True once a choice was written, either way. Before that `consent` reads the default (on),
  /// which is not an answer, so nothing may present it as a saved choice.
  public var consentAnswered: Bool {
    analyticsPermission != nil || (group.object(forKey: Self.consentKey) as? Bool) != nil
  }

  /// The `setAnalyticsConsent` bridge reply: write the person's explicit choice, then report the
  /// stored value read back and whether it is an explicit answer.
  public func commitConsent(_ enabled: Bool) -> [String: Any] {
    setConsent(enabled)
    return ["ok": true, "enabled": consent, "answered": consentAnswered]
  }

  /// The same per-installation consent slot, with the current combined permission schema.
  /// Reading an older Boolean never grants permission, creates identities, or writes anything.
  public var analyticsPermission: [String: Any]? {
    guard let raw = group.string(forKey: Self.consentKey), raw.utf8.count <= 4_096, !raw.contains("\\"),
          let data = raw.data(using: .utf8),
          let value = try? JSONSerialization.jsonObject(with: data) else { return nil }
    // All record keys are fixed ASCII. Reject duplicate/escaped keys before JSON's dictionary
    // decoding could hide them; every value is a Boolean, integer, or bounded ASCII string.
    guard let keys = try? NSRegularExpression(pattern: #""([^"\\]+)"\s*:"#),
          keys.numberOfMatches(in: raw, range: NSRange(raw.startIndex..., in: raw)) == 12
    else { return nil }
    return Self.readAnalyticsPermission(value)
  }

  public func analyticsPermissionReply() -> [String: Any] {
    if let permission = analyticsPermission { return ["ok": true, "permission": permission] }
    // Preserve an Off choice without inventing an optional identity or a fresh permission.
    if group.object(forKey: Self.consentKey) as? Bool == false { return ["ok": true, "permission": false] }
    return ["ok": true, "permission": NSNull()]
  }

  /// Used by the existing shared consent authority after a fresh reviewed choice. A write is
  /// acknowledged only after readback; legacy true and malformed records cannot reach this lane.
  public func commitAnalyticsPermission(_ value: Any) -> [String: Any] {
    if let boolean = value as? NSNumber, CFGetTypeID(boolean) == CFBooleanGetTypeID() {
      guard !boolean.boolValue else { return ["ok": false] }
      setConsent(false)
      guard !consent else { return ["ok": false] }
      return analyticsPermissionReply()
    }
    guard let permission = Self.readAnalyticsPermission(value),
          let data = try? JSONSerialization.data(withJSONObject: permission, options: [.sortedKeys]),
          let raw = String(data: data, encoding: .utf8) else { return ["ok": false] }
    group.set(raw, forKey: Self.consentKey)
    guard let stored = analyticsPermission,
          NSDictionary(dictionary: stored).isEqual(to: permission) else { return ["ok": false] }
    return analyticsPermissionReply()
  }

  private static func readAnalyticsPermission(_ value: Any) -> [String: Any]? {
    guard let v = value as? [String: Any],
          Set(v.keys) == Set(["schemaVersion", "state", "version", "origin", "generation", "provider", "purposes"]),
          let schema = integer(v["schemaVersion"]), schema == 1,
          let state = v["state"] as? String, state == "granted" || state == "stopped",
          let version = v["version"] as? String, version.utf8.count == 64,
          version.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          let origin = v["origin"] as? String, isId(origin),
          let generation = integer(v["generation"]), generation >= 1,
          let provider = v["provider"] as? [String: Any], Set(provider.keys) == Set(["anonymousId", "deviceId"]),
          let anonymous = provider["anonymousId"] as? String, isId(anonymous),
          let device = provider["deviceId"] as? String, isId(device), anonymous != device,
          let purposes = v["purposes"] as? [String: Any], Set(purposes.keys) == Set(["usage", "email", "ai"]),
          purposes.values.allSatisfy({ item in
            guard let number = item as? NSNumber else { return false }
            return CFGetTypeID(number) == CFBooleanGetTypeID() && number.boolValue
          }) else { return nil }
    return ["schemaVersion": 1, "state": state, "version": version, "origin": origin,
            "generation": generation, "provider": ["anonymousId": anonymous, "deviceId": device],
            "purposes": ["usage": true, "email": true, "ai": true]]
  }

  private static func integer(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, abs(number.doubleValue) <= 9_007_199_254_740_991,
          number.doubleValue.rounded() == number.doubleValue else { return nil }
    return number.int64Value
  }

  public func acknowledgeNotice() {
    group.set(true, forKey: Self.noticeKey)
  }

  // MARK: Native message lanes

  /// The Safari extension's read-only lanes. Unknown kinds return nil.
  ///
  ///   * `{kind:"analyticsContext"}` → `{analytics:{installId, anchorId, consent, platform, device}}`.
  ///     `platform` ("ios"/"macos") and `device` ("phone"/"tablet"/"desktop") come from the native
  ///     handler, which knows them for certain; the browser's own platform report can mistake an iPad.
  ///   * `{kind:"analyticsPermission"}` → `{analyticsPermission: <record> | false | null}`: the app's
  ///     usage-sharing permission as stored, so a V3 extension reports only under the app's choice.
  ///     It never creates ids, grants, stops or writes anything.
  public func extensionReply(rawBody: Any, platform: String, device: String) -> [String: Any]? {
    guard let body = rawBody as? [String: Any] else { return nil }
    if body["kind"] as? String == "analyticsPermission" {
      return ["analyticsPermission": analyticsPermissionReply()["permission"] ?? NSNull()]
    }
    guard body["kind"] as? String == "analyticsContext" else { return nil }
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

/// One value per launch, computed once and shared by every caller, including callers that arrive
/// while the first computation is still running. The app's `analyticsContext` read uses it: on a
/// first launch that read can wait several seconds for iCloud, and a second caller in that window
/// must wait for the same result rather than run `appContext` again (which records the launch and
/// would report a different, already-recorded context).
@available(iOS 13.0, macOS 10.15, *)
@MainActor
public final class LaunchValue<Value: Sendable> {
  private var task: Task<Value, Never>?

  public init() {}

  public func get(_ make: @escaping @MainActor () async -> Value) async -> Value {
    if let task { return await task.value }
    let task = Task { @MainActor in await make() }
    self.task = task
    return await task.value
  }
}
