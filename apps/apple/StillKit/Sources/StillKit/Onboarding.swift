import Foundation
import Combine

// The testable core of the 4-screen "enable the Safari extension" onboarding (U18). The SwiftUI
// screens and the actual SFSafariExtensionManager probe live in the app target (they need
// UIKit/AppKit + SafariServices); everything here is pure Foundation so `swift test` proves the
// display mapping and the first-launch gate with no device, signing, or Safari.

/// Whether Still's Safari Web Extension is currently enabled — the live state shown on onboarding
/// screen 3 ("Enable the extension"). `SFSafariExtensionManager` reports it on **macOS** and, since
/// iOS 26.2, on the iPhone too. On the earlier iPhone versions this build still supports (back to
/// iOS 15) a containing app cannot read a Safari extension's enabled state, so there the onboarding
/// is instructional and reports `.unknown`. Keeping the enum and its copy here (out of
/// SafariServices) makes the display mapping unit-testable.
public enum SafariExtensionStatus: Equatable, Sendable {
  case enabled
  case disabled
  /// State is not knowable from the app (an iPhone before iOS 26.2), or has not been probed yet.
  case unknown

  /// The headline screen 3 shows for each state (brainstorm copy: "Not on yet" → "You're all set").
  public var headline: String {
    switch self {
    case .enabled: return "You’re all set"
    case .disabled: return "Not on yet"
    case .unknown: return "Turn it on in Safari"
    }
  }

  /// True only when we can affirmatively confirm the extension is on — the one state that lets the
  /// onboarding auto-advance past screen 3 without the user asserting they enabled it themselves.
  public var isConfirmedEnabled: Bool { self == .enabled }
}

/// The live onboarding badge. The view supplies timer/foreground events; one read runs at a time.
@MainActor public final class OnboardingStatusObserver: ObservableObject {
  @Published public private(set) var status: SafariExtensionStatus = .unknown
  private var active = false
  private var generation = 0
  private var reading: Task<Void, Never>?
  /// Callers of `refresh(check:then:)` waiting for the read in flight.
  private var waiting: [(SafariExtensionStatus) -> Void] = []

  public init() {}

  public func setActive(_ next: Bool, check: @escaping () async -> SafariExtensionStatus) {
    guard active != next else { return }
    active = next
    generation += 1
    reading?.cancel()
    reading = nil
    waiting = []
    if active { refresh(check: check) }
  }

  public func refresh(check: @escaping () async -> SafariExtensionStatus) {
    guard active, reading == nil else { return }
    let observed = generation
    reading = Task { [weak self] in
      let next = await check()
      guard let self, self.active, self.generation == observed, !Task.isCancelled else { return }
      if self.status != next { self.status = next }
      self.reading = nil
      let answered = self.waiting
      self.waiting = []
      for answer in answered { answer(next) }
    }
  }

  /// A "Check again" tap that needs the answer: the Safari setup sheet closes when it confirms
  /// Still is on (ISS-0075). Refreshes the badge exactly like `refresh(check:)`, joining a read
  /// already in flight rather than dropping the tap, then hands `then` the status that read stored.
  /// `then` never runs for a read that was abandoned (the screen went inactive), or while inactive.
  public func refresh(
    check: @escaping () async -> SafariExtensionStatus,
    then: @escaping (SafariExtensionStatus) -> Void
  ) {
    guard active else { return }
    waiting.append(then)
    refresh(check: check)
  }
}

/// Where the button on onboarding screen 3 actually takes the reader. The platforms and iOS
/// generations differ, and the difference is the whole reason that screen has a walk-through on
/// some of them and a single tap on the others.
///
/// It is a value rather than a comment because the button's label and the steps above it are both
/// written from it. The app target's `SafariExtensionBridge` declares which case it implements and
/// hands that declaration to the view, so a label can no longer promise a destination nothing opens.
public enum EnableLocation: Equatable, Sendable {
  /// Safari's own settings, opened at the Extensions pane with Still already selected. macOS only,
  /// through `SFSafariApplication.showPreferencesForExtension`. The reader arrives where the toggle
  /// is and has nothing to navigate.
  case safariExtensionSettings
  /// The Settings app, opened on Still's own page, through `UIApplication.openSettingsURLString`.
  /// The only entry point a containing app has on an iPhone before iOS 26.2 (this build reaches back
  /// to iOS 15). The reader lands one screen away from Safari and has to walk the rest, which is
  /// what the steps are for.
  case settingsAppStillPage
  /// The Settings app, opened straight on Still's page under Safari → Extensions (the page with
  /// "Allow Extension", "Allow in Private Browsing" and the website permissions), through
  /// `SFSafariSettings.openExtensionsSettings(forIdentifiers:)`. iOS 26.2 and later (ISS-0074).
  /// The reader arrives where the switch is and has nothing to navigate.
  case settingsAppSafariExtensionPage

