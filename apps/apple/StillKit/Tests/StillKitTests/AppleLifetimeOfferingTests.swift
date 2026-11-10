import XCTest
@testable import StillKit

final class AppleLifetimeOfferingTests: XCTestCase {
  private func offer(_ offering: String = "still_pro_v3", _ package: String = "$rc_lifetime",
    _ product: String = "still_pro_v3", lifetime: Bool = true, nonConsumable: Bool = true,
    price: String = "9,99 €", currency: String = "EUR") -> AppleLifetimeOffering? {
    ApplePurchaseCatalog.lifetimeOffering(offeringID: offering, packageID: package,
      productID: product, isLifetime: lifetime, isNonConsumable: nonConsumable,
      price: price, currencyCode: currency)
  }

  func testExactReviewedLifetimeTupleKeepsActualLocalizedStorePrice() {
    let result = offer()!
    XCTAssertEqual(result.price, "9,99 €")
    XCTAssertEqual(result.currencyCode, "EUR")
    XCTAssertEqual(result.package, "still-pro-v3")
    XCTAssertEqual(AppleLifetimeOffering.parse(result.payload), result)
  }

  func testNoArbitraryOfferingPackageHistoricalProductOrSubscriptionFallback() {
    XCTAssertNil(offer("default"))
    XCTAssertNil(offer("still_pro_v3", "$rc_annual"))
    XCTAssertNil(offer("still_pro_v3", "$rc_lifetime", "still_sync"))
    XCTAssertNil(offer(lifetime: false))
    XCTAssertNil(offer(nonConsumable: false))
    XCTAssertNil(offer(price: "  "))
    XCTAssertNil(offer(currency: "usd"))
    XCTAssertNil(offer(currency: "USDD"))
  }

  func testCallerCannotAddGrantOrReplaceLifetimeKind() {
    var raw = offer()!.payload
    raw["entitled"] = "true"
    XCTAssertNil(AppleLifetimeOffering.parse(raw))
    raw.removeValue(forKey: "entitled")
    raw["kind"] = "subscription"
    XCTAssertNil(AppleLifetimeOffering.parse(raw))
  }

  func testPurchaseSuccessRequiresFreshExactProductReceipt() {
    XCTAssertEqual(ApplePurchaseActionResult(.purchased).outcome, .pending)
    XCTAssertEqual(ApplePurchaseActionResult(.purchased, receipt: .entitled, productId: "unknown").outcome, .pending)
    XCTAssertEqual(ApplePurchaseActionResult(.purchased, receipt: .entitled, productId: "still_sync").outcome, .pending)
    XCTAssertEqual(ApplePurchaseActionResult(.purchased, receipt: .entitled, productId: "still_pro_v3").outcome, .purchased)
    XCTAssertEqual(ApplePurchaseActionResult(.restored, receipt: .entitled, productId: "still_sync").outcome, .restored)
    XCTAssertEqual(ApplePurchaseActionResult(.nothing, receipt: .entitled, productId: "still_pro_v3").outcome, .failed)
  }

  /// ISS-0136: the store SDK said "failed" after Apple had completed the charge. The device holds a
  /// verified receipt for the sellable product, so the reply must send the page to local
  /// verification (pending), not to "The purchase wasn't confirmed".
  func testAFailedStoreActionWithAVerifiedSellableReceiptAwaitsVerification() {
    for outcome in [ApplePurchaseActionOutcome.failed, .staleIdentity] {
      let rescued = ApplePurchaseActionResult(outcome, receipt: .entitled, productId: "still_pro_v3")
      XCTAssertEqual(rescued.outcome, .pending, "\(outcome)")
      XCTAssertEqual(rescued.receipt, .entitled)
      XCTAssertEqual(rescued.productId, "still_pro_v3")
      XCTAssertNil(rescued.newPurchaseEvidence)
      // Without a sellable receipt the store's answer stands: nothing to verify.
      XCTAssertEqual(ApplePurchaseActionResult(outcome, receipt: .noSignal).outcome, outcome, "\(outcome)")
      XCTAssertEqual(ApplePurchaseActionResult(outcome, receipt: .verifiedNotEntitled, productId: "still_pro_v3").outcome, outcome, "\(outcome)")
      // The historical product is never device proof (ISS-0132), so it rescues nothing.
      XCTAssertEqual(ApplePurchaseActionResult(outcome, receipt: .entitled, productId: "still_sync").outcome, outcome, "\(outcome)")
    }
    // The Still Pro Restore reply takes the same rule: a failed App Store check with an entitled
    // sellable receipt verifies locally instead of saying "couldn't finish".
    XCTAssertEqual(ApplePurchaseActionResult.proRestore(.failed, receipt: .entitled, productId: "still_pro_v3").outcome, .pending)
  }

  /// ISS-0134: the bounded wait's answer passes through untouched and never carries evidence.
  func testAnUnsettledWaitIsNeitherASuccessNorAFailure() {
    let waited = ApplePurchaseActionResult(.unsettled)
    XCTAssertEqual(waited.outcome, .unsettled)
    XCTAssertEqual(waited.receipt, .noSignal)
    XCTAssertEqual(waited.payload as NSDictionary, ["outcome": "unsettled", "receipt": "noSignal"] as NSDictionary)
    XCTAssertEqual(ApplePurchaseActionResult(.unsettled, receipt: .entitled, productId: "still_pro_v3").outcome, .unsettled)
    XCTAssertNil(ApplePurchaseActionResult(.unsettled, receipt: .entitled, productId: "still_pro_v3",
      newPurchaseEvidence: ["productId": "still_pro_v3"]).newPurchaseEvidence)
  }
}
