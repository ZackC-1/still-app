//
//  SafariExtensionBridge.swift
//  Shared (App)
//
//  Bridges the pure SwiftUI OnboardingView (U18) to the platform's Safari-extension APIs. On macOS,
//  SFSafariExtensionManager reports the live enabled state and SFSafariApplication opens the prefs
//  pane, so screen 3 reflects reality. On iOS 26.2 and later the iPhone has the same two things:
//  SFSafariExtensionManager reports the state and SFSafariSettings.openExtensionsSettings opens
//  Settings straight on Still's Safari extension page (ISS-0074). On the earlier iPhone versions
//  this build supports, back to iOS 15, a containing app has neither, so it reports `.unknown` and
//  opens the app's own Settings page as the closest guided entry point; the onboarding steps walk
//  the rest of the way.
//
//  The availability fork lives in `enableLocation` below; the label and the steps on screen 3 are
//  written from that value, so they can never describe a page this file does not open.
//

import Foundation
import StillKit
import SafariServices

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
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

  /// The live extension state. Real on macOS and on iOS 26.2 and later; `.unknown` on an earlier
  /// iPhone, where reading it is not available to a containing app.
  static func currentStatus() async -> SafariExtensionStatus {
    #if DEBUG
    // Simulator/Mac QA lane only (QA/QAHooks.swift); inert unless STILL_QA_SAFARI is set.
    if let qa = QAHooks.safariStatusOverride { return qa }
    #endif
    #if os(macOS)
    return await withCheckedContinuation { (continuation: CheckedContinuation<SafariExtensionStatus, Never>) in
      SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleID) { state, error in
        guard let state, error == nil else {
          continuation.resume(returning: .unknown)
          return
        }
        continuation.resume(returning: state.isEnabled ? .enabled : .disabled)
      }
    }
    #else
    if #available(iOS 26.2, *) {
      // A failed read (no such extension, a refused query) is not knowable state, never "off".
      // The read is bounded: the rating prompt and the analytics context await this status, and a
      // reply that never comes (observed on the iOS 26.2 simulator) must not hold them forever.
      return await withTaskGroup(of: SafariExtensionStatus.self) { group in
        group.addTask {
          do {
            let state = try await SFSafariExtensionManager.stateOfExtension(withIdentifier: extensionBundleID)
            #if DEBUG
            print("still qa: stateOfExtension answered enabled=\(state.isEnabled)")
            #endif
            return state.isEnabled ? .enabled : .disabled
          } catch {
            #if DEBUG
            // Simulator QA lane only: the refusal, for the lane's console capture.
            print("still qa: stateOfExtension refused: \(error)")
            #endif
            return .unknown
          }
        }
        group.addTask {
          try? await Task.sleep(nanoseconds: 2_000_000_000)
          #if DEBUG
          if !Task.isCancelled { print("still qa: stateOfExtension timed out") }
          #endif
          return .unknown
        }
        let first = await group.next() ?? .unknown
        group.cancelAll()
        return first
      }
    }
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
    if #available(iOS 26.2, *) { return .settingsAppSafariExtensionPage }
    return .settingsAppStillPage
    #endif
  }

  /// Open where the user enables Still: the Safari extensions prefs pane on macOS; on iOS 26.2 and
  /// later, Settings straight on Still's Safari extension page (the switch, Private Browsing and the
  /// website permissions); on an earlier iPhone, Still's own page in Settings, from where the
  /// onboarding steps walk the rest of the way. If the direct open is refused (the system asks for
  /// a foreground app and allows about two a minute), the app's own page is the fallback.
  @MainActor static func openEnableLocation() {
    #if os(macOS)
    SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleID) { _ in }
    #elseif os(iOS)
    if #available(iOS 26.2, *) {
      Task { _ = await openSafariExtensionPage() }
      return
    }
    Task { await openAppSettingsPage() }
    #endif
  }

  #if os(iOS)
  /// Still's own page in the Settings app (`UIApplication.openSettingsURLString`).
  @MainActor @discardableResult private static func openAppSettingsPage() async -> Bool {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return false }
    // The async form: UIKit resumes this main-actor caller itself, so no handler closure exists.
    return await UIApplication.shared.open(url, options: [:])
  }

  /// Settings straight on Still's Safari extension page (ISS-0074), for both the SwiftUI onboarding
  /// and the web view's setup card. True only when that page opened. Apple rate-limits this call to
  /// about two a minute and refuses it for a background app; a refusal opens Still's app page
  /// instead and returns false, so a reply never names a page that did not open.
  @available(iOS 26.2, *)
  @MainActor private static func openSafariExtensionPage() async -> Bool {
    let opened = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      SFSafariSettings.openExtensionsSettings(forIdentifiers: [extensionBundleID]) {
        @Sendable error in
        #if DEBUG
        // Simulator QA lane only: the refusal, for the lane's console capture.
        if let error { print("still qa: openExtensionsSettings refused: \(error)") }
        #endif
        continuation.resume(returning: error == nil)
      }
    }
    if !opened { await openAppSettingsPage() }
    return opened
  }
  #endif

  /// Open one fixed destination for the web view's `openDestination` message, after
  /// `NativeOpenRequest.authorize` accepted it. The enable locations use the same calls as
  /// `openEnableLocation()` above; `safari` launches Safari by its bundle id. Returns whether the
  /// system accepted the open.
  ///
  /// The system completion handlers run on background queues. This target defaults to main-actor
  /// isolation, so each handler is an explicitly `@Sendable` (nonisolated) closure that only
  /// resumes a continuation; the caller's `await` is what returns to the main actor. A handler that
  /// inherited main-actor isolation would fail Swift 6's runtime isolation check.
  @MainActor static func open(_ destination: NativeOpenDestination) async -> Bool {
    #if os(macOS)
    switch destination {
    case .safariExtensionSettings:
      return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleID) {
          @Sendable error in
          continuation.resume(returning: error == nil)
        }
      }
    case .safari:
      guard let safari = NSWorkspace.shared.urlForApplication(
        withBundleIdentifier: NativeOpenDestination.safariBundleIdentifier)
      else { return false }
      return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
        NSWorkspace.shared.openApplication(
          at: safari, configuration: NSWorkspace.OpenConfiguration()
        ) { @Sendable _, error in
          continuation.resume(returning: error == nil)
        }
      }
    case .settingsAppStillPage, .settingsAppSafariExtensionPage:
      return false
    }
    #elseif os(iOS)
    switch destination {
    case .settingsAppStillPage:
      return await openAppSettingsPage()
    case .settingsAppSafariExtensionPage:
      guard #available(iOS 26.2, *) else { return false }
      return await openSafariExtensionPage()
    case .safariExtensionSettings, .safari:
      return false
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
