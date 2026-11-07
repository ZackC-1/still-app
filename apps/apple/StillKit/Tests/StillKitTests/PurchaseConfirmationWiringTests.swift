import XCTest
@testable import StillKit

/// ISS-0134 and ISS-0136: the app target's purchase wiring, read from source (StoreKit and the store
/// SDK cannot run under `swift test`). The rules themselves are tested in AppleLifetimeOfferingTests
/// and PurchaseDecisionTests; this pins that the app actually routes through them.
final class PurchaseConfirmationWiringTests: XCTestCase {
  private var appSource: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Still/Shared (App)")
  }
  private func source(_ file: String) throws -> String {
    try String(contentsOf: appSource.appendingPathComponent(file), encoding: .utf8)
  }
  /// Text from `start` up to the first `end` after it.
  private func slice(_ source: String, from start: String, to end: String) throws -> String {
    let open = try XCTUnwrap(source.range(of: start), "cannot find \(start)")
    let close = source.range(of: end, range: open.upperBound..<source.endIndex)?.lowerBound ?? source.endIndex
    return String(source[open.lowerBound..<close])
  }

  /// ISS-0136: when the store SDK throws after the sheet, StoreKit is read again and the tested
  /// rule decides; the SDK's message alone never ends a confirmed purchase as "not confirmed".
  func testAStoreSDKFailureIsResolvedByStoreKitNotBySDKMessage() throws {
    let manager = try source("Purchases/PurchaseManager.swift")
    let purchase = try slice(manager, from: "func purchaseStillPro(", to: "\n  }\n")
    XCTAssertTrue(purchase.contains("AppleSDKPurchaseFailure.classify(sdkReportsPending: sdkPending, receiptAfterFailure: after)"))
    XCTAssertTrue(purchase.contains("let after = await self.sellableReceiptRead(onVerifiedRevocation: onVerifiedRevocation).status"),
      "the sellable receipt is read again after the SDK throws")
    XCTAssertTrue(purchase.contains("case .purchased: return .purchased"))
    XCTAssertTrue(purchase.contains("case .failed: return .failed(error.localizedDescription)"))
  }

  /// ISS-0134: a page wait that ends before StoreKit settles answers `unsettled`, never `pending`
  /// (which sent the page to verify a purchase that did not exist), and a join waits for the
  /// purchase already in flight instead of starting another charge.
  func testABoundedWaitAnswersUnsettledAndAJoinNeverCharges() throws {
    let manager = try source("Purchases/PurchaseManager.swift")
    let purchase = try slice(manager, from: "func purchasePro(offer:", to: "\n  }\n")
    XCTAssertEqual(purchase.components(separatedBy: "fallback: ApplePurchaseActionResult(.unsettled)").count - 1, 2,
      "both the join wait and the first wait answer unsettled")
    XCTAssertFalse(purchase.contains("ApplePurchaseActionResult(.pending)"))
    XCTAssertTrue(purchase.contains("if join {"))
    XCTAssertTrue(purchase.contains("unclaimedPurchaseResult ?? ApplePurchaseActionResult(.cancelled)"),
      "a join with nothing in flight hands over the settled result or bought nothing")
    let router = try source("WebBridgeRouter.swift")
    let handler = try slice(router, from: "case \"purchasePro\":", to: "\n    case \"")
    XCTAssertTrue(handler.contains("let join = dict[\"join\"] as? Bool == true"))
    XCTAssertTrue(handler.contains("Set(join ? [\"kind\", \"offer\", \"join\"] : [\"kind\", \"offer\"])"),
      "only exactly join: true is a join; anything else is malformed")
    XCTAssertTrue(handler.contains("purchasePro(offer: offer, join: join,"))
    XCTAssertTrue(handler.contains("if result.outcome != .unsettled { await self.refreshReceiptStamp() }"))
  }

  /// A verified revocation whose durable commit failed closes the fence for every modern reply. The
  /// evidence reads that start the page's local verification retry that commit before the fence can
  /// refuse them, and every refusal on the purchase, Restore, evidence and benefit paths is logged.
  func testEvidenceReadsRetryRevocationCommitsBeforeRefusingAndRefusalsAreLogged() throws {
    let router = try source("WebBridgeRouter.swift")
    for kind in ["applePurchaseEvidence", "appleLocalPurchaseEvidence", "getBenefitAccess"] {
      let handler = try slice(router, from: "case \"\(kind)\":", to: "\n    case \"")
      let retry = try XCTUnwrap(handler.range(of: "self.retryVerifiedRevocations()"), "\(kind) retries the commit")
      let fence = try XCTUnwrap(handler.range(of: "guard self.accessRevocations.ready"), "\(kind) keeps the fence")
      XCTAssertLessThan(retry.lowerBound, fence.lowerBound, "\(kind) retries before the fence can refuse")
      XCTAssertTrue(handler.contains("self.refuse(kind, \"Apple revocation commit requires verification\", reply)"), kind)
    }
    for kind in ["purchasePro", "restorePro", "installAppleAccess"] {
      let handler = try slice(router, from: "case \"\(kind)\":", to: "\n    case \"")
      XCTAssertFalse(handler.contains("reply(nil, \"still:"), "\(kind) refuses only through the logged helper")
    }
    XCTAssertTrue(router.contains("Self.bridgeLog.notice(\"access: benefit read with StoreKit"),
      "the minute benefit read logs what it resolved (ISS-0137)")
  }
}
