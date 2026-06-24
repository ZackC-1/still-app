//
//  OnboardingPresenter.swift
//  Shared (App)
//
//  Presents the first-launch onboarding (U18) over the Settings WKWebView, exactly once, gated by
//  StillKit.OnboardingGate against the App Group. Wires the pure OnboardingView to the platform
//  SafariExtensionBridge and dismisses on completion — landing the user on Settings. The host is the
//  shared ViewController, which calls presentIfNeeded(from:) from viewDidAppear.
//

import SwiftUI
import StillKit

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

enum OnboardingPresenter {
  @MainActor
  static func presentIfNeeded(from host: PlatformViewController) {
    let defaults = OnboardingGate.appGroupDefaults()

    // DEBUG verification hook: STILL_ONBOARDING_STEP=<0-3> forces the flow to present at a given
    // screen (bypassing the gate) so each screen can be screenshotted. Never set in a Release build.
    var initialStep = 0
    #if DEBUG
    if let raw = ProcessInfo.processInfo.environment["STILL_ONBOARDING_STEP"], let step = Int(raw) {
      initialStep = step
      present(from: host, defaults: defaults, initialStep: initialStep)
      return
    }
    #endif

    guard OnboardingGate.shouldShow(defaults) else { return }
    present(from: host, defaults: defaults, initialStep: initialStep)
  }

  @MainActor
  private static func present(from host: PlatformViewController, defaults: UserDefaults, initialStep: Int) {
    // Don't stack a second copy if viewDidAppear fires again before the flow finishes.
    #if os(iOS)
    guard host.presentedViewController == nil else { return }
    #elseif os(macOS)
    guard host.presentedViewControllers?.isEmpty ?? true else { return }
    #endif

    let view = OnboardingView(
      checkStatus: { await SafariExtensionBridge.currentStatus() },
      openEnableLocation: { SafariExtensionBridge.openEnableLocation() },
      onComplete: { [weak host] in
        OnboardingGate.markComplete(defaults)
        Self.dismiss(host)
      },
      initialStep: initialStep
    )

    #if os(iOS)
    let controller = UIHostingController(rootView: view)
    controller.modalPresentationStyle = .fullScreen
    controller.isModalInPresentation = true // must finish the flow — no swipe-to-dismiss
    host.present(controller, animated: true)
    #elseif os(macOS)
    let controller = NSHostingController(rootView: view)
    controller.preferredContentSize = NSSize(width: 520, height: 660)
    host.presentAsSheet(controller)
    #endif
  }

  @MainActor
  private static func dismiss(_ host: PlatformViewController?) {
    guard let host else { return }
    #if os(iOS)
    host.dismiss(animated: true)
    #elseif os(macOS)
    if let sheet = host.presentedViewControllers?.first {
      host.dismiss(sheet)
    }
    #endif
  }
}
