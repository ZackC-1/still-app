import XCTest
@testable import StillKit

final class PurchaseDecisionTests: XCTestCase {
  func testNotConfiguredCannotPurchase() {
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: false,
        startingAppUserID: nil,
        currentAppUserID: nil,
        alreadyEntitled: false,
        packageAvailable: true
      ),
      .notConfigured
    )
  }

  func testAlreadyEntitledShortCircuitsPurchase() {
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: true,
        startingAppUserID: "u",
        currentAppUserID: "u",
        alreadyEntitled: true,
        packageAvailable: true
      ),
      .alreadyEntitled
    )
  }

  func testMissingPackageIsUnavailable() {
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: true,
        startingAppUserID: "u",
        currentAppUserID: "u",
        alreadyEntitled: false,
        packageAvailable: false
      ),
      .unavailable
    )
  }

  func testIdentitySwitchDuringAwaitBlocksPurchase() {
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: true,
        startingAppUserID: "old",
        currentAppUserID: nil,
        alreadyEntitled: false,
        packageAvailable: true
      ),
      .identityChanged
    )
  }

  func testReadyToPurchase() {
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: true,
        startingAppUserID: "u",
        currentAppUserID: "u",
        alreadyEntitled: false,
        packageAvailable: true
      ),
      .proceed
    )
  }
}

