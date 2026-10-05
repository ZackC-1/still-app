//
//  RatingPromptPresenter.swift
//  Shared (App)
//
//  The Apple rating path's app half (U13-P3). Every decision lives in StillKit's
//  RatingPromptCoordinator and RatingHold; this file only supplies the app facts (an opening, the
//  onboarding gate, the Safari extension's state) and Apple's own review sheet.
//
//  Inert today, by two separate locks:
//    * The owner's remote rating policy is Off, and switches on only after the V3 store release.
//    * No project URL is packaged into the app yet, so the policy client makes no request at all
//      and every allowance is Off. Supplying one is a separate reviewed change.
//  What does run: each ordinary opening of the app records its local calendar day in the App Group
//  invitation ledger (local only, never sent anywhere), so the "three days of use" are known once
//  rating is allowed. Only Still app openings count; the Safari extension never records one.
//
//  An ordinary opening is the launch, then each return after the app left the screen (iPhone and
//  iPad: it entered the background; Mac: it stopped being the active app). A return from a system
//  sheet that never backgrounded the app (an Apple Account prompt) is not an opening.
//
//  The sheet is also held while the app is in the middle of something: RatingHold combines the web
//  UI's reported flow (sign-in, consent, Restore, deletion, errors; "not yet reported" holds), the
//  native flows that can raise system sheets, and the onboarding gate.
//
//  No notifications, no analytics, no identifiers, and nothing records whether anyone rated.
//

import Foundation
import StoreKit
import StillKit

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

@MainActor
final class RatingPromptPresenter {
  private let coordinator: RatingPromptCoordinator?
  private var inFlight = false
  /// The launch is the first opening; later ones need the app to have left the screen first.
  private let openingDue = OpeningDue()
  private var leftToken: NSObjectProtocol?

  init() {
    guard let ledger = RatingPrompt.appGroupLedger(), let revisions = ProductPolicyRevisionStore.appGroup() else {
      coordinator = nil
      return
    }
    #if DEBUG
    let environment = "sandbox"
    #else
    let environment = "production"
    #endif
    let build = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
    let policy = ProductPolicyRuntime(
      supabaseURL: nil, environment: environment, surface: RatingPrompt.appSurface, build: build, store: revisions)
    coordinator = RatingPromptCoordinator(store: ledger, freshCheck: { await policy.freshCheck(.rating) })
    #if os(iOS)
    let left = UIApplication.didEnterBackgroundNotification
    #elseif os(macOS)
    let left = NSApplication.didResignActiveNotification
    #endif
    let due = openingDue
    leftToken = NotificationCenter.default.addObserver(forName: left, object: nil, queue: .main) { _ in
      due.set(true)
    }
  }

  deinit {
    if let leftToken { NotificationCenter.default.removeObserver(leftToken) }
  }

  /// The app became active. Counts as an opening only when one is due. Never blocks the UI: the
  /// ledger work runs off the main actor, which only presents Apple's sheet.
  func appBecameActive(in host: PlatformViewController) {
    guard let coordinator, openingDue.value, !inFlight else { return }
    let defaults = InstallGeneration.appGroupDefaults()
    // The install generation is the ledger's installation id; until the app has published it this
    // launch, nothing is recorded and the opening stays due for the next activation.
    guard let installation = InstallGeneration.current(defaults) else { return }
    openingDue.set(false)
    inFlight = true
    let opening = UUID().uuidString
    let anchor = OriginalInstall.current(defaults).map { Int(($0.firstRecordedAt.timeIntervalSince1970 * 1000).rounded(.down)) }
    let target = WeakHost(host)
    Task { @MainActor in
      let status = await SafariExtensionBridge.currentStatus()
      await Task.detached {
        coordinator.recordOpening(installation: installation, anchorMs: anchor, opening: opening, ordinary: true)
        _ = await coordinator.promptIfAllowed(
          opening: opening,
          // The sync invitation is a popup card only (owner decision 46); linking is dormant while
          // Still Pro is not offered.
          syncApplicable: false, linkApplicable: false,
          suppressed: {
            RatingHold.app.suppression(onboardingShowing: OnboardingGate.shouldShow(OnboardingGate.appGroupDefaults()))
          },
          extensionStatus: status
        ) {
          // Called on the main actor, only after the consumed flag is durable in the App Group.
          if let host = target.host { RatingPromptPresenter.requestReview(in: host) }
        }
      }.value
      self.inFlight = false
    }
  }

  /// Apple's own review sheet. Apple decides whether it appears; either way the attempt is spent.
  static func requestReview(in host: PlatformViewController) {
    #if os(iOS)
    guard let scene = host.view.window?.windowScene else { return }
    if #available(iOS 16.0, *) {
      AppStore.requestReview(in: scene)
    } else {
      SKStoreReviewController.requestReview(in: scene)
    }
    #elseif os(macOS)
    if #available(macOS 13.0, *) {
      AppStore.requestReview(in: host)
    } else {
      SKStoreReviewController.requestReview()
    }
    #endif
  }
}

/// Whether the next activation is an opening. Set from the notification queue, read on main.
private final class OpeningDue: @unchecked Sendable {
  private let lock = NSLock()
  private var due = true
  var value: Bool { lock.lock(); defer { lock.unlock() }; return due }
  func set(_ value: Bool) { lock.lock(); due = value; lock.unlock() }
}

/// Carries the host view controller into the off-main work without retaining it; read on main only.
private final class WeakHost: @unchecked Sendable {
  weak var host: PlatformViewController?
  init(_ host: PlatformViewController) { self.host = host }
}
