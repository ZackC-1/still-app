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

  private func classify(cancel: Bool = false, pending: Bool = false, refusal: Bool = false, conclusive: Bool = true,
    after: ReceiptStatus) -> AppleSDKPurchaseFailure {
    AppleSDKPurchaseFailure.classify(sdkReportsCancel: cancel, sdkReportsPending: pending, sdkReportsRefusal: refusal,
      preflightConclusive: conclusive, receiptAfterFailure: after)
  }

  /// ISS-0138: the store refused before any payment (the purchase is not allowed, the payment is
  /// invalid, the product is not available, the person is ineligible). Without a receipt that is a
  /// refusal that charged nothing, never a failure to verify; with a verified receipt the receipt
  /// still decides, and the SDK's cancel or Ask-to-Buy words still win over a refusal.
  func testAStoreRefusalBeforeAnyPaymentChargedNothing() {
    for conclusive in [true, false] {
      XCTAssertEqual(classify(refusal: true, conclusive: conclusive, after: .noSignal), .refused)
      XCTAssertEqual(classify(refusal: true, conclusive: conclusive, after: .verifiedNotEntitled), .refused)
      XCTAssertEqual(classify(cancel: true, refusal: true, conclusive: conclusive, after: .noSignal), .cancelled)
      XCTAssertEqual(classify(pending: true, refusal: true, conclusive: conclusive, after: .noSignal), .pending)
    }
    XCTAssertEqual(classify(refusal: true, after: .entitled), .purchased)
    XCTAssertEqual(classify(refusal: true, conclusive: false, after: .entitled), .pending)
    // The default keeps every other store error on the receipt rule (ISS-0136).
    XCTAssertEqual(AppleSDKPurchaseFailure.classify(sdkReportsCancel: false, sdkReportsPending: false,
      preflightConclusive: true, receiptAfterFailure: .noSignal), .failed)
  }

  /// ISS-0136: the store SDK threw after Apple had completed the charge. StoreKit decides: a
  /// verified sellable receipt that a conclusive pre-flight did not see is this purchase, whatever
  /// the SDK said, even its own cancel or "approval arrives later" error.
  func testAnSDKFailureWithAVerifiedReceiptAfterAConclusivePreflightIsThisPurchase() {
    XCTAssertEqual(classify(after: .entitled), .purchased)
    XCTAssertEqual(classify(pending: true, after: .entitled), .purchased)
    XCTAssertEqual(classify(cancel: true, after: .entitled), .purchased)
  }

  /// The pre-flight timed out or met an unverifiable transaction, so the entitled receipt may be an
  /// older purchase: it is verified through the local verification, never reported as a new sale.
  func testAnEntitledReceiptAfterAnInconclusivePreflightIsVerifiedNotSold() {
    XCTAssertEqual(classify(conclusive: false, after: .entitled), .pending)
    XCTAssertEqual(classify(cancel: true, conclusive: false, after: .entitled), .pending)
    XCTAssertEqual(classify(pending: true, conclusive: false, after: .entitled), .pending)
  }

  /// Without a receipt the SDK's own words decide. The async SDK throws its cancel error on a plain
  /// cancel, so that error is a cancel, never a failure.
  func testAnSDKFailureWithoutAReceiptIsCancelledPendingOrFailed() {
    for conclusive in [true, false] {
      XCTAssertEqual(classify(cancel: true, conclusive: conclusive, after: .noSignal), .cancelled)
      XCTAssertEqual(classify(cancel: true, pending: true, conclusive: conclusive, after: .noSignal), .cancelled)
      XCTAssertEqual(classify(pending: true, conclusive: conclusive, after: .noSignal), .pending)
      XCTAssertEqual(classify(pending: true, conclusive: conclusive, after: .verifiedNotEntitled), .pending)
      XCTAssertEqual(classify(conclusive: conclusive, after: .noSignal), .failed)
      // A refunded receipt is not ownership (ISS-0132 and the refund lane): the failure stands.
      XCTAssertEqual(classify(conclusive: conclusive, after: .verifiedNotEntitled), .failed)
    }
  }
}
