import Foundation

/// The Apple half of the paid-tier switch. The paid tier is intentionally dormant: Still includes
/// every supported blocking surface with no purchase, so `paidTierEnabled` is false and the native
/// purchase and restore bridge actions are refused. Nothing else is switched off. RevenueCat stays
/// configured, the identity model stays live, the StoreKit receipt is still read, and the App Group
/// entitlement stamp is still written, so a customer who bought earlier keeps what they own and
/// turning the switch back on is a value change rather than a rebuild.
///
/// The other half is `PAID_TIER_ENABLED` in the shared TypeScript types, which governs blocking and
/// the popup on every surface including this app's web view. The two must always agree;
/// `MonetizationConfigTests` reads both files and fails if they drift.
public enum MonetizationConfig {
  public static let paidTierEnabled = false
}
