//
//  OnboardingView.swift
//  Shared (App)
//
//  The 4-screen first-launch onboarding (U18): Welcome → Outcome → Enable the extension → Done,
//  landing on Settings. Nothing here asks for an account: Still blocks without one, and the only
//  thing standing between a first launch and a first block is turning the extension on in Safari.
//  This is pure SwiftUI — the platform actions
//  (probe the live Safari-extension state, open the place the user enables it) are injected as
//  closures by OnboardingPresenter, so this view imports neither SafariServices nor UIKit/AppKit and
//  renders the same on iOS and macOS. Screen 3 reflects the real extension state where the app can
//  read it (macOS, and iOS 26.2 or later) and is instructional on an earlier iPhone.
//

import SwiftUI
import StillKit
import Combine
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct OnboardingView: View {
  /// Probe the live Safari-extension state — real on macOS and iOS 26.2+, `.unknown` earlier on iOS.
  var checkStatus: () async -> SafariExtensionStatus = { .unknown }
  /// Open where the user enables the extension: Safari settings on macOS, the Settings app on iOS
  /// (straight on Still's Safari extension page from iOS 26.2).
  var openEnableLocation: () -> Void = {}
  /// Where the closure above lands, declared by whoever implements it. The button's label and the
  /// steps are both written from this, so neither can describe a screen the button does not open.
  var enableLocation: EnableLocation = .safariExtensionSettings
  /// Called when the user finishes — the presenter marks the gate complete and dismisses.
  var onComplete: () -> Void = {}
  /// Starting screen — 0 in production; the presenter overrides it only under a DEBUG launch arg so
  /// each screen can be screenshotted during verification.
  var initialStep = 0

  @State private var step = 0
  @StateObject private var statusObserver = OnboardingStatusObserver()
  private var status: SafariExtensionStatus { statusObserver.status }

  /// The asset-catalog Still Blue (with its dark variant). Named lookup rather than
  /// `Color.accentColor`, which macOS remaps to the user's system accent preference.
  private static let stillBlue = Color("AccentColor")
  private let lastStep = 3
  /// Polls both directions while screen 3 is active — no "Check again" tap needed. Real on macOS
  /// and iOS 26.2+; a no-op on an earlier iPhone (status stays `.unknown`, no API to read it).
  private let statusPoll = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

  var body: some View {
    VStack(spacing: 0) {
      progressDots
        .padding(.top, 24)

      // Centered while the screen fits, scrolling when it does not. Screen 3 is what makes this
      // necessary: it carries the guided steps, the button that opens Safari's settings, and two
      // reassurance captions, and on a 320pt phone or at the largest text sizes that column is
      // taller than the space available. Without a scroll view the overflow is simply cut off, and
      // the first thing to go is the button that opens the place the user has to visit, on the one
      // screen between installing Still and it working. The footer stays outside the scroll view so
      // the primary button is always on screen.
      GeometryReader { available in
        ScrollView {
          VStack(spacing: 0) {
            Spacer(minLength: 0)

            Group {
              switch step {
              case 0: welcome
              case 1: outcome
              case 2: enableExtension
              default: done
              }
            }
            .frame(maxWidth: 460)
            .padding(.horizontal, 32)

            Spacer(minLength: 0)
          }
          .frame(minWidth: available.size.width, minHeight: available.size.height)
        }
      }

      footer
        .frame(maxWidth: 460)
        .padding(.horizontal, 32)
        .padding(.bottom, 32)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.primary.opacity(0.03).ignoresSafeArea())
    .cappedDynamicType()
    .onAppear { if step != initialStep { step = initialStep } }
  }

  // MARK: Screens

  private var welcome: some View {
    VStack(spacing: 20) {
      brandMark
      Text("Still")
        .font(.still(size: 52, weight: .bold, relativeTo: .largeTitle))
      Text("Do what you came to do. Remove distractions like short-form video from your favorite websites.")
        .font(.still(size: 20, relativeTo: .title3))
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
    }
  }

  private var outcome: some View {
    VStack(spacing: 20) {
      glyph("scissors", tint: Self.stillBlue)
      Text("Distractions are gone.")
        .font(.still(size: 30, weight: .semibold, relativeTo: .title))
        .multilineTextAlignment(.center)
      Text("Keep the best elements of Instagram, Facebook, YouTube, and TikTok. Remove what distracts you.")
        .font(.still(size: 20, relativeTo: .title3))
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
    }
  }

  private var enableExtension: some View {
    VStack(spacing: 18) {
      glyph("puzzlepiece.extension.fill", tint: status.isConfirmedEnabled ? .green : Self.stillBlue)
      Text("Turn on Still in Safari")
        .font(.still(size: 28, weight: .semibold, relativeTo: .title))
      Text("Enable the Still extension to use in Safari.")
        .font(.still(size: 16, relativeTo: .body))
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)

      statusBadge

      VStack(alignment: .leading, spacing: 12) {
        ForEach(Array(enableSteps.enumerated()), id: \.offset) { index, line in
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(index + 1)")
              .font(.still(size: 13, weight: .bold, relativeTo: .footnote))
              .foregroundColor(.white)
              .frame(width: 22, height: 22)
              .background(Circle().fill(Self.stillBlue))
            Text(line)
              .font(.still(size: 15, relativeTo: .callout))
              .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
          }
        }
      }
      .padding(16)
      .background(RoundedRectangle(cornerRadius: 14).fill(Color.primary.opacity(0.05)))

      Button(action: openEnableLocation) {
        HStack(spacing: 8) {
          Image(systemName: "arrow.up.forward.app.fill")
          Text(OnboardingCopy.openButtonTitle(for: enableLocation))
            .font(.still(size: 16, weight: .semibold, relativeTo: .body))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 13)
        .background(RoundedRectangle(cornerRadius: 12).stroke(Self.stillBlue, lineWidth: 1.5))
      }
      .buttonStyle(.plain)
      .foregroundColor(Self.stillBlue)

      // The one reassurance worth spending space on here, because it is what someone is quietly
      // wondering while an app asks them to turn something on in their browser.
      Text("No account or purchase is needed. Still does not collect your browsing history.")
        .font(.still(size: 12, relativeTo: .caption))
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    // .onAppear + Task rather than .task (which is macOS 12+; the app targets macOS 11 / iOS 15).
    .onAppear { statusObserver.setActive(appIsActive, check: checkStatus) }
    .onDisappear { statusObserver.setActive(false, check: checkStatus) }
    .onReceive(NotificationCenter.default.publisher(for: Self.didBecomeActive)) { _ in
      statusObserver.setActive(true, check: checkStatus)
    }
    .onReceive(NotificationCenter.default.publisher(for: Self.willResignActive)) { _ in
      statusObserver.setActive(false, check: checkStatus)
    }
    .onReceive(statusPoll) { _ in statusObserver.refresh(check: checkStatus) }
  }

  private var done: some View {
    VStack(spacing: 20) {
      glyph("checkmark.seal.fill", tint: .green)
      Text("Still is ready.")
        .font(.still(size: 40, weight: .semibold, relativeTo: .largeTitle))
      Text(completionSubtitle)
        .font(.still(size: 20, relativeTo: .title3))
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
      Text(returnToSafariTip)
        .font(.still(size: 15, relativeTo: .body))
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var completionSubtitle: String {
    #if os(macOS)
    return "Distractions are removed from enabled websites in Safari"
    #else
    return "Short-form video is removed from enabled websites in Safari."
    #endif
  }

  /// Platform-specific reminder of where Still lives once the user returns to Safari.
  private var returnToSafariTip: String {
    #if os(iOS)
    return "Back in Safari, use the Page Menu to reach Still."
    #else
    return "Back in Safari, click Still’s toolbar button."
    #endif
  }

  // This view is presented by NS/UIHostingController, so observe the native app lifecycle.
  private var appIsActive: Bool {
    #if os(macOS)
    return NSApplication.shared.isActive
    #else
    return UIApplication.shared.applicationState == .active
    #endif
  }
  private static var didBecomeActive: Notification.Name {
    #if os(macOS)
    return NSApplication.didBecomeActiveNotification
    #else
    return UIApplication.didBecomeActiveNotification
    #endif
  }
  private static var willResignActive: Notification.Name {
    #if os(macOS)
    return NSApplication.willResignActiveNotification
    #else
    return UIApplication.willResignActiveNotification
    #endif
  }

  // MARK: Screen-3 status

  private var statusBadge: some View {
    HStack(spacing: 8) {
      Image(systemName: status.isConfirmedEnabled ? "checkmark.circle.fill" : "circle")
        .foregroundColor(status.isConfirmedEnabled ? .green : .secondary)
      Text(status.headline)
        .font(.still(size: 15, weight: .medium, relativeTo: .subheadline))
        .foregroundColor(status.isConfirmedEnabled ? .green : .secondary)
    }
    .padding(.vertical, 6)
    .padding(.horizontal, 14)
    .background(Capsule().fill(Color.primary.opacity(0.05)))
  }

  /// Guided steps for enabling the extension, written for where the button below them lands. The
  /// copy lives in StillKit (`OnboardingCopy`), where `swift test` proves the per-destination
  /// variants, that step 1 still names the button below it, and that the name matches where that
  /// button goes; this only resolves the OS generation for the walk-through.
  private var enableSteps: [String] {
    #if os(iOS)
    if #available(iOS 18.0, *) {
      return OnboardingCopy.enableSteps(for: enableLocation, iOS18OrLater: true)
    }
    return OnboardingCopy.enableSteps(for: enableLocation, iOS18OrLater: false)
    #else
    return OnboardingCopy.enableSteps(for: enableLocation)
    #endif
  }

  // MARK: Footer

  private var footer: some View {
    VStack(spacing: 12) {
      // "Check again" sits above the primary button so that button lands where "Continue" and
      // "Get started" do on the other screens (owner, 19 Oct).
      if step == 2 {
        Button("Check again") { statusObserver.refresh(check: checkStatus) }
          .buttonStyle(.plain)
          .font(.still(size: 13, relativeTo: .footnote))
          .foregroundColor(.secondary)
      }

      Button(action: advance) {
        Text(primaryTitle)
          .font(.still(size: 16, weight: .semibold, relativeTo: .body))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 14)
          .background(RoundedRectangle(cornerRadius: 14).fill(Self.stillBlue))
          .foregroundColor(.white)
      }
      .buttonStyle(.plain)
    }
  }

  /// On screen 3 the primary button doubles as the user's self-assertion that they enabled the
  /// extension — except on macOS once we can confirm it's on, where it just reads "Continue".
  private var primaryTitle: String {
    switch step {
    case 0, 1: return "Continue"
    case 2: return status.isConfirmedEnabled ? "Continue" : "I've turned it on"
    default: return "Get started"
    }
  }

  private func advance() {
    if step >= lastStep {
      onComplete()
    } else {
      withAnimation(.easeInOut(duration: 0.2)) { step += 1 }
    }
  }

  // MARK: Bits

  private var progressDots: some View {
    HStack(spacing: 8) {
      ForEach(0...lastStep, id: \.self) { i in
        Capsule()
          .fill(i == step ? Self.stillBlue : Color.primary.opacity(0.15))
          .frame(width: i == step ? 22 : 8, height: 8)
      }
    }
  }

  private func glyph(_ name: String, tint: Color) -> some View {
    Image(systemName: name)
      .font(.system(size: 56))
      .foregroundColor(tint)
      .padding(.bottom, 4)
  }

  private var brandMark: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(Self.stillBlue)
        .frame(width: 76, height: 76)
      Capsule()
        .fill(Color.white)
        .frame(width: 48, height: 3)
        .offset(y: 12)
      Circle()
        .fill(Color.white)
        .frame(width: 12, height: 12)
        .offset(y: 6)
    }
    .accessibilityHidden(true)
    .padding(.bottom, 4)
  }
}

