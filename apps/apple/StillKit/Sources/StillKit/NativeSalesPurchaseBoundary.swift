import Foundation

/// Apple's verified installation environment (StoreKit `AppTransaction.environment`), or
/// `unavailable` when it cannot be read, is unverified, times out or the OS predates the API.
public enum AppleInstallEnvironment: Sendable, Equatable {
  case production, sandbox, xcode, unavailable

  /// Only Apple's sandbox and Xcode environments can never take a real payment.
  public var cannotTakeRealPayment: Bool { self == .sandbox || self == .xcode }
}

/// The real purchase executor crosses this boundary only after receipt/offer/identity checks.
/// Every charge asks a fresh native policy question; Restore never enters this boundary.
/// A sandbox build also requires Apple's verified sandbox or Xcode installation before charging,
/// so a QA package that somehow runs as an App Store installation can never take a real payment.
/// There is no fallback: unknown installation refuses the charge.
public enum NativeSalesPurchaseBoundary {
  public static func perform<T>(policy: ProductPolicyRuntime?, unavailable: T,
                                installEnvironment: () async -> AppleInstallEnvironment = { .unavailable },
                                charge: () async -> T) async -> T {
    guard let policy, await policy.freshCheck(.sales).allowed else { return unavailable }
    if policy.requiresSandboxInstallation {
      guard (await installEnvironment()).cannotTakeRealPayment else { return unavailable }
      // Apple's answer can take longer than a fresh approval lasts, so ask again before charging.
      guard await policy.freshCheck(.sales).allowed else { return unavailable }
    }
    return await charge()
  }
}
