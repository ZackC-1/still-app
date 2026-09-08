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
    let capture = try captureSource()
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

  /// The cohort record's local half is the field the free era is actually read from, and it comes
  /// from the app's own bundle with no App Store round trip. It has to be written before anything
  /// that can stop the capture, or switching the ask to Apple off would take the cohort with it.
  func testTheCohortRecordIsWrittenBeforeAnythingCanStopTheCapture() throws {
    let capture = try captureSource()
    let localWrite = try XCTUnwrap(
      capture.range(of: "OriginalInstall.ensure("),
      "the capture no longer writes the local half of the record"
    )
    let firstGate = try XCTUnwrap(
      capture.range(of: "guard "),
      "this test can no longer find where the capture starts giving up"
    )
    XCTAssertTrue(
      localWrite.upperBound < firstGate.lowerBound,
      "the local half must be written before the first thing that can return early: it needs "
        + "nothing from Apple and every install must get one"
    )
  }

  /// Asking Apple for the app transaction is switched off with the rest of the paid tier
  /// (`OriginalInstall.shouldRequestVerifiedValues`), because it can raise an App Store sign-in
  /// sheet on a device where nobody is signed in and nothing reads the answer while Still sells
  /// nothing. A guard only holds if it is the only way through, so this asks the harder question:
  /// is that the only place in the shipped Apple sources that asks at all. A second one added later
  /// would be behind no switch, and this is what says so.
  func testTheAppAsksAppleForPurchaseHistoryInExactlyOnePlace() throws {
    var callSites: [String] = []
    for url in try shippedSwiftSources() {
      let text = try String(contentsOf: url, encoding: .utf8)
      for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let code = line.trimmingCharacters(in: .whitespaces)
        if code.hasPrefix("//") { continue }
        if code.contains("AppTransaction.shared") { callSites.append(url.lastPathComponent) }
      }
    }
    XCTAssertEqual(
      callSites, ["WebBridgeRouter.swift"],
      "every ask for Apple's purchase history goes through the one gated capture in "
        + "WebBridgeRouter; a new call site needs the same switch before it ships"
    )
  }

  /// Every Swift file this app actually ships: the app targets and StillKit's sources, without the
  /// tests (which name the call they are asserting about) or any build output.
  private func shippedSwiftSources() throws -> [URL] {
    let roots = [
      repositoryRoot.appendingPathComponent("apps/apple/Still"),
      repositoryRoot.appendingPathComponent("apps/apple/StillKit/Sources"),
    ]
    var found: [URL] = []
    for root in roots {
      let enumerator = try XCTUnwrap(
        FileManager.default.enumerator(atPath: root.path),
        "this test can no longer read \(root.lastPathComponent)"
      )
      for case let relative as String in enumerator where relative.hasSuffix(".swift") {
        let components = relative.split(separator: "/")
        if components.contains(where: { $0 == "build" || $0 == ".build" || $0 == "Tests" }) {
          continue
        }
        found.append(root.appendingPathComponent(relative))
      }
    }
    XCTAssertFalse(found.isEmpty, "no Apple sources found: this test would pass by finding nothing")
    return found
  }

  /// The body of the router's cohort capture.
  private func captureSource() throws -> String {
    let source = try routerSource()
    return try XCTUnwrap(
      source.components(separatedBy: "private func captureOriginalInstall() async {").last,
      "the capture is no longer where this test expects it"
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
