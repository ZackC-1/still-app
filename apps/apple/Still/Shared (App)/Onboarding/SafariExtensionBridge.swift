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
}
