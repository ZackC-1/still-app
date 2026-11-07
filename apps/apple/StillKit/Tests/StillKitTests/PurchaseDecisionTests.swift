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

  func testEmptyAppUserIDUnverifiedIsStaleIdentity() {
    // AMENDED for purchase-first (plan 2026-07-15-001, R15): a nil/empty user is now a
    // legitimate lane, but ONLY when the SDK identity is verified anonymous. Unverified stays
    // fail-closed as .staleIdentity (previously .notConfigured — "no user" is no longer the
    // disqualifier; "unverified identity" is).
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: true,
        startingAppUserID: "",
        currentAppUserID: "",
        packageAvailable: true
      ),
      .staleIdentity
    )
  }

  func testVerifiedAnonymousProceeds() {
    // R2/AE1: the account-free purchase lane.
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: true,
        startingAppUserID: nil,
        currentAppUserID: nil,
        packageAvailable: true,
        identityVerifiedAnonymous: true
      ),
      .proceed
    )
  }

  func testVerifiedAnonymousWithoutPackageIsUnavailable() {
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: true,
        startingAppUserID: nil,
        currentAppUserID: nil,
        packageAvailable: false,
        identityVerifiedAnonymous: true
      ),
      .unavailable
    )
  }

  func testAnonymousStartSignedInMidFlightIsIdentityChanged() {
    // A session appearing between readiness and purchase must abort the anonymous lane.
    XCTAssertEqual(
      PurchaseDecision.readiness(
        isConfigured: true,
        startingAppUserID: nil,
        currentAppUserID: "user-a",
        packageAvailable: true,
        identityVerifiedAnonymous: true
      ),
      .identityChanged
    )
  }

  // MARK: attach eligibility (R7 / AE13 / AE14)

  func testAttachEligibleWhenSignedInIdentityMatchesAndPurchased() {
    XCTAssertTrue(
      PurchaseDecision.attachEligible(
        currentAppUserID: "u", sdkAppUserID: "u", ownershipIsPurchased: true,
        receiptEntitled: true))
  }

  func testAttachRefusedForRevokedReceipt() {
    // A refunded transaction still reads as `purchased` ownership; attaching its dead receipt to
    // the account would be wrong even with a matching identity (security review pin).
    XCTAssertFalse(
      PurchaseDecision.attachEligible(
        currentAppUserID: "u", sdkAppUserID: "u", ownershipIsPurchased: true,
        receiptEntitled: false))
  }

  func testAttachRefusedSignedOut() {
    // AE13 native half: reset() nulls the user synchronously; a late attach is refused.
    XCTAssertFalse(
      PurchaseDecision.attachEligible(
        currentAppUserID: nil, sdkAppUserID: "$RCAnonymousID:x", ownershipIsPurchased: true,
        receiptEntitled: true))
  }

  func testAttachRefusedOnSdkIdentityMismatch() {
    // A timed-out re-key can leave the SDK on a different identity than the app-level session.
    XCTAssertFalse(
      PurchaseDecision.attachEligible(
        currentAppUserID: "u", sdkAppUserID: "$RCAnonymousID:x", ownershipIsPurchased: true,
        receiptEntitled: true))
  }

  func testAttachRefusedForFamilySharedTransaction() {
    // AE14: device-local Pro is fine, but a family member's account never receives the buyer's
    // entitlement via transfer.
    XCTAssertFalse(
      PurchaseDecision.attachEligible(
        currentAppUserID: "u", sdkAppUserID: "u", ownershipIsPurchased: false,
        receiptEntitled: true))
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

  /// ISS-0136: the store SDK threw after Apple had completed the charge. StoreKit decides: a
  /// verified sellable receipt that the pre-flight did not see is a purchase, whatever the SDK said.
  func testAnSDKFailureWithAVerifiedReceiptIsAPurchase() {
    XCTAssertEqual(AppleSDKPurchaseFailure.classify(sdkReportsPending: false, receiptAfterFailure: .entitled), .purchased)
    // Even the SDK's own "approval arrives later" error yields to a receipt that is already there.
    XCTAssertEqual(AppleSDKPurchaseFailure.classify(sdkReportsPending: true, receiptAfterFailure: .entitled), .purchased)
  }

  func testAnSDKFailureWithoutAReceiptStaysPendingOrFailed() {
    XCTAssertEqual(AppleSDKPurchaseFailure.classify(sdkReportsPending: true, receiptAfterFailure: .noSignal), .pending)
    XCTAssertEqual(AppleSDKPurchaseFailure.classify(sdkReportsPending: true, receiptAfterFailure: .verifiedNotEntitled), .pending)
    XCTAssertEqual(AppleSDKPurchaseFailure.classify(sdkReportsPending: false, receiptAfterFailure: .noSignal), .failed)
    // A refunded receipt is not ownership (ISS-0132 and the refund lane): the failure stands.
    XCTAssertEqual(AppleSDKPurchaseFailure.classify(sdkReportsPending: false, receiptAfterFailure: .verifiedNotEntitled), .failed)
  }
}
