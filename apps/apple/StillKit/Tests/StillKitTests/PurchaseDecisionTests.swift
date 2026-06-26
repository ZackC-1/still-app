import XCTest
@testable import StillKit

final class PurchaseDecisionTests: XCTestCase {
  func testNotConfiguredCannotPurchase() {
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: false,
        startingAppUserID: nil,
        currentAppUserID: nil,
        packageAvailable: true
      ),
      .notConfigured
    )
  }

  func testEmptyAppUserIDIsNotConfigured() {
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: true,
        startingAppUserID: "",
        currentAppUserID: "",
        packageAvailable: true
      ),
      .notConfigured
    )
  }

  func testMissingPackageIsUnavailable() {
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: true,
        startingAppUserID: "u",
        currentAppUserID: "u",
        packageAvailable: false
      ),
      .unavailable
    )
  }

  func testIdentitySwitchToSignedOutBlocksPurchase() {
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: true,
        startingAppUserID: "old",
        currentAppUserID: nil,
        packageAvailable: true
      ),
      .identityChanged
    )
  }

  func testAccountSwitchToDifferentUserBlocksPurchase() {
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: true,
        startingAppUserID: "user-a",
        currentAppUserID: "user-b",
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
        packageAvailable: true
      ),
      .proceed
    )
  }
}
