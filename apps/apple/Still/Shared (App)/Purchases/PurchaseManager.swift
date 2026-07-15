//
//  PurchaseManager.swift
//  Shared (App)
//
//  The native StoreKit 2 / RevenueCat purchase layer for Still Pro (U19, reworked for
//  purchase-first — plan 2026-07-15-001). RevenueCat is configured ANONYMOUSLY at app launch so a
//  signed-out user can buy (Guideline 5.1.1(v)); when the webview establishes a Supabase session it
//  re-keys the identity via `configure(appUserID:)` (KTD5 timing moves to sign-in; its trust model
//  is unchanged). The device's StoreKit 2 receipt — read via `Transaction.latest(for:)`, which
//  observes revocations that `currentEntitlements` hides — is the identity-independent entitlement
//  authority; RevenueCat remains the purchase executor and webhook source (ADR 0003).
//
//  Entitlement gates (do not conflate):
//    • DEVICE receipt authority: `refreshReceiptStatus()` → the App Group stamp via StampPolicy.
//    • LOCAL purchase feedback: RevenueCat `CustomerInfo` (immediate, this file).
//    • CROSS-DEVICE SYNC: the Supabase entitlement written by the webhook — owned by the web
//      SyncService. A purchase acknowledges success at once; account-linked authority follows once
//      the (optional) sign-in attaches the receipt and the webhook lands.
//

import Foundation
import RevenueCat
import StoreKit
import StillKit

/// The app target's cached receipt snapshot — the synchronous provider EntitlementBridge's stamp
/// policy consumes (StoreKit reads are async; freshness is owned by the refresh sites: launch,
/// foreground, post-purchase, post-restore, and the blocked-write re-read). Thread-safe and
/// file-scope so the non-isolated bridge closure can read it without MainActor hops.
final class ReceiptStatusCache: @unchecked Sendable {
  private let lock = NSLock()
  private var value: ReceiptStatus = .noSignal
  var current: ReceiptStatus {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
  func set(_ newValue: ReceiptStatus) {
    lock.lock()
    defer { lock.unlock() }
    value = newValue
  }
}

let stillReceiptStatusCache = ReceiptStatusCache()

/// Resume-at-most-once guard — a double completion would be a fatal SWIFT TASK CONTINUATION
/// MISUSE. Shared by the settle-deadline helpers below.
private final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var done = false
  func run(_ body: () -> Void) {
    lock.lock()
    defer { lock.unlock() }
    guard !done else { return }
    done = true
    body()
  }
}

/// One receipt read: the tri-state verdict plus whether the entitling transaction was directly
/// purchased (vs family-shared — load-bearing for attach eligibility, AE14).
struct ReceiptRead: Sendable, Equatable {
  let status: ReceiptStatus
  let ownershipIsPurchased: Bool
}

@MainActor
final class PurchaseManager {
  static let shared = PurchaseManager()

  /// The single non-consumable product + its RevenueCat entitlement id (match Still.storekit, the
  /// App Store Connect product, and the RevenueCat entitlement). The user-facing name is "Still
  /// Pro"; these INTERNAL ids stay `still_sync` — the ASC product id is immutable and the deployed
  /// webhook/DB derive entitlement from this exact key (monetization-design §5: do NOT rename).
  static let productID = "still_sync"
  static let entitlementID = "still_sync"

  private(set) var isConfigured = false

  /// The Supabase UUID RevenueCat is currently keyed to (KTD5), or nil when signed out / anonymous.
  /// Account-bound calls (attach) reject when this is nil; the account-free purchase lane instead
  /// requires a VERIFIED anonymous SDK identity (R15) so a stale identity can't absorb a receipt.
  private(set) var currentAppUserID: String?

  /// Last bounded receipt read (also mirrored into `stillReceiptStatusCache` for the bridge).
  private(set) var lastReceiptRead = ReceiptRead(status: .noSignal, ownershipIsPurchased: false)

  private init() {}

