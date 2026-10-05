import Foundation

/// The Apple half of the paid-tier switch. The paid tier is intentionally dormant: Still includes
/// every supported blocking surface with no purchase, so `paidTierEnabled` is false, the native
/// purchase bridge action is refused, and the restore action runs only the read-only App Store
/// check in `FreePeriodRestore` (never RevenueCat). Nothing else is switched off. RevenueCat stays
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
