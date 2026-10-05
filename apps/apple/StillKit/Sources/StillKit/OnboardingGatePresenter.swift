import Foundation

/// Who draws the first-launch onboarding in the Apple app. There is exactly one `OnboardingGate`
/// (the App Group "completed" flag) and exactly one presenter reads it: either the legacy SwiftUI
/// flow (`OnboardingPresenter` in the app target) or the V3 D12 screens inside the web view, which
/// ask the gate through the `onboardingState` / `completeOnboarding` bridge messages.
///
/// The choice is a host fact read once per launch from the app's Info.plist key
/// `StillOnboardingPresenter` (see `OnboardingGate.presenter(fromInfoValue:)`). Only the exact
/// string `"web"` selects the web flow; a missing key, any other value, or a different type keeps
/// SwiftUI, so the shipped configuration (no key) is unchanged.
public enum OnboardingPresenterChoice: String, Equatable, Sendable, CaseIterable {
  case swiftUI = "swiftui"
  case web = "web"
}

extension OnboardingGate {
  /// The Info.plist key that selects the presenter. Absent in every shipped Info.plist today.
  public static let presenterInfoKey = "StillOnboardingPresenter"

  /// Parse the Info.plist value. Fails closed to SwiftUI (the shipped behaviour) for anything that
  /// is not exactly `"web"`, so a typo can never leave a launch with both presenters or none.
  public static func presenter(fromInfoValue value: Any?) -> OnboardingPresenterChoice {
    (value as? String) == OnboardingPresenterChoice.web.rawValue ? .web : .swiftUI
  }

  /// The screen the SwiftUI flow should open at, or nil when it must not present. Only the SwiftUI
  /// presenter ever gets a step, so the DEBUG screenshot hook (`debugForcedStep`) cannot put the
  /// native sheet over a web onboarding either.
  public static func nativeInitialStep(
    presenter: OnboardingPresenterChoice, defaults: UserDefaults, debugForcedStep: Int? = nil
  ) -> Int? {
    guard presenter == .swiftUI else { return nil }
    if let debugForcedStep { return debugForcedStep }
    return shouldShow(defaults) ? 0 : nil
  }

  /// Whether the web view should show its onboarding: only when the web flow is the presenter AND
  /// the one gate has not been completed.
  public static func webShouldShow(presenter: OnboardingPresenterChoice, defaults: UserDefaults) -> Bool {
    presenter == .web && shouldShow(defaults)
  }

  /// Mark the gate complete on behalf of the web flow. Refused (false, nothing written) when the
  /// web flow is not the presenter, so a web page can never complete the SwiftUI flow's gate.
  public static func completeFromWeb(presenter: OnboardingPresenterChoice, defaults: UserDefaults) -> Bool {
    guard presenter == .web else { return false }
    markComplete(defaults)
    return true
  }

  /// The `onboardingState` bridge reply. `platform` and `osMajorVersion` are host facts the web
  /// onboarding uses to pick the approved setup steps (iOS 18 moved Safari's settings under Apps),
  /// so the page never has to guess them from its user agent.
  public static func webStateReply(
    presenter: OnboardingPresenterChoice,
    defaults: UserDefaults,
    platform: SafariSetupObservation.Platform,
    osMajorVersion: Int
  ) -> [String: Any] {
    [
      "ok": true,
      "shouldShow": webShouldShow(presenter: presenter, defaults: defaults),
      "platform": platform.rawValue,
      "osMajorVersion": osMajorVersion,
    ]
  }
}
