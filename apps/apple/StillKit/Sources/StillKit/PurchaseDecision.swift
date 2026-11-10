import Foundation

public enum PurchaseReadiness: Equatable, Sendable {
  case proceed
  case unavailable
  case notConfigured
  /// The SDK identity is not verified anonymous while no app-level session exists — a prior
  /// sign-out's logOut may have failed, and an anonymous purchase would attribute the receipt to
  /// the stale identity (R15). The UI maps this to a retry path that re-runs reset-then-purchase.
  case staleIdentity
  case identityChanged
}

public enum PurchaseDecision {
  /// Pure pre-flight gate for a StoreKit/RevenueCat purchase or restore. The caller owns the
  /// already-entitled short-circuit (`PurchaseManager` checks the receipt and `hasStillPro()`
  /// before calling this), so this decides only: configured? identity coherent for the lane
  /// (signed-in id stable across the await, or verified-anonymous for the account-free lane)?
  /// a product actually available to buy?
  public static func readiness(
    isConfigured: Bool,
    startingAppUserID: String?,
    currentAppUserID: String?,
    packageAvailable: Bool,
    identityVerifiedAnonymous: Bool = false
  ) -> PurchaseReadiness {
    guard isConfigured else { return .notConfigured }
    guard let starting = normalized(startingAppUserID) else {
      // Account-free lane (purchase-first, R1/R2): allowed only when the SDK identity is
      // verified anonymous — never on a lingering signed-in identity (R15).
      guard identityVerifiedAnonymous else { return .staleIdentity }
      guard normalized(currentAppUserID) == nil else { return .identityChanged }
      return packageAvailable ? .proceed : .unavailable
    }
    guard normalized(currentAppUserID) == starting else { return .identityChanged }
    return packageAvailable ? .proceed : .unavailable
  }

  /// Pure eligibility gate for the attach step (RevenueCat syncPurchases; R7/AE13/AE14): the
  /// receipt may be attached to the signed-in Still account only when an app-level session
  /// exists, the SDK identity matches it (a timed-out re-key can leave them divergent — attaching
  /// then would transfer the purchase to the wrong customer), the entitling transaction was
  /// directly purchased (a family-shared transaction attached to a family member's account would
  /// TRANSFER the buyer's entitlement away), AND the receipt is currently entitled — a revoked
  /// (refunded) transaction is still `purchased` ownership, but attaching it would post a dead
  /// receipt to the account's customer.
  public static func attachEligible(
    currentAppUserID: String?,
    sdkAppUserID: String?,
    ownershipIsPurchased: Bool,
    receiptEntitled: Bool
  ) -> Bool {
    guard receiptEntitled else { return false }
    guard let user = normalized(currentAppUserID) else { return false }
    guard normalized(sdkAppUserID) == user else { return false }
    return ownershipIsPurchased
  }

  private static func normalized(_ id: String?) -> String? {
    guard let id, !id.isEmpty else { return nil }
    return id
  }
}

/// ISS-0136: what a V3 purchase the store SDK reported as thrown means once StoreKit itself is read
/// again. The SDK can throw after Apple completed the charge (its own receipt post failing is one
/// case); StoreKit is the authority, so a verified, unrevoked receipt for the sellable product is
/// what counts, whatever the SDK said:
///
/// - entitled after a pre-charge read that was conclusive (a real "no transaction" or a refund) is
///   this charge: `purchased`;
/// - entitled after a pre-charge read that timed out or was unverifiable may be an older purchase,
///   so it goes through the local verification (`pending`) and is never reported as a new sale;
/// - otherwise the SDK's own words decide: its cancel error (the async SDK throws on a plain
///   cancel instead of returning `userCancelled`) is `cancelled`, its "approval arrives later"
///   error (Ask to Buy) is `pending`, a refusal the store made before any payment (ISS-0138: the
///   purchase is not allowed on this device or account, the payment is invalid, the product is not
///   available, the person is ineligible) is `refused`, and everything else is `failed`.
///
/// `refused` is the only failure that may say nothing was charged, and it needs both the SDK's
/// word and StoreKit's: the SDK can raise the same codes from its own receipt post after Apple
/// has charged, so a refusal counts only when the receipt read after the failure was conclusive
/// (a real "no transaction" or a refund). A timed-out or unverifiable read, a store problem or a
/// network error keeps the receipt rule and the "if you were charged, Restore will find it" answer.
public enum AppleSDKPurchaseFailure: Equatable, Sendable {
  case purchased, pending, cancelled, refused, failed

  public static func classify(sdkReportsCancel: Bool, sdkReportsPending: Bool, sdkReportsRefusal: Bool = false,
    preflightConclusive: Bool, receiptAfterFailure: ReceiptStatus, afterConclusive: Bool = true) -> AppleSDKPurchaseFailure {
    if receiptAfterFailure == .entitled { return preflightConclusive ? .purchased : .pending }
    if sdkReportsCancel { return .cancelled }
    if sdkReportsPending { return .pending }
    return sdkReportsRefusal && afterConclusive ? .refused : .failed
  }
}
