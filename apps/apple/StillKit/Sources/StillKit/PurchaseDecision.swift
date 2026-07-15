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
  /// then would transfer the purchase to the wrong customer), and the entitling transaction was
  /// directly purchased (a family-shared transaction attached to a family member's account would
  /// TRANSFER the buyer's entitlement away).
  public static func attachEligible(
    currentAppUserID: String?,
    sdkAppUserID: String?,
    ownershipIsPurchased: Bool
  ) -> Bool {
    guard let user = normalized(currentAppUserID) else { return false }
    guard normalized(sdkAppUserID) == user else { return false }
    return ownershipIsPurchased
  }

  private static func normalized(_ id: String?) -> String? {
    guard let id, !id.isEmpty else { return nil }
    return id
  }
}
