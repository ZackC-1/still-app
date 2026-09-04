import Foundation
import XCTest
@testable import StillKit

/// The two halves of the paid-tier switch live in different languages and different build systems,
/// so nothing but a test can stop them drifting apart. These read the shipped source text on
/// purpose rather than a compiled value, because the TypeScript half is not reachable from Swift.
final class MonetizationConfigTests: XCTestCase {
  private var repositoryRoot: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }

  /// A deliberate tripwire, not a mistake if it fails. The paid tier is dormant, so this build
  /// must ship with the switch off; anyone turning it back on changes this expectation in the same
  /// commit and thereby says out loud that the change was intended.
  func testPaidTierShipsDormant() {
    XCTAssertFalse(
      MonetizationConfig.paidTierEnabled,
      "the paid tier is dormant: update this expectation in the commit that turns it back on"
    )
  }

  func testSwiftSwitchMatchesSharedTypeScriptSwitch() throws {
    let sourceURL = repositoryRoot
      .appendingPathComponent("packages/shared-types/src/entitlement.ts")
    let source = try String(contentsOf: sourceURL, encoding: .utf8)
    let sharedSwitch: Bool
    if source.contains("export const PAID_TIER_ENABLED = true;") {
      sharedSwitch = true
    } else {
      XCTAssertTrue(
        source.contains("export const PAID_TIER_ENABLED = false;"),
        "the shared paid-tier switch must remain a literal boolean"
      )
      sharedSwitch = false
    }

    XCTAssertEqual(MonetizationConfig.paidTierEnabled, sharedSwitch)
  }

  func testPurchaseAndRestoreBridgeActionsBothUseTheAppleSwitch() throws {
    let routerURL = repositoryRoot
      .appendingPathComponent("apps/apple/Still/Shared (App)/WebBridgeRouter.swift")
    let source = try String(contentsOf: routerURL, encoding: .utf8)
    let guardCount = source.components(
      separatedBy: "guard MonetizationConfig.paidTierEnabled else"
    ).count - 1

    XCTAssertEqual(guardCount, 2, "purchase and restore must both be refused while paid access is dormant")
  }
}
