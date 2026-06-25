//
//  PurchaseManager.swift
//  Shared (App)
//
//  The native StoreKit 2 / RevenueCat purchase layer for Still Sync (U19). RevenueCat is configured
//  ONLY after sign-in, with the Supabase user UUID as the app_user_id (KTD5) — never anonymously —
//  so a purchase is always tied to the account the RevenueCat→Supabase webhook (U14) projects the
//  entitlement onto. The shipped UI gates the buy CTA on a signed-in session; this type assumes that
//  and refuses to configure without a UUID.
//
//  Two distinct entitlement gates (do not conflate):
//    • LOCAL UI feedback gates on RevenueCat `CustomerInfo` (immediate, this file).
//    • CROSS-DEVICE SYNC gates on the Supabase entitlement written by the webhook — owned by the web
//      SyncService, never by client `CustomerInfo`. So a purchase here unlocks the local UI at once,
//      and sync follows once the webhook lands and the WebView reconciles.
//

import Foundation
import RevenueCat
import StillKit

@MainActor
final class PurchaseManager {
  static let shared = PurchaseManager()

  /// The single non-consumable product + its RevenueCat entitlement id (match Still.storekit and the
  /// planned App Store Connect product / RevenueCat entitlement).
  static let productID = "still_sync"
  static let entitlementID = "still_sync"

  private(set) var isConfigured = false

  /// The Supabase UUID RevenueCat is currently keyed to (KTD5), or nil when signed out / never
  /// configured. Privileged purchase/restore/status calls reject when this is nil, so a stale or
  /// malicious bridge caller can't act against a previous account after sign-out.
  private(set) var currentAppUserID: String?

  private init() {}

  /// The RevenueCat public SDK key, injected from Config/Secrets.xcconfig via Info.plist. Empty on a
  /// fresh clone with no Secrets.local.xcconfig — we then skip configuration rather than crash.
  private var publicAPIKey: String {
    (Bundle.main.object(forInfoDictionaryKey: "RevenueCatPublicAPIKey") as? String) ?? ""
  }

  /// Configure RevenueCat for a signed-in user (KTD5: appUserID = Supabase UUID, never anonymous).
  /// Safe to call repeatedly; logs in to re-key on an account switch / restore once configured.
  func configure(appUserID: String) {
    let key = publicAPIKey
    guard !key.isEmpty else {
      NSLog("PurchaseManager: RevenueCat key unset (Config/Secrets.local.xcconfig) — purchase disabled")
      return
    }
    currentAppUserID = appUserID
    if isConfigured {
      Purchases.shared.logIn(appUserID) { _, _, _ in } // account-switch / restore recovery path
      return
    }
    Purchases.logLevel = .warn
    Purchases.configure(with: Configuration.Builder(withAPIKey: key).with(appUserID: appUserID).build())
    isConfigured = true
  }

  /// Reset the RevenueCat identity on sign-out: log out of the current app_user_id and clear it, so
  /// nothing here can act against the previous account until a new session reconfigures. Safe to call
  /// when unconfigured (just clears the id). Pairs with the web sign-out (NativeBridge `signOut`).
  func reset() {
    currentAppUserID = nil
    guard isConfigured else { return }
    Purchases.shared.logOut { _, _ in } // back to an anonymous RevenueCat id; no entitlements
  }

  /// Whether Still Sync is active per RevenueCat — the immediate LOCAL-UI gate only. Rejects when no
  /// user is configured (signed out), so a stale bridge caller can't probe a previous account.
  func hasStillSync() async -> Bool {
    guard isConfigured, currentAppUserID != nil else { return false }
    let info = try? await Purchases.shared.customerInfo()
    return info?.entitlements[Self.entitlementID]?.isActive == true
  }

  /// The localized store price for still_sync (e.g. "$2.99" / "£2.99"), or nil if the offering isn't
  /// available. The paywall shows this instead of a hardcoded price (App Store / StoreKit guidance).
  func priceString() async -> String? {
    await stillSyncPackage()?.storeProduct.localizedPriceString
  }

  /// The current offering's package for still_sync (falling back to the first available package).
  private func stillSyncPackage() async -> Package? {
    guard isConfigured, currentAppUserID != nil else { return nil }
    let offerings = try? await Purchases.shared.offerings()
    let packages = offerings?.current?.availablePackages ?? []
    return packages.first { $0.storeProduct.productIdentifier == Self.productID } ?? packages.first
  }

  enum Outcome: Equatable {
    case purchased
    case cancelled
    case pending // store accepted but entitlement not yet active (e.g. ask-to-buy)
    case unavailable // no offering / product not available right now
    case failed(String)
  }

  /// Buy Still Sync. The returned `.purchased` unlocks the LOCAL UI immediately; cross-device sync
  /// follows when the webhook writes the Supabase entitlement and the WebView reconciles.
  func purchaseStillSync() async -> Outcome {
    guard isConfigured, currentAppUserID != nil else { return .failed("not configured") }
    guard let package = await stillSyncPackage() else { return .unavailable }
    do {
      let result = try await Purchases.shared.purchase(package: package)
      if result.userCancelled { return .cancelled }
      return result.customerInfo.entitlements[Self.entitlementID]?.isActive == true ? .purchased : .pending
    } catch {
      return .failed(error.localizedDescription)
    }
  }

  /// Restore purchases (the visible restore affordance, R8). Returns whether Still Sync is now active.
  func restore() async -> Bool {
    guard isConfigured, currentAppUserID != nil else { return false }
    let info = try? await Purchases.shared.restorePurchases()
    return info?.entitlements[Self.entitlementID]?.isActive == true
  }
}
