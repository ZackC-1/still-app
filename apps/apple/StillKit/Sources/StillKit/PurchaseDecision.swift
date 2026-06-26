import Foundation

public enum PurchaseReadiness: Equatable, Sendable {
  case proceed
  case alreadyEntitled
  case unavailable
  case notConfigured
  case identityChanged
}

public enum PurchaseDecision {
  public static func readiness(
    isConfigured: Bool,
    startingAppUserID: String?,
    currentAppUserID: String?,
    alreadyEntitled: Bool,
    packageAvailable: Bool
  ) -> PurchaseReadiness {
    guard isConfigured, let startingAppUserID, !startingAppUserID.isEmpty else {
      return .notConfigured
    }
    guard currentAppUserID == startingAppUserID else {
      return .identityChanged
    }
    if alreadyEntitled {
      return .alreadyEntitled
    }
    return packageAvailable ? .proceed : .unavailable
  }
}

