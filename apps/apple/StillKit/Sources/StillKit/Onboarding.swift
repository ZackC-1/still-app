import Foundation

// The testable core of the 4-screen "enable the Safari extension" onboarding (U18). The SwiftUI
// screens and the actual SFSafariExtensionManager probe live in the app target (they need
// UIKit/AppKit + SafariServices); everything here is pure Foundation so `swift test` proves the
// display mapping and the first-launch gate with no device, signing, or Safari.

/// Whether Still's Safari Web Extension is currently enabled — the live state shown on onboarding
/// screen 3 ("Enable the extension"). `SFSafariExtensionManager` can report this on **macOS**; iOS
/// has no public API to read a Safari extension's enabled state from the containing app, so the iOS
/// onboarding is instructional and reports `.unknown`. Keeping the enum and its copy here (out of
/// SafariServices) makes the display mapping unit-testable.
public enum SafariExtensionStatus: Equatable, Sendable {
  case enabled
  case disabled
  /// State is not knowable from the app (iOS), or hasn't been probed yet.
  case unknown

  /// The headline screen 3 shows for each state (brainstorm copy: "Not on yet" → "You're all set").
  public var headline: String {
    switch self {
    case .enabled: return "You're all set"
    case .disabled: return "Not on yet"
    case .unknown: return "Turn it on in Safari"
    }
  }

  /// True only when we can affirmatively confirm the extension is on — the one state that lets the
  /// onboarding auto-advance past screen 3 without the user asserting they enabled it themselves.
  public var isConfirmedEnabled: Bool { self == .enabled }
}

/// First-launch gate for the onboarding flow. Persists a "completed" flag in the shared App Group
/// suite (the same container the settings store uses) so onboarding shows exactly once across
/// launches and processes. Pure `UserDefaults` so it's unit-testable with an in-memory suite — no
/// UIKit/SwiftUI.
public enum OnboardingGate {
  /// Versioned so a future onboarding revision can intentionally re-show by bumping the key.
  static let completedKey = "still.onboarding.completed.v1"

  /// The production defaults — the shared App Group suite, falling back to standard defaults if the
  /// App Group isn't provisioned (mirrors `SharedSettingsStore.appGroup()` so the app still launches).
  public static func appGroupDefaults(_ identifier: String = StillAppGroup.identifier) -> UserDefaults {
    UserDefaults(suiteName: identifier) ?? .standard
  }

  /// Show onboarding when it has not yet been marked complete.
  public static func shouldShow(_ defaults: UserDefaults) -> Bool {
    !defaults.bool(forKey: completedKey)
  }

  /// Mark onboarding complete so it won't show again.
  public static func markComplete(_ defaults: UserDefaults) {
    defaults.set(true, forKey: completedKey)
  }

  /// Clear the flag so onboarding runs again (a debug affordance and the test reset hook).
  public static func reset(_ defaults: UserDefaults) {
    defaults.removeObject(forKey: completedKey)
  }
}
