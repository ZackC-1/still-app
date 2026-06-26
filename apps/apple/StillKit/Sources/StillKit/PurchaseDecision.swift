import Foundation

public enum PurchaseReadiness: Equatable, Sendable {
  case proceed
  case unavailable
  case notConfigured
  case identityChanged
}

public enum PurchaseDecision {
  /// Pure pre-flight gate for a StoreKit/RevenueCat purchase or restore. The caller owns the
  /// already-entitled short-circuit (`PurchaseManager` checks `hasStillSync()` before calling this),
  /// so this decides only: configured with a real user id? identity stable across the await? a
  /// product actually available to buy?
  public static func readiness(
    isConfigured: Bool,
    startingAppUserID: String?,
    currentAppUserID: String?,
    packageAvailable: Bool
  ) -> PurchaseReadiness {
    guard isConfigured, let startingAppUserID, !startingAppUserID.isEmpty else {
      return .notConfigured
    }
    guard currentAppUserID == startingAppUserID else {
      return .identityChanged
    }
    return packageAvailable ? .proceed : .unavailable
  }
}

