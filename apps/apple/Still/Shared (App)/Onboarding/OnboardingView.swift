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
//  renders the same on iOS and macOS. Screen 3 reflects the real extension state on macOS (live) and
//  is instructional on iOS, where the app cannot read a Safari extension's enabled state.
//

import SwiftUI
import StillKit
import Combine

struct OnboardingView: View {
  /// Probe the live Safari-extension state — real on macOS, `.unknown` on iOS.
  var checkStatus: () async -> SafariExtensionStatus = { .unknown }
  /// Open where the user enables the extension: Safari settings on macOS, the Settings app on iOS.
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
  @State private var status: SafariExtensionStatus = .unknown

  /// The asset-catalog Still Blue (with its dark variant). Named lookup rather than
  /// `Color.accentColor`, which macOS remaps to the user's system accent preference.
  private static let stillBlue = Color("AccentColor")
  private let lastStep = 3
  /// Polls the live extension state while screen 3 is on-screen, so the badge flips to "You're all
  /// set" on its own the moment the user enables Still — no "Check again" tap needed. Real on macOS;
  /// a no-op on iOS (status stays `.unknown`, no API to read it).
  private let statusPoll = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

  var body: some View {
    VStack(spacing: 0) {
      progressDots
        .padding(.top, 24)

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
      Text("The short-form video disappears.\nEverything else stays.")
        .font(.still(size: 20, relativeTo: .title3))
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
    }
  }

  private var outcome: some View {
    VStack(spacing: 20) {
      glyph("scissors", tint: Self.stillBlue)
      Text("Short-form video is gone")
        .font(.still(size: 30, weight: .semibold, relativeTo: .title))
        .multilineTextAlignment(.center)
      Text("Keep normal videos, posts, messages, and everything else you came to see.")
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
      Text("Enable the Still extension in Safari, then choose the websites where you want short-form video removed.")
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
            Text(line).font(.still(size: 15, relativeTo: .callout))
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
      Text("Still only reads those four sites to hide short-form video, nothing else you browse.")
        .font(.still(size: 12, relativeTo: .caption))
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    // .onAppear + Task rather than .task (which is macOS 12+; the app targets macOS 11 / iOS 15).
    .onAppear { Task { await refreshStatus() } }
    .onReceive(statusPoll) { _ in
      // Live-confirm: flip to "You're all set" on its own once enabled. Stop probing once confirmed.
      if !status.isConfirmedEnabled { Task { await refreshStatus() } }
    }
  }

  private var done: some View {
    VStack(spacing: 20) {
      glyph("checkmark.seal.fill", tint: .green)
      Text("Still is ready.")
        .font(.still(size: 40, weight: .semibold, relativeTo: .largeTitle))
      Text("Short-form video is removed from enabled websites in Safari.")
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

  /// Platform-specific reminder of where Still lives once the user returns to Safari.
  private var returnToSafariTip: String {
    #if os(iOS)
    return "Back in Safari, use the Page Menu to reach Still."
    #else
    return "Back in Safari, click Still’s toolbar button."
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

  /// Platform-specific guided steps for enabling the extension. The copy lives in StillKit
  /// (`OnboardingCopy`), where `swift test` proves the per-OS variants, that step 1 still names the
  /// button below it, and that the name matches where that button goes; this only resolves the OS.
  private var enableSteps: [String] {
    #if os(iOS)
    if #available(iOS 18.0, *) {
      return OnboardingCopy.enableSteps(iOS18OrLater: true)
    }
    return OnboardingCopy.enableSteps(iOS18OrLater: false)
    #else
    return OnboardingCopy.macOSEnableSteps
    #endif
  }

  @MainActor private func refreshStatus() async {
    status = await checkStatus()
  }

  // MARK: Footer

  private var footer: some View {
    VStack(spacing: 12) {
      Button(action: advance) {
        Text(primaryTitle)
          .font(.still(size: 16, weight: .semibold, relativeTo: .body))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 14)
          .background(RoundedRectangle(cornerRadius: 14).fill(Self.stillBlue))
          .foregroundColor(.white)
      }
      .buttonStyle(.plain)

      if step == 2 {
        Button("Check again") { Task { await refreshStatus() } }
          .buttonStyle(.plain)
          .font(.still(size: 13, relativeTo: .footnote))
          .foregroundColor(.secondary)
      }
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
  /// Caps Dynamic Type at the first accessibility size: the onboarding column is a fixed,
  /// Spacer-centered VStack with no scrolling, and the ~3.1× accessibility scales would push the
  /// Continue button off-screen. (macOS 11 predates the API — and has no Dynamic Type to cap.)
  @ViewBuilder func cappedDynamicType() -> some View {
    if #available(iOS 15.0, macOS 12.0, *) {
      dynamicTypeSize(...DynamicTypeSize.accessibility1)
    } else {
      self
    }
  }
}
