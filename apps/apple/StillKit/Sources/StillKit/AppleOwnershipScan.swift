import Foundation

/// The device-only Apple ownership scan behind the app's benefit read. The app target supplies the
/// StoreKit ports (`Transaction.latest(for:)` per product and `Transaction.currentEntitlements`);
/// this decides what they add up to, so the rule is testable without StoreKit.
///
/// The current-entitlements sequence omits refunds: publish verified history before reading it.
/// Ports return only observations produced by the native StoreKit verification adapter.
///
/// `products` are the products whose purchase on this device counts as Still Pro history
/// (`ApplePurchaseCatalog.deviceProofProducts`). `revocationOnly` products (the historical
/// `still_sync`) are read only so a verified refund of one is still published through
/// `onVerifiedRevocation`; their purchases, refunds and unverified answers never change the
/// answer (ISS-0132). A historical-only device therefore reads as no purchases, so its Still Pro
/// rows are locked like a non-buyer's rather than held at "verify again".
@MainActor
public enum AppleOwnershipScan {
  public static func run(products: [String], revocationOnly: [String] = [],
    latest: (String) async -> NativeAppleOwnershipObservation,
    current: () async -> NativeAppleOwnershipObservation,
    onVerifiedRevocation: (NativeVerifiedAppleRevocation) -> Void) async -> NativeAppleOwnershipObservation {
    var history = false, uncertain = false
    var revocations: [NativeVerifiedAppleRevocation] = []
    func consume(_ observation: NativeAppleOwnershipObservation) {
      switch observation {
      case .unknown: uncertain = true
      case .purchaseHistory: history = true
      case .verifiedRevocations(let verified):
        history = true
        for revocation in verified { revocations.append(revocation); onVerifiedRevocation(revocation) }
      case .noPurchases: break
      }
    }
    for product in products {
      if Task.isCancelled { return revocations.isEmpty ? .unknown : .verifiedRevocations(revocations) }
      consume(await latest(product))
    }
    for product in revocationOnly {
      if Task.isCancelled { break }
      if case .verifiedRevocations(let verified) = await latest(product) {
        for revocation in verified { onVerifiedRevocation(revocation) }
      }
    }
    // Known removal is sufficient. A slow currentEntitlements must never delay its publication.
    if !revocations.isEmpty { return .verifiedRevocations(revocations) }
    if Task.isCancelled { return .unknown }
    consume(await current())
    if !revocations.isEmpty { return .verifiedRevocations(revocations) }
    return uncertain ? .unknown : history ? .purchaseHistory : .noPurchases
  }
}
