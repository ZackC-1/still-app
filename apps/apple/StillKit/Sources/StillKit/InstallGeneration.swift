import Foundation

/// The install-generation marker (issue #63). The app stamps every install with a stable id in the
/// shared App Group; the Safari extension compares it against the last id it saw and purges its
/// cached entitlement when the id CHANGES — an affirmative reinstall signal. An absent id (App
/// Group unreachable, old app build) must stay a no-op on the extension side, preserving the
/// offline never-downgrade design.
///
/// Pure `UserDefaults` so it's unit-testable with an in-memory suite, mirroring `OnboardingGate`.
public enum InstallGeneration {
  /// ⚠️ Unlike `OnboardingGate.completedKey`, this key must NEVER be bumped as a soft reset: a
  /// bump makes every device look freshly reinstalled and would mass-relock Pro across the install
  /// base on the next extension pull. Any future format change must migrate the old key's value
  /// forward into the new key instead of treating its absence as a fresh install.
  static let key = "still.installGeneration.v1"

  /// The production defaults — the shared App Group suite, falling back to standard defaults if
  /// the App Group isn't provisioned (mirrors `OnboardingGate.appGroupDefaults`).
  public static func appGroupDefaults(_ identifier: String = StillAppGroup.identifier) -> UserDefaults {
    UserDefaults(suiteName: identifier) ?? .standard
  }

  /// Return the install id, generating and persisting one exactly once per install. Read-before-
  /// write is the load-bearing behavior: an ordinary relaunch must return the existing id, never a
  /// fresh one.
  @discardableResult
  public static func ensure(_ defaults: UserDefaults) -> String {
    if let existing = current(defaults) { return existing }
    let id = UUID().uuidString
    defaults.set(id, forKey: key)
    return id
  }

  /// The stored install id, or nil when none has been written (fresh install before the app's
  /// first `ensure`, or a degraded App Group).
  public static func current(_ defaults: UserDefaults) -> String? {
    guard let value = defaults.string(forKey: key), !value.isEmpty else { return nil }
    return value
  }
}
