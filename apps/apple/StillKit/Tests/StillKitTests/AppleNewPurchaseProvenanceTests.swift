import XCTest
@testable import StillKit

final class AppleNewPurchaseProvenanceTests: XCTestCase {
  func testActualNewVerifiedProductionTransactionOnly() {
    XCTAssertTrue(AppleNewPurchaseProvenance.eligible(preflightKnown: true, preflightID: nil,
      sdkID: "123", verifiedID: "123", environment: "production", purchased: true, revoked: false))
    XCTAssertTrue(AppleNewPurchaseProvenance.eligible(preflightKnown: true, preflightID: "122",
      sdkID: "123", verifiedID: "123", environment: "production", purchased: true, revoked: false))
    for (known, before, sdk, verified, environment, purchased, revoked) in [
      (false, Optional<String>.none, "123", "123", "production", true, false),
      (true, "123", "123", "123", "production", true, false),
      (true, nil, "122", "123", "production", true, false),
      (true, nil, "123", "123", "sandbox", true, false),
      (true, nil, "123", "123", "production", false, false),
      (true, nil, "123", "123", "production", true, true)
    ] {
      XCTAssertFalse(AppleNewPurchaseProvenance.eligible(preflightKnown: known, preflightID: before,
        sdkID: sdk, verifiedID: verified, environment: environment, purchased: purchased, revoked: revoked))
    }
  }
  func testRestoresAndUncertainResultsNeverCarryNewPurchaseEvidence() {
    let evidence = ["productId": "still_pro_v3", "bundleId": "com.test.still", "signedTransaction": "a.b.c"]
    for outcome in [ApplePurchaseActionOutcome.restored, .cancelled, .pending, .unavailable, .nothing, .failed] {
      XCTAssertNil(ApplePurchaseActionResult(outcome, receipt: .entitled, productId: "still_pro_v3",
        newPurchaseEvidence: evidence).payload["newPurchaseEvidence"])
    }
    XCTAssertNotNil(ApplePurchaseActionResult(.purchased, receipt: .entitled, productId: "still_pro_v3",
      newPurchaseEvidence: evidence).payload["newPurchaseEvidence"])
    XCTAssertNil(ApplePurchaseActionResult(.purchased, receipt: .noSignal, productId: "still_pro_v3",
      newPurchaseEvidence: evidence).payload["newPurchaseEvidence"])
  }
}
