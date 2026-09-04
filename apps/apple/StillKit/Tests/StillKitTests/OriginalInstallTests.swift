import Foundation
import XCTest
@testable import StillKit

final class OriginalInstallTests: XCTestCase {
  private func freshDefaults(_ name: String) -> UserDefaults {
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return defaults
  }

  private let firstLaunch = Date(timeIntervalSince1970: 1_700_000_000)
  private let laterLaunch = Date(timeIntervalSince1970: 1_800_000_000)

  func testTheLocalHalfIsWrittenOnceAndNeverMovesForward() {
    let defaults = freshDefaults("still.originalInstall.tests.once")

    let first = OriginalInstall.ensure(
      firstRecordedAt: firstLaunch,
      appVersion: "2.0.0",
      defaults: defaults
    )
    XCTAssertEqual(first.firstRecordedAt, firstLaunch)
    XCTAssertEqual(first.firstRecordedAppVersion, "2.0.0")

    // A later launch, and a later app version: the cohort must not move.
    let second = OriginalInstall.ensure(
      firstRecordedAt: laterLaunch,
      appVersion: "3.0.0",
      defaults: defaults
    )
    XCTAssertEqual(second, first)
    XCTAssertEqual(OriginalInstall.current(defaults), first)
  }

  func testTheVerifiedHalfIsTaggedWithTheNamespaceItIsIn() {
    // The defect this pins: Apple reports originalAppVersion as a build number on iOS and a
    // marketing version on macOS, so the same release writes "6" on one platform and "1.0.1" on
    // the other. Comparing them against one shared threshold would grant or deny an entire
    // platform's installs by accident, and these records cannot be recreated afterwards.
    let defaults = freshDefaults("still.originalInstall.tests.kind")
    OriginalInstall.ensure(firstRecordedAt: firstLaunch, appVersion: "2.0.0", defaults: defaults)

    let filled = OriginalInstall.fillVerifiedValues(
      applicationVersion: "6",
      kind: .buildNumber,
      originalPurchaseDate: firstLaunch,
      defaults: defaults
    )

    XCTAssertEqual(filled?.applicationVersion, "6")
    XCTAssertEqual(filled?.applicationVersionKind, .buildNumber)
    XCTAssertEqual(OriginalInstall.current(defaults)?.applicationVersionKind, .buildNumber)
    // The local half is untouched by the fill.
    XCTAssertEqual(OriginalInstall.current(defaults)?.firstRecordedAt, firstLaunch)
    XCTAssertEqual(OriginalInstall.current(defaults)?.firstRecordedAppVersion, "2.0.0")
  }

  func testTheVerifiedHalfIsWrittenOnlyOnce() {
    let defaults = freshDefaults("still.originalInstall.tests.fillOnce")
    OriginalInstall.ensure(firstRecordedAt: firstLaunch, appVersion: "2.0.0", defaults: defaults)
    OriginalInstall.fillVerifiedValues(
      applicationVersion: "6",
      kind: .buildNumber,
      originalPurchaseDate: firstLaunch,
      defaults: defaults
    )

    OriginalInstall.fillVerifiedValues(
      applicationVersion: "99",
      kind: .marketingVersion,
      originalPurchaseDate: laterLaunch,
      defaults: defaults
    )

    XCTAssertEqual(OriginalInstall.current(defaults)?.applicationVersion, "6")
    XCTAssertEqual(OriginalInstall.current(defaults)?.originalPurchaseDate, firstLaunch)
  }

  func testTheVerifiedHalfIsNeverWrittenWithoutALocalHalf() {
    let defaults = freshDefaults("still.originalInstall.tests.noLocalHalf")

    let result = OriginalInstall.fillVerifiedValues(
      applicationVersion: "6",
      kind: .buildNumber,
      originalPurchaseDate: firstLaunch,
      defaults: defaults
    )

    XCTAssertNil(result)
    XCTAssertNil(OriginalInstall.current(defaults))
  }

  func testAskingAppleForTheVerifiedHalfStopsAfterAFewAttempts() {
    // Each ask can raise an App Store sign-in prompt on a device with no cached transaction. Still
    // is free and sells nothing, so it must stop asking rather than prompt at every launch forever.
    let defaults = freshDefaults("still.originalInstall.tests.attempts")
    OriginalInstall.ensure(firstRecordedAt: firstLaunch, appVersion: "2.0.0", defaults: defaults)

    for _ in 0..<OriginalInstall.maxVerifiedAttempts {
      XCTAssertTrue(OriginalInstall.shouldRequestVerifiedValues(defaults))
      OriginalInstall.countVerifiedAttempt(defaults)
    }

    XCTAssertFalse(OriginalInstall.shouldRequestVerifiedValues(defaults))
    // The install is still identifiable as a free-era one: only the optional half was lost.
    XCTAssertEqual(OriginalInstall.current(defaults)?.firstRecordedAt, firstLaunch)
  }

  func testAskingStopsAsSoonAsTheVerifiedHalfArrives() {
    let defaults = freshDefaults("still.originalInstall.tests.attemptsSatisfied")
    OriginalInstall.ensure(firstRecordedAt: firstLaunch, appVersion: "2.0.0", defaults: defaults)
    OriginalInstall.countVerifiedAttempt(defaults)
    OriginalInstall.fillVerifiedValues(
      applicationVersion: "1.0.1",
      kind: .marketingVersion,
      originalPurchaseDate: firstLaunch,
      defaults: defaults
    )

    XCTAssertFalse(OriginalInstall.shouldRequestVerifiedValues(defaults))
  }

  func testThePlatformNamespaceMatchesApplesDocumentedBehavior() {
    // These tests build for macOS, where Apple reports the marketing version. The iOS side of the
    // same rule is pinned by the source check in MonetizationConfigTests, which proves the app
    // asks for this value rather than hardcoding one platform's answer.
    #if os(macOS)
      XCTAssertEqual(OriginalInstall.applicationVersionKindForThisPlatform, .marketingVersion)
    #else
      XCTAssertEqual(OriginalInstall.applicationVersionKindForThisPlatform, .buildNumber)
    #endif
  }

  func testMalformedStoredValueReadsAsAbsent() {
    let defaults = freshDefaults("still.originalInstall.tests.malformed")
    defaults.set(Data("not-json".utf8), forKey: OriginalInstall.storageKey)

    XCTAssertNil(OriginalInstall.current(defaults))
  }
}
