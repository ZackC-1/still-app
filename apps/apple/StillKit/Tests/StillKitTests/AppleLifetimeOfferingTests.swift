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
}
