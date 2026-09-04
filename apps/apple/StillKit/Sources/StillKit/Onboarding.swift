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

/// The guided "enable the extension" steps for onboarding screen 3 — pure copy, extracted from the
/// app target (which `swift test` cannot reach) so the per-OS variants stay deduplicated and the
/// iOS 18 Settings-path fork is provable without a device.
public enum OnboardingCopy {
  /// The label on the button that sits directly under the steps below. Both platforms land on the
  /// place where a Safari extension is turned on: the Settings app on iOS, Safari's own settings on
  /// macOS. One phrase describes both destinations honestly.
  ///
  /// It lives here, next to the steps, because step 1 names the button the reader is looking at.
  /// Holding both in one place is what stops the sentence and the control drifting apart, which is
  /// exactly what happened when the button was renamed and the steps were not. `OnboardingTests`
  /// asserts that step 1 of each list still contains this string.
  public static let openButtonTitle = "Open Safari extension settings"

  /// The iOS enable steps. Only the Settings path changed in iOS 18 (Settings → Apps → Safari);
  /// the other three steps are shared verbatim, so they exist exactly once here. A plain `Bool`
  /// keeps this platform-agnostic: the app target resolves `#available(iOS 18.0, *)` and passes
  /// the verdict in, so the function itself runs (and tests) under macOS `swift test`.
  public static func enableSteps(iOS18OrLater: Bool) -> [String] {
    [
      "Tap “\(openButtonTitle)” below, then tap ‹ Settings",
      iOS18OrLater
        ? "Go to Apps → Safari → Extensions → Still"
        : "Go to Safari → Extensions → Still",
      "Turn on Still, then allow YouTube, Instagram, TikTok, and Facebook",
      "Close Safari, then reopen it",
    ]
  }

  /// The macOS enable steps: one static list, because Safari's extension settings have one path
  /// on macOS.
  public static let macOSEnableSteps: [String] = [
    "Click “\(openButtonTitle)” below",
    "In Extensions, switch on Still",
    "Allow Still on YouTube, Instagram, TikTok, and Facebook",
    "Quit Safari (⌘Q) and reopen it",
  ]
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
