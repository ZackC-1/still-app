import Foundation

/// Apple-side counterpart to the shared TypeScript paid-tier switch. RevenueCat identity,
/// receipt reads, and App Group entitlement stamping stay active while this is false. Only native
/// purchase and restore bridge actions are refused, keeping the preserved paid path reversible.
public enum MonetizationConfig {
  public static let paidTierEnabled = false
}
