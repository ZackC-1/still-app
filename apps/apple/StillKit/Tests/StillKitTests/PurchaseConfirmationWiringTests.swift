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
  /// rule decides; the SDK's message alone never ends a confirmed purchase as "not confirmed". The
  /// rule gets the pre-flight's conclusiveness, the SDK's cancel error (the async SDK throws it on a
  /// plain cancel) and its Ask-to-Buy error; a rescued new purchase hands over the same evidence.
  func testAStoreSDKFailureIsResolvedByStoreKitNotBySDKMessage() throws {
    let manager = try source("Purchases/PurchaseManager.swift")
    let purchase = try slice(manager, from: "func purchaseStillPro(", to: "\n  }\n")
    XCTAssertTrue(purchase.contains("AppleSDKPurchaseFailure.classify(sdkReportsCancel: sdkCancel, sdkReportsPending: sdkPending,"))
    XCTAssertTrue(purchase.contains("preflightConclusive: preflightRead.conclusive,"))
    XCTAssertTrue(purchase.contains("receiptAfterFailure: after.status, afterConclusive: after.conclusive)"),
      "a refusal needs a conclusive receipt read after the failure (ISS-0138)")
    XCTAssertTrue(purchase.contains("let after = await self.sellableReceiptRead(onVerifiedRevocation: onVerifiedRevocation)"),
      "the sellable receipt is read again after the SDK throws")
    XCTAssertTrue(purchase.contains("let sdkCancel = code == .purchaseCancelledError, sdkPending = code == .paymentPendingError"))
    XCTAssertTrue(purchase.contains("case .cancelled: return .cancelled"))
    XCTAssertTrue(purchase.contains("case .failed: return .failed(error.localizedDescription)"))
    // ISS-0138: the store's pre-payment refusals reach the rule as such, and a refusal charged
    // nothing: it answers the page's "unavailable" (refused before any charge), never a verify.
    XCTAssertTrue(purchase.contains("let sdkRefusal = code.map { Self.sdkRefusalCodes.contains($0) } ?? false"))
    XCTAssertTrue(purchase.contains("sdkReportsRefusal: sdkRefusal,"))
    XCTAssertTrue(purchase.contains("case .refused: return .refused"))
    let refusals = try slice(manager, from: "private nonisolated static let sdkRefusalCodes", to: "\n  ]")
    for code in [".purchaseNotAllowedError", ".purchaseInvalidError", ".productNotAvailableForPurchaseError", ".ineligibleError"] {
      XCTAssertTrue(refusals.contains(code), "\(code) is a refusal before any payment")
    }
    for code in [".storeProblemError", ".networkError", ".unknownError", ".purchaseCancelledError", ".paymentPendingError"] {
      XCTAssertFalse(refusals.contains(code), "\(code) keeps the receipt rule")
    }
    let modern = try slice(manager, from: "func purchasePro(offer:", to: "\n  }\n")
    XCTAssertTrue(modern.contains("case .unavailable, .refused: mapped = .unavailable"))
    let router = try source("WebBridgeRouter.swift")
    XCTAssertTrue(router.contains("case .unavailable, .refused: return [\"outcome\": \"unavailable\", \"entitled\": false]"))
    XCTAssertTrue(purchase.contains("if let onNewPurchase, let evidence = await newPurchaseEvidence(nil) { onNewPurchase(evidence) }"),
      "a rescued new purchase is counted like an SDK-completed one")
    XCTAssertTrue(purchase.contains("AppleNewPurchaseProvenance.rescuedEligible(preflightKnown: before.0, preflightID: before.1,"))
    // The pre-flight keeps the whole read, so a timed-out read cannot pass as "no purchase before".
    XCTAssertTrue(purchase.contains("if preflightRead.status == .entitled { return .purchased }"))
    let read = try slice(manager, from: "func sellableReceiptRead(", to: "\n  }\n")
    XCTAssertTrue(read.contains("conclusive: false"), "a timed-out sellable read is not conclusive")
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
    // A join reads the settled result without clearing it: a reply the fence refuses after the
    // claim must not lose a settled purchase. Only the next purchase start replaces it.
    XCTAssertFalse(purchase.contains("defer { unclaimedPurchaseResult = nil }"))
    XCTAssertEqual(purchase.components(separatedBy: "unclaimedPurchaseResult = nil").count - 1, 1)
    XCTAssertLessThan(try XCTUnwrap(purchase.range(of: "unclaimedPurchaseResult = nil")).lowerBound,
      try XCTUnwrap(purchase.range(of: "let task = Task")).lowerBound, "cleared only when a new purchase starts")
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
    for kind in ["applePurchaseEvidence", "appleLocalPurchaseEvidence", "getBenefitAccess", "purchasePro", "restorePro"] {
      let handler = try slice(router, from: "case \"\(kind)\":", to: "\n    case \"")
      let fence = try XCTUnwrap(handler.range(of: "guard self.accessRevocations.ready"), "\(kind) keeps the fence")
      // The retry nearest before the fence, so a purchase or Restore that settled is retried after
      // its own StoreKit work, right before the reply could be refused.
      let retry = try XCTUnwrap(handler.range(of: "self.retryVerifiedRevocations()", options: .backwards,
        range: handler.startIndex..<fence.lowerBound), "\(kind) retries the commit before the fence can refuse")
      XCTAssertLessThan(retry.lowerBound, fence.lowerBound)
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