  /// The RevenueCat public SDK key, injected from Config/Secrets.xcconfig via Info.plist. Empty on a
  /// fresh clone with no Secrets.local.xcconfig — we then skip configuration rather than crash.
  private var publicAPIKey: String {
    (Bundle.main.object(forInfoDictionaryKey: "RevenueCatPublicAPIKey") as? String) ?? ""
  }

  /// Bound on how long an identity transition or StoreKit read may hold the bridge:
  /// WKScriptMessageHandlerWithReply has no built-in timeout, so a completion that never fires
  /// would otherwise hang the web layer's promise forever — and a hung launch receipt read would
  /// defer install-id publication and startup indefinitely (R16). Matches the web side's 8s
  /// edge-call ceiling (EDGE_FN_TIMEOUT_MS).
  private static let identityTransitionTimeoutNs: UInt64 = 8_000_000_000

  /// Await an SDK completion with a resume-once guard and the deadline above. Returns the
  /// completion's success flag; the deadline path counts as failure (unknown ≠ settled), so
  /// callers can fail CLOSED on an identity transition that never confirmably landed.
  private static func awaitSettled(_ start: @escaping (@escaping (Bool) -> Void) -> Void) async -> Bool {
    let once = Once()
    return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      start { succeeded in once.run { continuation.resume(returning: succeeded) } }
      Task {
        try? await Task.sleep(nanoseconds: identityTransitionTimeoutNs)
        once.run { continuation.resume(returning: false) } // deadline: settle the bridge, fail closed
      }
    }
  }

  /// Configure RevenueCat ANONYMOUSLY at app launch (purchase-first, R1/R2). Runs synchronously in
  /// viewDidLoad BEFORE the webview loads, so a stored-session boot's `configurePurchases(uuid)`
  /// can only ever take the `logIn` re-key branch — a racing second configure would replace the
  /// SDK singleton and drop in-flight completions. Idempotent after the first call.
  func configure() {
    let key = publicAPIKey
    guard !key.isEmpty else {
      NSLog("PurchaseManager: RevenueCat key unset (Config/Secrets.local.xcconfig) — purchase disabled")
      return
    }
    guard !isConfigured else { return }
    Purchases.logLevel = .warn
    Purchases.configure(with: Configuration.Builder(withAPIKey: key).build())
    isConfigured = true
  }

  /// Re-key RevenueCat to a signed-in user (KTD5: appUserID = Supabase UUID). Safe to call
  /// repeatedly. Awaitable so the bridge only acknowledges once the identity transition settled —
  /// replying before `logIn` completes would let the web layer purchase while RevenueCat is still
  /// keyed to the previous identity. A failed/unconfirmed re-key CLEARS the configured identity
  /// (fail closed): account-bound calls stay disabled until a later configure succeeds.
  func configure(appUserID: String) async {
    let key = publicAPIKey
    guard !key.isEmpty else {
      NSLog("PurchaseManager: RevenueCat key unset (Config/Secrets.local.xcconfig) — purchase disabled")
      return
    }
    currentAppUserID = appUserID
    if !isConfigured {
      // Launch configure was skipped (should not happen in production ordering) — configure
      // directly with the identity rather than anonymous-then-login.
      Purchases.logLevel = .warn
      Purchases.configure(with: Configuration.Builder(withAPIKey: key).with(appUserID: appUserID).build())
      isConfigured = true
      return
    }
    let rekeyed = await Self.awaitSettled { done in
      Purchases.shared.logIn(appUserID) { _, _, error in done(error == nil) }
    }
    if !rekeyed, currentAppUserID == appUserID {
      NSLog("PurchaseManager: RevenueCat re-key failed/timed out — account calls disabled until re-entry")
      currentAppUserID = nil // fail closed, unless a newer configure already took over
    }
  }

  /// Reset the RevenueCat identity on sign-out: log out of the current app_user_id and clear it
  /// FIRST (synchronously — the attach guard reads it, AE13), so nothing here can act against the
  /// previous account. `logOut` yields a fresh anonymous identity; receipt-derived Pro survives
  /// through the App Group stamp (never via a post-logOut syncPurchases, which would TRANSFER the
  /// purchase to the fresh anonymous customer).
  func reset() async {
    currentAppUserID = nil
    guard isConfigured else { return }
    _ = await Self.awaitSettled { done in
      Purchases.shared.logOut { _, error in done(error == nil) }
    }
  }

  /// Whether Still Pro is active per RevenueCat — the immediate purchase-feedback gate only.
  /// Anonymous customers legitimately own entitlements now (purchase-first), so this gates only on
  /// the SDK being configured; a post-sign-out probe sees a fresh anonymous customer (no history).
  func hasStillPro() async -> Bool {
    guard isConfigured else { return false }
    let info = try? await Purchases.shared.customerInfo()
    return info?.entitlements[Self.entitlementID]?.isActive == true
  }

  /// The localized store price for still_sync (e.g. "$1.99" / "£1.99"), or nil if the offering
  /// isn't available. Anonymous offerings are first-class (the signed-out paywall shows this).
  func priceString() async -> String? {
    await stillProPackage()?.storeProduct.localizedPriceString
  }

  /// The current offering's still_sync package, or nil. Deliberately NO fallback to "the first
  /// package": if the offering is misconfigured, an arbitrary package could charge the user for the
  /// wrong product. nil flows to the `.unavailable` outcome instead.
  private func stillProPackage() async -> Package? {
    guard isConfigured else { return nil }
    let offerings = try? await Purchases.shared.offerings()
    let packages = offerings?.current?.availablePackages ?? []
    return packages.first { $0.storeProduct.productIdentifier == Self.productID }
  }

  // MARK: - Receipt oracle (StoreKit 2, identity-independent — ADR 0003)

  /// One bounded receipt read: `Transaction.latest(for:)` (NOT `currentEntitlements` — revoked
  /// transactions disappear from that sequence, which would make refunds unobservable and AE6
  /// unimplementable). Verified + unrevoked → entitled; verified + revocationDate →
  /// verifiedNotEntitled; nil/unverified/timeout → noSignal (absence is never a downgrade signal).
  private static func boundedReceiptRead() async -> ReceiptRead {
    let once = Once()
    return await withCheckedContinuation { (continuation: CheckedContinuation<ReceiptRead, Never>) in
      Task {
        let read: ReceiptRead
        switch await Transaction.latest(for: productID) {
        case .some(.verified(let transaction)):
          read = ReceiptRead(
            status: transaction.revocationDate == nil ? .entitled : .verifiedNotEntitled,
            ownershipIsPurchased: transaction.ownershipType == .purchased)
        case .some(.unverified), .none:
          read = ReceiptRead(status: .noSignal, ownershipIsPurchased: false)
        }
        once.run { continuation.resume(returning: read) }
      }
      Task {
        try? await Task.sleep(nanoseconds: identityTransitionTimeoutNs)
        once.run {
          continuation.resume(returning: ReceiptRead(status: .noSignal, ownershipIsPurchased: false))
        }
      }
    }
  }

  /// Refresh the cached receipt snapshot (launch, foreground, post-purchase, post-restore, and the
  /// blocked-write re-read are the call sites). Mirrors into `stillReceiptStatusCache` for the
  /// bridge's synchronous policy provider and returns the fresh status.
  @discardableResult
  func refreshReceiptStatus() async -> ReceiptStatus {
    let read = await Self.boundedReceiptRead()
    lastReceiptRead = read
    stillReceiptStatusCache.set(read.status)
    return read.status
  }

  /// Verify the SDK identity is genuinely anonymous before an account-free purchase/restore (R15):
  /// a failed prior logOut can leave RevenueCat keyed to a departed account, and a new buyer's
  /// receipt would attach to it. Retries the logOut once; still-not-anonymous maps to the
  /// `.staleIdentity` outcome upstream.
  private func ensureAnonymousIdentity() async -> Bool {
    guard isConfigured, currentAppUserID == nil else { return false }
    if Purchases.shared.isAnonymous { return true }
    _ = await Self.awaitSettled { done in
      Purchases.shared.logOut { _, error in done(error == nil) }
    }
    return Purchases.shared.isAnonymous
  }

  enum Outcome: Equatable {
    case purchased
    case cancelled
    case pending // store accepted but entitlement not yet active (e.g. ask-to-buy)
    case unavailable // no offering / product not available right now
    case staleIdentity // signed out but the SDK identity is not verifiably anonymous (R15)
    case failed(String)
  }

  /// Buy Still Pro — signed in OR signed out (purchase-first, R1). The returned `.purchased`
  /// acknowledges local StoreKit/RevenueCat success; the caller (router) refreshes the receipt and
  /// restamps the App Group so Safari unlocks immediately (R5).
  func purchaseStillPro() async -> Outcome {
    let startingUserID = currentAppUserID
    // Receipt pre-flight (R14): a device that provably owns Pro never re-enters the purchase or
    // restore machinery — under default transfer semantics a RevenueCat receipt-post from a fresh
    // identity would move the entitlement OFF the account it is attached to.
    if await refreshReceiptStatus() == .entitled { return .purchased }
    if await hasStillPro() { return .purchased } // already unlocked on this identity; never double-charge
    let verifiedAnonymous = startingUserID == nil ? await ensureAnonymousIdentity() : false
    let package = await stillProPackage()
    switch PurchaseDecision.readiness(
      isConfigured: isConfigured,
      startingAppUserID: startingUserID,
      currentAppUserID: currentAppUserID,
      packageAvailable: package != nil,
      identityVerifiedAnonymous: verifiedAnonymous
    ) {
    case .proceed:
      break
    case .unavailable:
      return .unavailable
    case .notConfigured:
      return .failed("not configured")
    case .staleIdentity:
      return .staleIdentity
    case .identityChanged:
      return .failed("identity changed")
    }
    guard let package else { return .unavailable }
    do {
      let result = try await Purchases.shared.purchase(package: package)
      if result.userCancelled { return .cancelled }
      return result.customerInfo.entitlements[Self.entitlementID]?.isActive == true ? .purchased : .pending
    } catch {
      if let rcError = error as? RevenueCat.ErrorCode, rcError == .paymentPendingError {
        return .pending // Ask-to-Buy: guardian approval arrives out-of-band
      }
      return .failed(error.localizedDescription)
    }
  }

  /// Restore purchases (the visible restore affordance, R4) — works signed out. Pre-flights the
  /// receipt (R14): when the device already owns Pro, succeed WITHOUT calling RevenueCat restore,
  /// whose transfer semantics would strip the entitlement from whichever account it is attached
  /// to. Only receipt-negative devices (true recovery) reach RevenueCat.
  func restore() async -> Bool {
    let startingUserID = currentAppUserID
    if await refreshReceiptStatus() == .entitled { return true }
    if await hasStillPro() { return true }
    let verifiedAnonymous = startingUserID == nil ? await ensureAnonymousIdentity() : false
    guard PurchaseDecision.readiness(
      isConfigured: isConfigured,
      startingAppUserID: startingUserID,
      currentAppUserID: currentAppUserID,
      packageAvailable: true,
      identityVerifiedAnonymous: verifiedAnonymous
    ) == .proceed else { return false }
    let info = try? await Purchases.shared.restorePurchases()
    return info?.entitlements[Self.entitlementID]?.isActive == true
  }

  /// Attach the device receipt to the signed-in Still account (R7 — RevenueCat syncPurchases).
  /// Guarded by the pure eligibility gate: session present, SDK identity EQUAL to it (a timed-out
  /// re-key can leave them divergent — attaching then would transfer the purchase to the wrong
  /// customer, AE13), and the transaction directly purchased (family-shared never transfers the
  /// buyer's entitlement to a family member's account, AE14).
  func attachPurchases() async -> Bool {
    guard isConfigured else { return false }
    let read = await Self.boundedReceiptRead()
    guard PurchaseDecision.attachEligible(
      currentAppUserID: currentAppUserID,
      sdkAppUserID: Purchases.shared.appUserID,
      ownershipIsPurchased: read.ownershipIsPurchased
    ) else { return false }
    let info = try? await Purchases.shared.syncPurchases()
    return info?.entitlements[Self.entitlementID]?.isActive == true
  }
}
