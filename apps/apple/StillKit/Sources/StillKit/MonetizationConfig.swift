import Foundation

/// The Apple half of the paid-tier switch. The 3.x release line declares the paid tier on (Still
/// Pro: optional extras sold once); the four free protections and optional sync stay free. Native
/// purchase still needs the server's remote sales policy to admit it, so this value alone sells
/// nothing. With it false, the native purchase bridge action is refused and the restore action runs
/// only the read-only App Store check in `FreePeriodRestore` (never RevenueCat). Either way
/// RevenueCat stays configured, the identity model stays live, the StoreKit receipt is still read,
/// and the App Group entitlement stamp is still written, so a customer who bought earlier keeps
/// what they own.
///
/// The other half is `PAID_TIER_ENABLED` in the shared TypeScript types, which governs blocking and
/// the popup on every surface including this app's web view. The two must always agree;
/// `MonetizationConfigTests` reads both files and fails if they drift.
public enum MonetizationConfig {
  public static let paidTierEnabled = true
}
