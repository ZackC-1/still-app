//
//  RatingPromptPresenter.swift
//  Shared (App)
//
//  The Apple rating path's app half (U13-P3). Every decision lives in StillKit's
//  RatingPromptCoordinator; this file only supplies the app facts (an opening, setup, the Safari
//  extension's state) and Apple's own review sheet.
//
//  Inert today, by two separate locks:
//    * The owner's remote rating policy is Off, and switches on only after the V3 store release.
//    * No project URL is packaged into the app yet, so the policy client makes no request at all
//      and every allowance is Off. Supplying one is a separate reviewed change.
//  What does run: each time the app becomes active, the opening's local calendar day is recorded in
//  the App Group invitation ledger (local only, never sent anywhere), so the "three days of use"
//  are known once rating is allowed. Only Still app openings count; the Safari extension never
//  records one.
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
  }

  /// One ordinary opening of the Still app (it became active). Never throws, never blocks the UI.
  func appBecameActive(in host: PlatformViewController) {
    guard let coordinator, !inFlight else { return }
    inFlight = true
    let defaults = InstallGeneration.appGroupDefaults()
    let opening = UUID().uuidString
    // The install generation is the ledger's installation id; until the app has published it this
    // launch, nothing is recorded (a later activation will be).
    guard let installation = InstallGeneration.current(defaults) else { inFlight = false; return }
    let anchor = OriginalInstall.current(defaults).map { Int(($0.firstRecordedAt.timeIntervalSince1970 * 1000).rounded(.down)) }
    let setupShowing = OnboardingGate.shouldShow(OnboardingGate.appGroupDefaults())
    Task { @MainActor [weak self, weak host] in
      defer { self?.inFlight = false }
      coordinator.recordOpening(installation: installation, anchorMs: anchor, opening: opening, ordinary: true)
      let status = await SafariExtensionBridge.currentStatus()
      _ = await coordinator.promptIfAllowed(
        opening: opening,
        // The sync invitation is a popup card only (owner decision 46); linking is dormant while
        // Still Pro is not offered.
        syncApplicable: false, linkApplicable: false,
        suppressed: setupShowing ? .setup : nil,
        extensionStatus: status
      ) {
        // Called only after the consumed flag is durable in the App Group.
        if let host { RatingPromptPresenter.requestReview(in: host) }
      }
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
