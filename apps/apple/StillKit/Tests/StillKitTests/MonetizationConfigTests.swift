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

  /// Checks the property rather than a count of guards, so that adding an unrelated guard to this
  /// router later cannot fail this test with a message about purchases.
  ///
  /// It asserts the refusal comes BEFORE the StoreKit call, inside that action's own arm of the
  /// switch. An earlier version asked only whether the guard appeared somewhere after
  /// `case "purchase":`, and when it could not find where that arm ended it fell back to the whole
  /// rest of the file. Deleting the purchase guard and re-indenting the switch, which is all a
  /// reformat or one more level of nesting would do, left it green while matching the neighbouring
  /// restore arm's guard: a test about money, passing on a router that could charge for something.
  /// So this one refuses to guess, and every failure names what it could not find.
  func testPurchaseAndRestoreBridgeActionsBothUseTheAppleSwitch() throws {
    let source = try routerSource()
    let storeKitCallPerAction = [
      (action: "purchase", call: "self.purchases.purchaseStillPro()"),
      (action: "restore", call: "self.purchases.restore()"),
    ]
    for (action, storeKitCall) in storeKitCallPerAction {
      let block = try XCTUnwrap(
        bridgeActionBody(named: action, in: source),
        "this test can no longer find the \"\(action)\" arm of the router's switch"
      )
      let call = try XCTUnwrap(
        block.range(of: storeKitCall),
        "the \"\(action)\" action no longer reaches StoreKit through \(storeKitCall): "
          + "point this test at the call it makes now"
      )
      XCTAssertTrue(
        block[block.startIndex..<call.lowerBound]
          .contains("guard MonetizationConfig.paidTierEnabled else"),
        "the \"\(action)\" action must be refused while paid access is dormant, before it reaches "
          + "StoreKit"
      )
    }
  }

  /// The cohort record is written from this router at first launch and cannot be recreated later,
  /// so the value it stores has to be interpretable on both platforms. Apple reports
  /// `originalAppVersion` as a build number on iOS and a marketing version on macOS; asking
  /// StillKit which one this platform uses is what keeps the two comparable.
  func testTheCohortRecordTagsApplesVersionNamespaceRatherThanAssumingOne() throws {
    let source = try routerSource()
    XCTAssertTrue(
      source.contains("kind: OriginalInstall.applicationVersionKindForThisPlatform"),
      "the recorded application version must carry the namespace it was read in"
    )
    XCTAssertFalse(
      source.contains("kind: .buildNumber") || source.contains("kind: .marketingVersion"),
      "hardcoding one platform's namespace would misclassify the other platform's installs"
    )
  }

  /// Asking Apple for the app transaction can raise an App Store sign-in prompt on a device with
  /// no cached transaction. Still is free, so the ask has to be counted before it is made and has
  /// to stop, rather than repeating at every launch and every foreground return.
  func testTheCohortRecordBoundsHowOftenItAsksAppleForPurchaseHistory() throws {
    let source = try routerSource()
    let capture = try XCTUnwrap(
      source.components(separatedBy: "private func captureOriginalInstall() async {").last,
      "the capture is no longer where this test expects it"
    )
    let ask = try XCTUnwrap(
      capture.range(of: "AppTransaction.shared"),
      "the capture no longer reads the app transaction"
    )
    let beforeTheAsk = String(capture[capture.startIndex..<ask.lowerBound])
    XCTAssertTrue(
      beforeTheAsk.contains("OriginalInstall.shouldRequestVerifiedValues"),
      "the capture must check the attempt ceiling before asking Apple"
    )
    XCTAssertTrue(
      beforeTheAsk.contains("OriginalInstall.countVerifiedAttempt"),
      "the attempt must be counted before the ask, so a request that never returns still counts"
    )
    // The capture runs at launch and again when the app becomes active, both on a cold launch, so
    // without a per-launch flag one launch spends two attempts and two requests can be open at once.
    XCTAssertTrue(
      beforeTheAsk.contains("!hasAskedAppleForPurchaseHistoryThisLaunch"),
      "one launch must spend at most one attempt: launch and foreground both reach this capture"
    )
    XCTAssertTrue(
      beforeTheAsk.contains("hasAskedAppleForPurchaseHistoryThisLaunch = true"),
      "the per-launch flag must be set before the ask, not after it returns"
    )
  }

  private func routerSource() throws -> String {
    let routerURL = repositoryRoot
      .appendingPathComponent("apps/apple/Still/Shared (App)/WebBridgeRouter.swift")
    return try String(contentsOf: routerURL, encoding: .utf8)
  }

  /// The body of one `case "<action>":` arm of the router's message switch, from that arm's colon
  /// to the start of the next one. Nil when either end cannot be found, and nil at any indentation,
  /// because a helper that quietly widens its window turns an assertion about one arm into an
  /// assertion about whatever follows it.
  private func bridgeActionBody(named action: String, in source: String) -> String? {
    guard let start = source.range(of: "case \"\(action)\":") else { return nil }
    let rest = source[start.upperBound...]
    guard let nextArm = rest.range(of: "case \"") else { return nil }
    return String(rest[rest.startIndex..<nextArm.lowerBound])
  }
}
