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

/// Where the button on onboarding screen 3 actually takes the reader. The two platforms differ, and
/// the difference is the whole reason that screen has four steps rather than one.
///
/// It is a value rather than a comment because the button's label and the steps above it are both
/// written from it. The app target's `SafariExtensionBridge` declares which case it implements and
/// hands that declaration to the view, so a label can no longer promise a destination nothing opens.
public enum EnableLocation: Equatable, Sendable {
  /// Safari's own settings, opened at the Extensions pane with Still already selected. macOS only,
  /// through `SFSafariApplication.showPreferencesForExtension`. The reader arrives where the toggle
  /// is and has nothing to navigate.
  case safariExtensionSettings
  /// The Settings app, opened on Still's own page. This is everything iOS offers a containing app:
  /// `UIApplication.openSettingsURLString` is the only entry point and there is no public deep link
  /// to a Safari extension's toggle. The reader lands one screen away from Safari and has to walk
  /// the rest, which is what the steps are for.
  case settingsAppStillPage
}

/// The guided "enable the extension" steps for onboarding screen 3 — pure copy, extracted from the
/// app target (which `swift test` cannot reach) so the per-OS variants stay deduplicated and the
/// iOS 18 Settings-path fork is provable without a device.
public enum OnboardingCopy {
  /// The label on the button that sits directly under the steps, written from where that button
  /// actually goes. A single cross-platform phrase was tried and had to be withdrawn: any phrase
  /// naming Safari's extension settings is false on iOS, where the button opens Still's own page in
  /// the Settings app, and the steps that quoted it then told the reader to back out of a screen
  /// they had supposedly just been taken to.
  ///
  /// The label lives here, beside the steps, because step 1 names the button the reader is looking
  /// at. `OnboardingTests` pins both halves: that each list's step 1 quotes its own platform's
  /// label, and that the label matches the destination rather than merely matching the step.
  public static func openButtonTitle(for location: EnableLocation) -> String {
    switch location {
    case .safariExtensionSettings: return "Open Safari Settings"
    case .settingsAppStillPage: return "Open Settings"
    }
  }

  /// The iOS enable steps. Only the Settings path changed in iOS 18 (Settings → Apps → Safari);
  /// the other three steps are shared verbatim, so they exist exactly once here. A plain `Bool`
  /// keeps this platform-agnostic: the app target resolves `#available(iOS 18.0, *)` and passes
  /// the verdict in, so the function itself runs (and tests) under macOS `swift test`.
  ///
  /// Step 1 sends the reader back out of Still's page because that is where the button leaves them,
  /// and step 2 is the walk to Safari that the button could not make for them.
  public static func enableSteps(iOS18OrLater: Bool) -> [String] {
    [
      "Tap “\(openButtonTitle(for: .settingsAppStillPage))” below, then tap ‹ Settings",
      iOS18OrLater
        ? "Go to Apps → Safari → Extensions → Still"
        : "Go to Safari → Extensions → Still",
      "Turn on Still, then allow YouTube, Instagram, TikTok, and Facebook",
      "Close Safari, then reopen it",
    ]
  }

  /// The macOS enable steps: one static list, because Safari's extension settings have one path on
  /// macOS. There is no walk to Safari here, because the button already made it.
  public static let macOSEnableSteps: [String] = [
    "Click “\(openButtonTitle(for: .safariExtensionSettings))” below",
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
