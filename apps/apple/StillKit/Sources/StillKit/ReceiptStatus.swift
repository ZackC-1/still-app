import Foundation

/// The device receipt oracle's verdict for the Still Pro product, as read by the APP TARGET from
/// StoreKit 2 (`Transaction.latest(for:)` — NOT `currentEntitlements`, which excludes revoked
/// transactions and would make refunds unobservable). StillKit never performs StoreKit I/O; it
/// receives this value and owns the decisions built on it (ADR 0003).
///
/// Tri-state is load-bearing: an empty or unverifiable ledger (cold cache, offline first launch,
/// hung read past the settle deadline) is `noSignal`, never `verifiedNotEntitled` — treating
/// absence as "not entitled" would mass-downgrade cold-cache devices. Only a verified transaction
/// with a revocation date produces `verifiedNotEntitled`.
public enum ReceiptStatus: String, Sendable, Equatable {
  /// A verified, unrevoked transaction for the product exists on this device's Apple Account.
  case entitled
  /// A verified transaction exists but carries a revocation date (refund / support revocation).
  case verifiedNotEntitled
  /// No transaction observed, or the read was unverifiable/timed out. Never downgrades.
  case noSignal
}