  /// The two iPhone destinations. The Settings-app page differs; the button reads the same.
  public var isSettingsApp: Bool { self != .safariExtensionSettings }
}

/// The guided "enable the extension" steps for onboarding screen 3 — pure copy, extracted from the
/// app target (which `swift test` cannot reach) so the per-OS variants stay deduplicated and the
/// iOS forks (the iOS 18 Settings path, the iOS 26.2 direct page) are provable without a device.
public enum OnboardingCopy {
  /// The label on the button that sits directly under the steps, written from where that button
  /// actually goes. A single cross-platform phrase was tried and had to be withdrawn: any phrase
  /// naming Safari's extension settings is false on iOS, where the button opens the Settings app,
  /// and the steps that quoted it then told the reader to back out of a screen they had supposedly
  /// just been taken to. Both iPhone destinations are pages of the Settings app, so both read
  /// "Open Settings"; the steps say what the reader finds there.
  ///
  /// The label lives here, beside the steps, because step 1 names the button the reader is looking
  /// at. `OnboardingTests` pins both halves: that each list's step 1 quotes its own platform's
  /// label, and that the label matches the destination rather than merely matching the step.
  public static func openButtonTitle(for location: EnableLocation) -> String {
    switch location {
    case .safariExtensionSettings: return "Open Safari Settings"
    case .settingsAppStillPage, .settingsAppSafariExtensionPage: return "Open Settings"
    }
  }

  /// The iOS enable steps for where the button lands. A plain `Bool` for the iOS 18 Settings path
  /// keeps this platform-agnostic: the app target resolves `#available` and passes the verdict in,
  /// so the function itself runs (and tests) under macOS `swift test`.
  ///
  /// - `.settingsAppSafariExtensionPage` (iOS 26.2 and later): the button lands on Still's own
  ///   Safari extension page, so there is nothing to navigate; the steps are the switch, the
  ///   websites and the reopen.
  /// - `.settingsAppStillPage` (earlier iOS): the button leaves the reader on Still's app page, one
  ///   screen away, so step 1 sends them back out and step 2 is the walk to Safari. "Go back"
  ///   rather than a quoted back-button label, because iOS 26 shows a bare chevron there while
  ///   earlier versions label it "Settings" (ISS-0074). Only the Settings path changed in iOS 18
  ///   (Settings → Apps → Safari).
  public static func enableSteps(for location: EnableLocation, iOS18OrLater: Bool = true) -> [String] {
    let open = openButtonTitle(for: location)
    switch location {
    case .safariExtensionSettings:
      return macOSEnableSteps
    case .settingsAppSafariExtensionPage:
      return [
        "Tap “\(open)” below.",
        "Turn on Allow Extension, then allow Instagram, Facebook, YouTube and TikTok.",
        "Close Safari, then reopen it.",
      ]
    case .settingsAppStillPage:
      return [
        "Tap “\(open)” below, then go back.",
        iOS18OrLater
          ? "Go to Apps → Safari → Extensions → Still."
          : "Go to Safari → Extensions → Still.",
        "Turn on Still, then allow Instagram, Facebook, YouTube and TikTok.",
        "Close Safari, then reopen it.",
      ]
    }
  }

  /// The macOS enable steps: one static list, because Safari's extension settings have one path on
  /// macOS. There is no walk to Safari here, because the button already made it.
  public static let macOSEnableSteps: [String] = [
    "Click “\(openButtonTitle(for: .safariExtensionSettings))” below.",
    "In Extensions, switch on Still.",
    "Allow Still on Instagram, Facebook, YouTube and TikTok.",
    "Quit Safari (⌘Q) and reopen it.",
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
