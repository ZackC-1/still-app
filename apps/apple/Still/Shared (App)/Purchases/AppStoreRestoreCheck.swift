//
//  AppStoreRestoreCheck.swift
//  Shared (App)
//
//  The live StoreKit 2 half of the free-period Restore (FreePeriodRestore.swift in StillKit owns
//  the decision). Read-only by construction: it lists what this Apple Account already owns and asks
//  the App Store to bring that list up to date, and nothing else. It deliberately does not import
//  RevenueCat, so it cannot restore, sync or purchase through RevenueCat, and it holds no StoreKit
//  product, so it cannot start a purchase either. MonetizationConfigTests keeps it that way.
//

import StoreKit
import StillKit

struct AppStoreRestoreCheck: FreePeriodRestoreStore {
  func currentEntitlement(matching productIDs: Set<String>) async -> AppStoreEntitlementRead {
    var sawUnverified = false
    for await result in Transaction.currentEntitlements {
      switch result {
      case .verified(let transaction):
        // Apple already leaves revoked transactions out of this list; the check stays explicit.
        if productIDs.contains(transaction.productID), transaction.revocationDate == nil {
          return .verified
        }
      case .unverified(let transaction, _):
        if productIDs.contains(transaction.productID) { sawUnverified = true }
      }
    }
    return sawUnverified ? .unverified : .absent
  }

  func syncWithAppStore() async throws {
    try await AppStore.sync()
  }
}
