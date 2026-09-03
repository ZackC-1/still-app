import Foundation
import XCTest
@testable import StillKit

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

  func testPaidTierDefaultsOff() {
    XCTAssertFalse(MonetizationConfig.paidTierEnabled)
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
