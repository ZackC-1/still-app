import Foundation

/// The measurements of the native onboarding screens and the Safari setup sheet (OnboardingView in
/// the app target), taken from the owner's screens canvas ("iPhone onboarding" and "Mac app" pages,
/// checked 22 Oct 2026). Kept here, as plain numbers, so `swift test` pins every one of them: the
/// view reads its sizes from this and nothing else, so a size changed in the view alone would not
/// compile, and a size changed here fails OnboardingLayoutTests.
///
/// Sizes are in points. Colours are sRGB hex values, light then dark.
public enum OnboardingLayout {
  /// One platform's frame: the side, top and bottom insets and the Safari setup sheet's Close row.
  public struct Frame: Equatable, Sendable {
    /// Between the screen's side and the content, buttons included.
    public let sideInset: Double
    /// Above the progress dots (inside the safe area on the iPhone).
    public let topInset: Double
    /// Below the main button (inside the safe area on the iPhone).
    public let bottomInset: Double
    /// The setup sheet's Close row: space above it, its height, the space from the sheet's side to
    /// the word "Close", and the space under the row before the content's own gap.
    public let closeTop: Double
    public let closeMinHeight: Double
    public let closeTrailing: Double
    public let closeBottom: Double
  }

  /// iPhone (390pt canvas boards).
  public static let phone = Frame(
    sideInset: 16, topInset: 24, bottomInset: 22,
    closeTop: 16, closeMinHeight: 44, closeTrailing: 24, closeBottom: 24)
  /// Mac (480pt canvas boards).
  public static let mac = Frame(
    sideInset: 32, topInset: 40, bottomInset: 32,
    closeTop: 12, closeMinHeight: 32, closeTrailing: 36, closeBottom: 0)

  /// The Mac onboarding and setup sheet, before the clamp to the window.
  public static let macSheetWidth: Double = 520
  public static let macSheetHeight: Double = 760

  // Progress dots.
  public static let dotSize: Double = 8
  public static let activeDotWidth: Double = 22
  public static let dotSpacing: Double = 12

  // The main button at the bottom ("Continue", "I've turned it on", "Get started", "Done").
  public static let primaryMinHeight: Double = 52
  public static let primaryRadius: Double = 14
  public static let primaryFontSize: Double = 16
  /// Between "Check again" and the main button.
  public static let footerSpacing: Double = 16
  /// "Check again"'s height in the setup sheet (on onboarding screen 3 it is the text's own height).
  public static let sheetCheckAgainMinHeight: Double = 44
  public static let checkAgainFontSize: Double = 13
  /// The setup sheet's "Close".
  public static let closeFontSize: Double = 16

  // Headings: size, and whether bold (700) rather than semibold (600). All tracked -0.02em.
  public static let headingTracking: Double = -0.02
  public static let welcomeTitleSize: Double = 52
  public static let outcomeTitleSize: Double = 30
  public static let enableTitleSize: Double = 30
  public static let doneTitleSize: Double = 40
  public static let doneTitleIsBold = true

  /// Under the headings on screens 1, 2 and 4.
  public static let subtitleSize: Double = 20
  /// Screen 3's line under its heading.
  public static let enableSubtitleSize: Double = 18
  /// Screen 4's "Back in Safari, …" line.
  public static let phoneTipSize: Double = 17
  public static let macTipSize: Double = 15
  /// "No account or purchase is needed. …"
  public static let captionSize: Double = 13

  /// Screen 3 and the setup sheet stack their parts from the top, this far apart.
  public static let enableSpacing: Double = 16

  // Screen 3's status badge ("Not on yet" / "You're all set").
  public static let badgeFontSize: Double = 18
  public static let badgePaddingVertical: Double = 8
  public static let badgePaddingHorizontal: Double = 20
  public static let badgeSpacing: Double = 10
  public static let badgeOffIconSize: Double = 16
  public static let badgeOnIconSize: Double = 18

  // Screen 3's numbered steps.
  public static let stepsFontSize: Double = 16
  public static let stepsPaddingVertical: Double = 14
  public static let stepsPaddingHorizontal: Double = 16
  public static let stepsSpacing: Double = 10
  public static let stepsRadius: Double = 16
  public static let stepNumberSize: Double = 22
  public static let stepNumberFontSize: Double = 13

  // Screen 3's outlined "Open Settings" / "Open Safari Settings" button.
  public static let openMinHeight: Double = 50
  public static let openBorderWidth: Double = 2
  public static let openRadius: Double = 14
  public static let openFontSize: Double = 18
  public static let openSpacing: Double = 10
  public static let openIconSize: Double = 16

  /// sRGB colours, light then dark.
  public struct Hex: Equatable, Sendable {
    public let light: UInt32
    public let dark: UInt32
  }
  public static let background = Hex(light: 0xF7F7F7, dark: 0x0A0A0A)
  /// Secondary text: subtitles, the tip, the caption, "Check again" and the "Not on yet" badge.
  public static let secondaryText = Hex(light: 0x6E6E73, dark: 0x98989D)
  /// The badge's and the steps card's fill.
  public static let well = Hex(light: 0xE9E9EA, dark: 0x1C1C1E)
  /// The inactive progress dots.
  public static let inactiveDot = Hex(light: 0xC7C7CC, dark: 0x48484A)
  /// Screen 3's "on" glyph and the "You're all set" check.
  public static let confirmedGreen = Hex(light: 0x1F7A3A, dark: 0x34C759)
  /// Screen 4's seal.
  public static let readyGreen = Hex(light: 0x34C759, dark: 0x34C759)
}
