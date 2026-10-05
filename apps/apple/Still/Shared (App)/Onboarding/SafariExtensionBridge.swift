//
//  SafariExtensionBridge.swift
//  Shared (App)
//
//  Bridges the pure SwiftUI OnboardingView (U18) to the platform's Safari-extension APIs. On macOS,
//  SFSafariExtensionManager reports the live enabled state and SFSafariApplication opens the prefs
//  pane, so screen 3 reflects reality. Across the iPhone versions this build supports, back to
//  iOS 15, a containing app has neither of those, so it reports `.unknown` and opens the app's own
//  Settings page as the closest guided entry point.
//
//  Both arrived on iOS in 26.2, as SFSafariSettings.openExtensionsSettings(forIdentifiers:) and
//  SFSafariExtensionManager. Using them means an availability fork and a device pass on the one
//  screen between installing Still and it working, so what ships here is the path that works for
//  every version the app targets.
//

import Foundation
import StillKit

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
import SafariServices
#endif

enum SafariExtensionBridge {
  /// Must match the Safari extension target's bundle id (com.chartash.still + .Extension).
  static let extensionBundleID = "com.chartash.still.Extension"

  /// Pure observation only; the existing enable action and onboarding gate are unchanged.
  static func observeSetup() async -> SafariSetupObservation {
    #if os(macOS)
      let platform = SafariSetupObservation.Platform.macos
    #else
      let platform = SafariSetupObservation.Platform.ios
    #endif
    return SafariSetupObservation(
      platform: platform, extensionStatus: await currentStatus(), enableLocation: enableLocation)
  }

  /// The live extension state. Real on macOS; always `.unknown` on the iPhone versions this build
  /// targets, where reading it is not available to a containing app.
  static func currentStatus() async -> SafariExtensionStatus {
    #if os(macOS)
    await withCheckedContinuation { (continuation: CheckedContinuation<SafariExtensionStatus, Never>) in
      SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleID) { state, error in
        guard let state, error == nil else {
          continuation.resume(returning: .unknown)
          return
        }
        continuation.resume(returning: state.isEnabled ? .enabled : .disabled)
      }
    }
    #else
    return .unknown
    #endif
  }

  /// Where `openEnableLocation()` below actually lands on this platform. Onboarding's button label
  /// and its steps are both written from this value, so the screen cannot describe a destination
  /// this file does not open. Changing the call below without changing this is the mistake it
  /// exists to prevent.
  static var enableLocation: EnableLocation {
    #if os(macOS)
    return .safariExtensionSettings
    #else
    return .settingsAppStillPage
    #endif
  }

  /// Open where the user enables Still: the Safari extensions prefs pane on macOS, the Settings app
  /// on iOS. No iPhone version this build supports lets a containing app open a Safari extension's
  /// toggle directly, so this lands on Still's own page in Settings and the onboarding steps walk
  /// the rest of the way.
  @MainActor static func openEnableLocation() {
    #if os(macOS)
    SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleID) { _ in }
    #elseif os(iOS)
    if let url = URL(string: UIApplication.openSettingsURLString) {
      UIApplication.shared.open(url)
    }
    #endif
  }

  /// Open one fixed destination for the web view's `openDestination` message, after
  /// `NativeOpenRequest.authorize` accepted it. The enable locations use the same calls as
  /// `openEnableLocation()` above; `safari` launches Safari by its bundle id. `completion` reports
  /// whether the system accepted the open and is always called once, on the main actor.
  @MainActor static func open(
    _ destination: NativeOpenDestination, completion: @escaping @MainActor (Bool) -> Void
  ) {
    let finish: (Bool) -> Void = { ok in Task { @MainActor in completion(ok) } }
    #if os(macOS)
    switch destination {
    case .safariExtensionSettings:
      SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleID) { error in
        finish(error == nil)
      }
    case .safari:
      guard let safari = NSWorkspace.shared.urlForApplication(
        withBundleIdentifier: NativeOpenDestination.safariBundleIdentifier)
      else { return finish(false) }
      NSWorkspace.shared.openApplication(
        at: safari, configuration: NSWorkspace.OpenConfiguration()
      ) { _, error in finish(error == nil) }
    case .settingsAppStillPage:
      finish(false)
    }
    #elseif os(iOS)
    switch destination {
    case .settingsAppStillPage:
      guard let url = URL(string: UIApplication.openSettingsURLString) else { return finish(false) }
      UIApplication.shared.open(url, options: [:]) { ok in finish(ok) }
    case .safariExtensionSettings, .safari:
      finish(false)
    }
    #endif
  }

  /// Whether the app is the active app right now (a tap in it is possible).
  @MainActor static var appIsActive: Bool {
    #if os(macOS)
    return NSApplication.shared.isActive
    #else
    return UIApplication.shared.applicationState == .active
    #endif
  }
}
