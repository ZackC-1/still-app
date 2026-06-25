//
//  OnboardingView.swift
//  Shared (App)
//
//  The 4-screen first-launch onboarding (U18): Welcome → Outcome → Enable the extension → Done,
//  landing on Settings. Copy is the brainstorm draft. This is pure SwiftUI — the platform actions
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
  /// Called when the user finishes — the presenter marks the gate complete and dismisses.
  var onComplete: () -> Void = {}
  /// Starting screen — 0 in production; the presenter overrides it only under a DEBUG launch arg so
  /// each screen can be screenshotted during verification.
  var initialStep = 0

  @State private var step = 0
  @State private var status: SafariExtensionStatus = .unknown

  private static let stillBlue = Color(red: 0.23, green: 0.31, blue: 1.0)
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
    .onAppear { if step != initialStep { step = initialStep } }
  }

  // MARK: Screens

  private var welcome: some View {
    VStack(spacing: 20) {
      glyph("circle.dashed", tint: Self.stillBlue)
      Text("Still")
        .font(.system(size: 56, weight: .bold, design: .rounded))
      Text("The short-form video disappears.\nEverything else stays.")
        .font(.title3)
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
    }
  }

  private var outcome: some View {
    VStack(spacing: 20) {
      glyph("scissors", tint: Self.stillBlue)
      Text("Reels, Shorts, and TikTok — gone.")
        .font(.system(size: 30, weight: .bold, design: .rounded))
        .multilineTextAlignment(.center)
      Text("The sites you use stay exactly as they were.")
        .font(.title3)
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
    }
  }

  private var enableExtension: some View {
    VStack(spacing: 18) {
      glyph("puzzlepiece.extension.fill", tint: status.isConfirmedEnabled ? .green : Self.stillBlue)
      Text("One quick step.")
        .font(.system(size: 28, weight: .bold, design: .rounded))
      Text("Still works through Safari. Turn it on and short-form is gone for good.")
        .font(.body)
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)

      statusBadge

      VStack(alignment: .leading, spacing: 12) {
        ForEach(Array(enableSteps.enumerated()), id: \.offset) { index, line in
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(index + 1)")
              .font(.footnote.weight(.bold))
              .foregroundColor(.white)
              .frame(width: 22, height: 22)
              .background(Circle().fill(Self.stillBlue))
            Text(line).font(.callout)
            Spacer(minLength: 0)
          }
        }
      }
      .padding(16)
      .background(RoundedRectangle(cornerRadius: 14).fill(Color.primary.opacity(0.05)))

      Button(action: openEnableLocation) {
        HStack(spacing: 8) {
          Image(systemName: "arrow.up.forward.app.fill")
          Text(openButtonTitle).fontWeight(.semibold)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 13)
        .background(RoundedRectangle(cornerRadius: 12).stroke(Self.stillBlue, lineWidth: 1.5))
      }
      .buttonStyle(.plain)
      .foregroundColor(Self.stillBlue)

      Text("Still only reads those four sites to hide short-form — nothing else you browse.")
        .font(.caption)
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
      Text("That's it.")
        .font(.system(size: 40, weight: .bold, design: .rounded))
      Text("Short-form is gone.")
        .font(.title3)
        .foregroundColor(.secondary)
    }
  }

  // MARK: Screen-3 status

  private var statusBadge: some View {
    HStack(spacing: 8) {
      Image(systemName: status.isConfirmedEnabled ? "checkmark.circle.fill" : "circle")
        .foregroundColor(status.isConfirmedEnabled ? .green : .secondary)
      Text(status.headline)
        .font(.subheadline.weight(.medium))
        .foregroundColor(status.isConfirmedEnabled ? .green : .secondary)
    }
    .padding(.vertical, 6)
    .padding(.horizontal, 14)
    .background(Capsule().fill(Color.primary.opacity(0.05)))
  }

  /// Platform-specific guided steps for enabling the extension.
  private var enableSteps: [String] {
    #if os(iOS)
    return [
      "Open Settings → Apps → Safari → Extensions",
      "Turn on Still",
      "Allow Still on YouTube, Instagram, TikTok, and Facebook",
      "Close Safari, then reopen it",
    ]
    #else
    return [
      "Click “Open Safari Settings” below",
      "In Extensions, switch on Still",
      "Allow Still on YouTube, Instagram, TikTok, and Facebook",
      "Quit Safari (⌘Q) and reopen it",
    ]
    #endif
  }

  private var openButtonTitle: String {
    #if os(iOS)
    return "Open Settings"
    #else
    return "Open Safari Settings"
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
          .fontWeight(.semibold)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 14)
          .background(RoundedRectangle(cornerRadius: 14).fill(Self.stillBlue))
          .foregroundColor(.white)
      }
      .buttonStyle(.plain)

      if step == 2 {
        Button("Check again") { Task { await refreshStatus() } }
          .buttonStyle(.plain)
          .font(.footnote)
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
}
