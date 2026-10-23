import XCTest
@testable import StillKit

/// The native onboarding screens and the Safari setup sheet against the owner's screens canvas
/// (canvas fidelity check, 22 Oct 2026). The numbers below are the canvas's; OnboardingView reads
/// every size from OnboardingLayout, which the last test checks in the view's source.
final class OnboardingLayoutTests: XCTestCase {
  func testThePhoneFrameMatchesTheCanvas() {
    // 16pt sides like the rest of the iPhone app; dots 24pt under the status bar (86pt from the top
    // of a 390x844 board); the main button's bottom 56pt from the screen's bottom edge.
    XCTAssertEqual(OnboardingLayout.phone.sideInset, 16)
    XCTAssertEqual(OnboardingLayout.phone.topInset, 24)
    XCTAssertEqual(OnboardingLayout.phone.bottomInset, 22)
    XCTAssertEqual(OnboardingLayout.phone.closeTop, 16)
    XCTAssertEqual(OnboardingLayout.phone.closeMinHeight, 44)
    XCTAssertEqual(OnboardingLayout.phone.closeTrailing, 24)
    XCTAssertEqual(OnboardingLayout.phone.closeBottom, 24)
  }

  func testTheMacFrameMatchesTheCanvas() {
    XCTAssertEqual(OnboardingLayout.mac.sideInset, 32)
    XCTAssertEqual(OnboardingLayout.mac.topInset, 40)
    XCTAssertEqual(OnboardingLayout.mac.bottomInset, 32)
    XCTAssertEqual(OnboardingLayout.mac.closeTop, 12)
    XCTAssertEqual(OnboardingLayout.mac.closeMinHeight, 32)
    XCTAssertEqual(OnboardingLayout.mac.closeTrailing, 36)
    XCTAssertEqual(OnboardingLayout.mac.closeBottom, 0)
    XCTAssertEqual(OnboardingLayout.macSheetHeight, 760)
  }

  func testDotsAndTheMainButtonMatchTheCanvas() {
    XCTAssertEqual(OnboardingLayout.dotSpacing, 12)
    XCTAssertEqual(OnboardingLayout.dotSize, 8)
    XCTAssertEqual(OnboardingLayout.activeDotWidth, 22)
    XCTAssertEqual(OnboardingLayout.primaryMinHeight, 52)
    XCTAssertEqual(OnboardingLayout.primaryRadius, 14)
    XCTAssertEqual(OnboardingLayout.footerSpacing, 16)
    XCTAssertEqual(OnboardingLayout.sheetCheckAgainMinHeight, 44)
  }

  func testTextSizesMatchTheCanvas() {
    XCTAssertEqual(OnboardingLayout.headingTracking, -0.02)
    XCTAssertEqual(OnboardingLayout.welcomeTitleSize, 52)
    XCTAssertEqual(OnboardingLayout.outcomeTitleSize, 30)
    XCTAssertEqual(OnboardingLayout.enableTitleSize, 30)
    XCTAssertEqual(OnboardingLayout.doneTitleSize, 40)
    XCTAssertTrue(OnboardingLayout.doneTitleIsBold)
    XCTAssertEqual(OnboardingLayout.subtitleSize, 20)
    XCTAssertEqual(OnboardingLayout.enableSubtitleSize, 18)
    XCTAssertEqual(OnboardingLayout.phoneTipSize, 17)
    XCTAssertEqual(OnboardingLayout.macTipSize, 15)
    XCTAssertEqual(OnboardingLayout.captionSize, 13)
    XCTAssertEqual(OnboardingLayout.checkAgainFontSize, 13)
  }

  func testScreenThreeMatchesTheCanvas() {
    XCTAssertEqual(OnboardingLayout.enableSpacing, 16)
    XCTAssertEqual(OnboardingLayout.badgeFontSize, 18)
    XCTAssertEqual(OnboardingLayout.badgePaddingVertical, 8)
    XCTAssertEqual(OnboardingLayout.badgePaddingHorizontal, 20)
    XCTAssertEqual(OnboardingLayout.badgeSpacing, 10)
    XCTAssertEqual(OnboardingLayout.stepsFontSize, 16)
    XCTAssertEqual(OnboardingLayout.stepsPaddingVertical, 14)
    XCTAssertEqual(OnboardingLayout.stepsPaddingHorizontal, 16)
    XCTAssertEqual(OnboardingLayout.stepsSpacing, 10)
    XCTAssertEqual(OnboardingLayout.stepsRadius, 16)
    XCTAssertEqual(OnboardingLayout.openMinHeight, 50)
    XCTAssertEqual(OnboardingLayout.openBorderWidth, 2)
    XCTAssertEqual(OnboardingLayout.openRadius, 14)
    XCTAssertEqual(OnboardingLayout.openFontSize, 18)
    XCTAssertEqual(OnboardingLayout.openSpacing, 10)
  }

  /// Owner ruling D3 (22 Oct): the Open Settings button's icon is the outline symbol, as drawn.
  func testOpenSettingsUsesTheOutlineSymbol() throws {
    XCTAssertEqual(OnboardingLayout.openIconSymbol, "arrow.up.forward.app")
    let root = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
    let view = try String(
      contentsOf: root.appendingPathComponent("Still/Shared (App)/Onboarding/OnboardingView.swift"),
      encoding: .utf8)
    XCTAssertTrue(view.contains("Image(systemName: OnboardingLayout.openIconSymbol)"))
    XCTAssertFalse(view.contains("arrow.up.forward.app.fill"))
  }

  func testColoursMatchTheCanvas() {
    XCTAssertEqual(OnboardingLayout.background, .init(light: 0xF7F7F7, dark: 0x0A0A0A))
    XCTAssertEqual(OnboardingLayout.secondaryText, .init(light: 0x6E6E73, dark: 0x98989D))
    XCTAssertEqual(OnboardingLayout.well, .init(light: 0xE9E9EA, dark: 0x1C1C1E))
    XCTAssertEqual(OnboardingLayout.inactiveDot, .init(light: 0xC7C7CC, dark: 0x48484A))
    XCTAssertEqual(OnboardingLayout.confirmedGreen, .init(light: 0x1F7A3A, dark: 0x34C759))
  }

  /// OnboardingView takes its sizes from OnboardingLayout: no `.still(size: <number>` font and none
  /// of the old literals (8pt dot gap, 32pt sides on every platform, 28pt screen-3 heading) remain.
  func testTheViewReadsItsSizesFromTheLayout() throws {
    let root = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
    let view = try String(
      contentsOf: root.appendingPathComponent("Still/Shared (App)/Onboarding/OnboardingView.swift"),
      encoding: .utf8)
    XCTAssertNil(view.range(of: #"\.still\(size: \d"#, options: .regularExpression))
    XCTAssertFalse(view.contains("HStack(spacing: 8) {\n      ForEach(0...lastStep"))
    XCTAssertFalse(view.contains(".padding(.horizontal, 32)"))
    XCTAssertTrue(view.contains("OnboardingLayout.dotSpacing"))
    XCTAssertTrue(view.contains("OnboardingLayout.primaryMinHeight"))
    XCTAssertTrue(view.contains("OnboardingLayout.enableTitleSize"))
    let presenter = try String(
      contentsOf: root.appendingPathComponent("Still/Shared (App)/Onboarding/OnboardingPresenter.swift"),
      encoding: .utf8)
    XCTAssertTrue(presenter.contains("OnboardingLayout.macSheetHeight"))
  }
}
