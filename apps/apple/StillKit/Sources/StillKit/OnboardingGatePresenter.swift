import Foundation

/// Who draws the first-launch onboarding in the Apple app. There is exactly one `OnboardingGate`
/// (the App Group "completed" flag) and exactly one presenter reads it: either the legacy SwiftUI
/// flow (`OnboardingPresenter` in the app target) or the V3 D12 screens inside the web view, which
/// ask the gate through the `onboardingState` / `completeOnboarding` bridge messages.
///
/// The choice is a host fact read once per launch from the app's Info.plist key
/// `StillOnboardingPresenter` (see `OnboardingGate.presenter(fromInfoValue:)`). Only the exact
/// string `"web"` selects the web flow; a missing key, any other value, or a different type keeps
/// SwiftUI, so the shipped configuration (no key) is unchanged. The web flow also needs the bundled
/// web UI to contain the D12 onboarding (`presenter(fromInfoValue:webUIIndexHTML:)`), so a legacy
/// web build under a "web" key falls back to SwiftUI instead of showing no onboarding.
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

extension OnboardingGate {
  /// Present only in a web bundle that contains the D12 onboarding wiring
  /// (packages/app-webview/src/apple-onboarding.ts). Every default build drops that module, so its
  /// bundle never contains this string. A StillKit test pins it to the TypeScript constant.
  public static let webD12Marker = "still-onboarding-presenter:web-d12"

  /// Whether the bundled web UI (`WebUI/index.html`) can present the D12 onboarding.
  public static func webUISupportsD12(indexHTML: String?) -> Bool {
    indexHTML?.contains(webD12Marker) ?? false
  }

  /// The presenter for this launch. The web flow is chosen only when the Info.plist asks for it
  /// AND the bundled web UI reports D12 support; otherwise SwiftUI keeps the gate. This is what
  /// stops an app whose Info.plist says "web" but which bundles a legacy web build (no D12) from
  /// showing no onboarding at all. `indexHTML` is read only when the Info.plist asks for the web
  /// flow, so shipped builds (no key) never read it.
  public static func presenter(
    fromInfoValue value: Any?, webUIIndexHTML indexHTML: () -> String?
  ) -> OnboardingPresenterChoice {
    guard presenter(fromInfoValue: value) == .web else { return .swiftUI }
    return webUISupportsD12(indexHTML: indexHTML()) ? .web : .swiftUI
  }
}
