import Foundation

/// The real purchase executor crosses this boundary only after receipt/offer/identity checks.
/// Every charge asks a fresh native policy question; Restore never enters this boundary.
public enum NativeSalesPurchaseBoundary {
  public static func perform<T>(policy: ProductPolicyRuntime?, unavailable: T, charge: () async -> T) async -> T {
    guard let policy, await policy.freshCheck(.sales).allowed else { return unavailable }
    return await charge()
  }
}