private extension Font {
  static func still(
    size: CGFloat,
    weight: Font.Weight = .regular,
    relativeTo style: Font.TextStyle
  ) -> Font {
    if #available(iOS 16.0, macOS 13.0, *) {
      return .custom("InterVariable", size: size, relativeTo: style).weight(weight)
    } else {
      // `.weight(_:)` is a no-op on a custom Font before iOS 16 / macOS 13 — everything would
      // render Regular. Keep the system face there so the weight hierarchy survives.
      return .system(size: size, weight: weight, design: .default)
    }
  }
}

private extension View {
  /// Caps Dynamic Type at the first accessibility size. The screens themselves now scroll, so the
  /// cap is no longer what keeps them reachable; the footer is. The footer sits outside the scroll
  /// view so the primary button is always on screen, and at the very largest sizes that button
  /// alone fills more than half of a 375pt phone, leaving the screen above it a narrow band.
  /// Screenshotted at the largest size on 2026-09-08 and judged worse than the cap. Lifting it
  /// properly means letting the footer scroll with everything else, which is a layout decision
  /// rather than a sizing one. (macOS 11 predates the API, and has no Dynamic Type to cap.)
  @ViewBuilder func cappedDynamicType() -> some View {
    if #available(iOS 15.0, macOS 12.0, *) {
      dynamicTypeSize(...DynamicTypeSize.accessibility1)
    } else {
      self
    }
  }
}
