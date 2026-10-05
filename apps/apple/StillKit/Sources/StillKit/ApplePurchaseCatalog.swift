import Foundation

/// One Apple in-app purchase product and the RevenueCat identifiers that unlock it.
public struct ApplePurchaseProduct: Equatable, Sendable {
  public enum Role: String, Equatable, Sendable {
    /// The product a future, separately approved paid activation offers for sale.
    case currentOffer
    /// A product that is no longer sold but whose past purchases must keep resolving.
    case historical
  }

  /// The App Store Connect product identifier. Apple never lets it be renamed or reused.
  public let productID: String
  /// The RevenueCat entitlement identifier this product unlocks.
  public let entitlementID: String
  public let role: Role
  /// The RevenueCat offering and package that present this product, or nil when the product is
  /// not presented by this app (the historical product keeps its existing dashboard setup).
  public let offeringID: String?
  public let packageID: String?
  /// The frozen purchased package a verified purchase of this product grants, or nil when the
  /// purchase-rights contract decides the grant only after verifying the purchase's history.
  public let grantedPackage: String?

  public var isSellable: Bool { role == .currentOffer }
}

/// The single source of truth for the Apple app's purchase product identifiers.
///
/// Two products must always resolve:
///
/// - `stillProV3` is the new one-time Still Pro product. A verified purchase grants the frozen
///   `still-pro-v3` package. It has its own entitlement, so the historical entitlement can never
///   be mistaken for a new purchase (and the reverse). The paid tier stays dormant
///   (`MonetizationConfig.paidTierEnabled`), so nothing offers it for sale yet.
/// - `historicalStillSync` is the 2.x product, removed from sale. Its product and entitlement ids
///   stay `still_sync` forever: past buyers' rights, the Supabase webhook and the database all key
///   on them. It is never sold, renamed or repriced again. Its grant is deliberately nil because an
///   active `still_sync` entitlement alone proves neither a genuine historical payment nor new Pro
///   ownership; the purchase-rights resolver decides that after verification.
///
/// `Still.storekit` (local simulator testing only) lists exactly these products, and
/// `ApplePurchaseCatalogTests` fails if the two drift or if a release build could pick it up.
public enum ApplePurchaseCatalog {
  public static let stillProV3 = ApplePurchaseProduct(
    productID: "still_pro_v3",
    entitlementID: "still_pro_v3",
    role: .currentOffer,
    offeringID: "still_pro_v3",
    packageID: "$rc_lifetime",
    grantedPackage: "still-pro-v3"
  )

  public static let historicalStillSync = ApplePurchaseProduct(
    productID: "still_sync",
    entitlementID: "still_sync",
    role: .historical,
    offeringID: nil,
    packageID: nil,
    grantedPackage: nil
  )

  public static let all: [ApplePurchaseProduct] = [stillProV3, historicalStillSync]

  /// Exact, case-sensitive lookup; an unknown identifier resolves to nothing rather than a guess.
  public static func product(forProductID productID: String) -> ApplePurchaseProduct? {
    all.first { $0.productID == productID }
  }

  /// Exact, case-sensitive lookup; an unknown identifier resolves to nothing rather than a guess.
  public static func product(forEntitlementID entitlementID: String) -> ApplePurchaseProduct? {
    all.first { $0.entitlementID == entitlementID }
  }
}
