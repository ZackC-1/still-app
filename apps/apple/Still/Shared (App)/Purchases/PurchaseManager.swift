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
//  RevenueCat remains configured while the paid tier is dormant. WebBridgeRouter refuses the native
//  purchase action and sends the restore action to the read-only StoreKit check in
//  AppStoreRestoreCheck.swift instead of `restore()` below; identity, receipt observation, and
//  entitlement stamping stay live so a future switch change does not require rebuilding this
//  integration.
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
  var productID: String? = nil
}

/// The current-entitlements sequence omits refunds: publish verified history before reading it.
/// Ports return only observations produced by the native StoreKit verification adapter below.
@MainActor
enum AppleOwnershipScan {
  static func run(products: [String], latest: (String) async -> NativeAppleOwnershipObservation,
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
    // Known removal is sufficient. A slow currentEntitlements must never delay its publication.
    if !revocations.isEmpty { return .verifiedRevocations(revocations) }
    if Task.isCancelled { return .unknown }
    consume(await current())
    if !revocations.isEmpty { return .verifiedRevocations(revocations) }
    return uncertain ? .unknown : history ? .purchaseHistory : .noPurchases
  }
}

@MainActor
final class PurchaseManager {
  static let shared = PurchaseManager()

  /// The SELLABLE product + its RevenueCat entitlement id, read from the single
  /// `ApplePurchaseCatalog` (which `Still.storekit` mirrors). The user-facing name is "Still Pro".
  /// Only `stillProV3` may be offered, purchased, or priced: the historical product below is
  /// restorable, never sold (U16-W2).
  static let productID = ApplePurchaseCatalog.stillProV3.productID
  static let entitlementID = ApplePurchaseCatalog.stillProV3.entitlementID

  /// Every product id a past purchase can be restored from: the sellable product plus the
  /// historical 2.x product (whose ASC id is immutable). `Transaction.latest(for:)` takes a
  /// single id, so the receipt read checks each of these — one sellable id cannot also cover
  /// past buyers.
  static let restorableProductIDs: Set<String> = [
    ApplePurchaseCatalog.stillProV3.productID,
    ApplePurchaseCatalog.historicalStillSync.productID,
  ]

  /// Every RevenueCat entitlement id that unlocks Still Pro: the sellable one plus the
  /// historical one. CustomerInfo checks accept either, so historical buyers keep Pro while
  /// every new purchase grants the sellable entitlement only.
  static let restorableEntitlementIDs: [String] = [
    ApplePurchaseCatalog.stillProV3.entitlementID,
    ApplePurchaseCatalog.historicalStillSync.entitlementID,
  ]

  private(set) var isConfigured = false

  /// The Supabase UUID RevenueCat is currently keyed to (KTD5), or nil when signed out / anonymous.
  /// Account-bound calls (attach) reject when this is nil; the account-free purchase lane instead
  /// requires a VERIFIED anonymous SDK identity (R15) so a stale identity can't absorb a receipt.
  private(set) var currentAppUserID: String?

  /// Last bounded receipt read (also mirrored into `stillReceiptStatusCache` for the bridge).
  private(set) var lastReceiptRead = ReceiptRead(status: .noSignal, ownershipIsPurchased: false)
  /// Held until StoreKit itself settles, even if the web reply reaches its deadline first.
  private var modernPurchaseInFlight: Task<ApplePurchaseActionResult, Never>?

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
  private nonisolated static let identityTransitionTimeoutNs: UInt64 = 8_000_000_000

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

  private static func bounded<T>(_ deadline: UInt64 = identityTransitionTimeoutNs, fallback: T,
    cancelOnTimeout: Bool = false, _ operation: @escaping @MainActor () async -> T) async -> T {
    let once = Once()
    let operationTask = Task { @MainActor in await operation() }
    return await withCheckedContinuation { continuation in
      Task { @MainActor in
        let result = await operationTask.value
        once.run { continuation.resume(returning: result) }
      }
      Task {
        try? await Task.sleep(nanoseconds: deadline)
        once.run {
          if cancelOnTimeout { operationTask.cancel() }
          continuation.resume(returning: fallback)
        }
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
    return Self.proEntitlementIsActive(in: info)
  }

  /// Whether RevenueCat reports Still Pro on the sellable entitlement or the historical one.
  /// Historical buyers keep Pro; every new purchase lands on the sellable entitlement.
  private static func proEntitlementIsActive(in customerInfo: CustomerInfo?) -> Bool {
    restorableEntitlementIDs.contains { customerInfo?.entitlements[$0]?.isActive == true }
  }

  /// The localized store price for the sellable Still Pro product, or nil if the offering
  /// isn't available. Anonymous offerings are first-class (the signed-out paywall shows this).
  func priceString() async -> String? {
    await stillProPackage()?.storeProduct.localizedPriceString
  }

  /// The current offering's package for the SELLABLE product, or nil. Deliberately NO fallback
  /// to "the first package": if the offering is misconfigured, an arbitrary package could
  /// charge the user for the wrong product. An offering holding only the historical product
  /// resolves to nil here, which flows to the `.unavailable` outcome — never a purchase.
  private func stillProPackage() async -> Package? {
    guard isConfigured else { return nil }
    let offerings = await Self.bounded(fallback: Optional<Offerings>.none) {
      try? await Purchases.shared.offerings()
    }
    guard let offeringID = ApplePurchaseCatalog.stillProV3.offeringID,
          let offering = offerings?.all[offeringID], offering.identifier == offeringID else { return nil }
    let matches = offering.availablePackages.filter { self.offering(for: $0) != nil }
    return matches.count == 1 ? matches[0] : nil
  }

  private func offering(for package: Package) -> AppleLifetimeOffering? {
    guard package.storeProduct.price > 0, let currency = package.storeProduct.currencyCode else { return nil }
    return ApplePurchaseCatalog.lifetimeOffering(offeringID: package.offeringIdentifier,
      packageID: package.identifier, productID: package.storeProduct.productIdentifier,
      isLifetime: package.packageType == .lifetime,
      isNonConsumable: package.storeProduct.productType == .nonConsumable,
      price: package.storeProduct.localizedPriceString, currencyCode: currency)
  }

  func lifetimeOffering() async -> AppleLifetimeOffering? {
    guard let package = await stillProPackage() else { return nil }
    return offering(for: package)
  }

  /// Deliberate account association accepts personally purchased transactions only.
  func applePurchaseEvidence(onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void = { _ in }) async -> [String: String]? {
    await appleEvidence(allowFamilyShared: false, onVerifiedRevocation: onVerifiedRevocation)
  }

  /// Anonymous local validation may also prove a currently verified family entitlement.
  /// This request supplies no client ownership flag; the native StoreKit result is authoritative.
  func appleLocalPurchaseEvidence(onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void = { _ in }) async -> [String: String]? {
    await appleEvidence(allowFamilyShared: true, onVerifiedRevocation: onVerifiedRevocation)
  }

  private func appleEvidence(allowFamilyShared: Bool, onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void) async -> [String: String]? {
    await Self.bounded(fallback: Optional<[String: String]>.none) {
      for product in ApplePurchaseCatalog.all {
        guard let result = await Transaction.latest(for: product.productID), case .verified(let transaction) = result else { continue }
        if let revocation = Self.verifiedNativeRevocation(transaction, jws: result.jwsRepresentation) {
          onVerifiedRevocation(revocation); continue
        }
        guard transaction.productID == product.productID, transaction.revocationDate == nil,
          transaction.expirationDate.map({ $0 > Date() }) ?? true,
          let identity = Self.verifiedNativeIdentity(transaction, jws: result.jwsRepresentation),
          allowFamilyShared || identity.ownership == .purchased else { continue }
        return ["productId": transaction.productID, "bundleId": identity.appBundleId,
          "signedTransaction": result.jwsRepresentation]
      }
      return nil
    }
  }

  /// Known verified refunds publish immediately, even if a later StoreKit read times out.
  /// Unknown/unverified results neither manufacture absence nor revoke a cached signed right.
  func observeAppleOwnership(onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void = { _ in }) async -> NativeAppleOwnershipObservation {
    await Self.bounded(3_000_000_000, fallback: NativeAppleOwnershipObservation.unknown, cancelOnTimeout: true) {
      await AppleOwnershipScan.run(products: ApplePurchaseCatalog.all.map { $0.productID }, latest: { productID in
        guard let result = await Transaction.latest(for: productID) else { return .noPurchases }
        switch result {
        case .unverified: return .unknown
        case .verified(let transaction):
          if let revocation = Self.verifiedNativeRevocation(transaction, jws: result.jwsRepresentation) {
            return .verifiedRevocations([revocation])
          }
          return .purchaseHistory
        }
      }, current: {
        var history = false, uncertain = false
        for await result in Transaction.currentEntitlements {
          if Task.isCancelled { return .unknown }
          switch result {
          case .unverified: uncertain = true
          case .verified(let transaction):
            if ApplePurchaseCatalog.all.contains(where: { $0.productID == transaction.productID }) { history = true }
          }
        }
        return uncertain ? .unknown : history ? .purchaseHistory : .noPurchases
      }, onVerifiedRevocation: onVerifiedRevocation)
    }
  }

  /// Both grants and refunds use the same metadata parser after StoreKit cryptographic verification.
  private static func verifiedNativeIdentity(_ transaction: Transaction, jws: String) -> NativeVerifiedApplePurchase? {
    guard let bundle = Bundle.main.bundleIdentifier,
      ApplePurchaseCatalog.all.contains(where: { $0.productID == transaction.productID }),
      transaction.ownershipType == .purchased || transaction.ownershipType == .familyShared else { return nil }
    let parts = jws.split(separator: ".")
    guard parts.count == 3, parts[1].utf8.count <= 32_768 else { return nil }
    let segment = String(parts[1])
    guard segment.count % 4 != 1 else { return nil }
    let padded = segment.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") +
      String(repeating: "=", count: (4 - segment.count % 4) % 4)
    guard let payload = Data(base64Encoded: padded),
      let claims = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
      claims["bundleId"] as? String == bundle, claims["productId"] as? String == transaction.productID,
      claims["originalTransactionId"] as? String == String(transaction.originalID),
      let environment = claims["environment"] as? String, ["Production", "Sandbox"].contains(environment)
    else { return nil }
    return NativeVerifiedApplePurchase(environment: environment == "Production" ? "production" : "sandbox",
      appBundleId: bundle, productId: transaction.productID, originalTransactionId: String(transaction.originalID),
      ownership: transaction.ownershipType == .purchased ? .purchased : .familyShared,
      isRevoked: transaction.revocationDate != nil)
  }

  private static func verifiedNativeRevocation(_ transaction: Transaction, jws: String) -> NativeVerifiedAppleRevocation? {
    guard let date = transaction.revocationDate,
      let identity = verifiedNativeIdentity(transaction, jws: jws) else { return nil }
    let milliseconds = date.timeIntervalSince1970 * 1000
    guard milliseconds.isFinite, milliseconds >= 0, milliseconds <= 9_007_199_254_740_991 else { return nil }
    return NativeVerifiedAppleRevocation(identity: identity, revokedAt: Int(milliseconds))
  }

  /// Independent current StoreKit oracle for installation; a revoked purchase never grants.
  func verifiedApplePurchaseIdentity(productId: String, onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void = { _ in }) async -> NativeVerifiedApplePurchase? {
    guard ApplePurchaseCatalog.all.contains(where: { $0.productID == productId }) else { return nil }
    return await Self.bounded(fallback: Optional<NativeVerifiedApplePurchase>.none) {
      guard let result = await Transaction.latest(for: productId), case .verified(let transaction) = result else { return nil }
      if let revocation = Self.verifiedNativeRevocation(transaction, jws: result.jwsRepresentation) {
        onVerifiedRevocation(revocation); return nil
      }
      guard transaction.productID == productId, transaction.revocationDate == nil,
        transaction.expirationDate.map({ $0 > Date() }) ?? true else { return nil }
      return Self.verifiedNativeIdentity(transaction, jws: result.jwsRepresentation)
    }
  }

  /// Link eligibility is purchaser-only, including the historical product, with one bounded
  /// deadline across the native reads. Only current StoreKit verification supplies these tuples.
  func verifiedAppleLinkPurchaseIdentities(onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void = { _ in }) async -> [NativeVerifiedApplePurchase]? {
    await Self.bounded(3_000_000_000, fallback: Optional<[NativeVerifiedApplePurchase]>.none, cancelOnTimeout: true) {
      var identities: [NativeVerifiedApplePurchase] = []
      for product in ApplePurchaseCatalog.all {
        if Task.isCancelled { return nil }
        guard let result = await Transaction.latest(for: product.productID), case .verified(let transaction) = result else { continue }
        if let revocation = Self.verifiedNativeRevocation(transaction, jws: result.jwsRepresentation) {
          onVerifiedRevocation(revocation); continue
        }
        guard transaction.productID == product.productID, transaction.revocationDate == nil,
          transaction.expirationDate.map({ $0 > Date() }) ?? true,
          let identity = Self.verifiedNativeIdentity(transaction, jws: result.jwsRepresentation),
          identity.ownership == .purchased else { continue }
        identities.append(identity)
      }
      return identities
    }
  }

  /// V3 purchases do not associate a Still account. Re-read the displayed offer before charging,
  /// join repeated taps, and require a fresh verified exact-product receipt for purchase feedback.
  func purchasePro(offer: AppleLifetimeOffering, onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void = { _ in }) async -> ApplePurchaseActionResult {
    if let modernPurchaseInFlight {
      return await Self.bounded(120_000_000_000, fallback: ApplePurchaseActionResult(.pending)) {
        await modernPurchaseInFlight.value
      }
    }
    let task = Task { @MainActor in
      let receipt = await self.refreshReceiptStatus(onVerifiedRevocation: onVerifiedRevocation)
      if receipt == .entitled {
        return ApplePurchaseActionResult(.restored, receipt: receipt, productId: self.lastReceiptRead.productID)
      }
      guard let fresh = await self.lifetimeOffering(), fresh == offer else {
        return ApplePurchaseActionResult(.unavailable)
      }
      // Deliberate purchase may repair a stale SDK identity; ordinary V3 sign-in never re-keys it.
      guard self.currentAppUserID == nil, await self.ensureAnonymousIdentity() else {
        return ApplePurchaseActionResult(.staleIdentity)
      }
      let outcome = await self.purchaseStillPro(expectedOffer: offer, onVerifiedRevocation: onVerifiedRevocation)
      let status = await self.refreshReceiptStatus(onVerifiedRevocation: onVerifiedRevocation)
      let mapped: ApplePurchaseActionOutcome
      switch outcome {
      case .purchased: mapped = .purchased
      case .cancelled: mapped = .cancelled
      case .pending: mapped = .pending
      case .unavailable: mapped = .unavailable
      case .staleIdentity: mapped = .staleIdentity
      case .failed: mapped = .failed
      }
      return ApplePurchaseActionResult(mapped, receipt: status, productId: self.lastReceiptRead.productID)
    }
    modernPurchaseInFlight = task
    Task { @MainActor in
      _ = await task.value
      if self.modernPurchaseInFlight == task { self.modernPurchaseInFlight = nil }
    }
    return await Self.bounded(120_000_000_000, fallback: ApplePurchaseActionResult(.pending)) {
      await task.value
    }
  }

  // MARK: - Receipt oracle (StoreKit 2, identity-independent — ADR 0003)

  /// Classify one `Transaction.latest(for:)` answer (NOT `currentEntitlements` — revoked
  /// transactions disappear from that sequence, which would make refunds unobservable and AE6
  /// unimplementable). Verified + unrevoked → entitled; verified + revocationDate →
  /// verifiedNotEntitled; nil/unverified → noSignal (absence is never a downgrade signal).
  private static func classifyReceipt(_ latest: StoreKit.VerificationResult<StoreKit.Transaction>?,
    onVerifiedRevocation: (NativeVerifiedAppleRevocation) -> Void) -> ReceiptRead {
    switch latest {
    case .some(.verified(let transaction)):
      if let latest, let revocation = verifiedNativeRevocation(transaction, jws: latest.jwsRepresentation) {
        onVerifiedRevocation(revocation)
      }
      return ReceiptRead(
        status: transaction.revocationDate == nil ? .entitled : .verifiedNotEntitled,
        ownershipIsPurchased: transaction.ownershipType == .purchased,
        productID: transaction.productID)
    case .some(.unverified), .none:
      return ReceiptRead(status: .noSignal, ownershipIsPurchased: false)
    }
  }

  /// Combine one read per restorable product. Entitled anywhere → entitled (directly-bought
  /// ownership on any entitling transaction counts, so family-shared alone never transfers on
  /// attach, AE14); revoked everywhere and entitled nowhere → verifiedNotEntitled; otherwise
  /// noSignal.
  private static func combinedReceipt(_ reads: [ReceiptRead]) -> ReceiptRead {
    let entitled = reads.filter { $0.status == .entitled }
    if !entitled.isEmpty {
      return ReceiptRead(
        status: .entitled,
        ownershipIsPurchased: entitled.contains { $0.ownershipIsPurchased },
        productID: entitled.first?.productID)
    }
    if reads.contains(where: { $0.status == .verifiedNotEntitled }) {
      return ReceiptRead(status: .verifiedNotEntitled, ownershipIsPurchased: false)
    }
    return ReceiptRead(status: .noSignal, ownershipIsPurchased: false)
  }

  /// One bounded receipt read across every restorable product — the sellable one plus the
  /// historical one. `Transaction.latest(for:)` takes a single id, so one call cannot cover
  /// past buyers and new buyers at once; both reads share this call's deadline.
  private static func boundedReceiptRead(onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void) async -> ReceiptRead {
    let once = Once()
    return await withCheckedContinuation { (continuation: CheckedContinuation<ReceiptRead, Never>) in
      Task {
        // Each completed verified result commits its removal immediately, before its peer settles.
        async let sellable = Self.classifyReceipt(await Transaction.latest(for: Self.productID),
          onVerifiedRevocation: onVerifiedRevocation)
        async let historical = Self.classifyReceipt(await Transaction.latest(for: ApplePurchaseCatalog.historicalStillSync.productID),
          onVerifiedRevocation: onVerifiedRevocation)
        let read = await Self.combinedReceipt([sellable, historical])
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
  func refreshReceiptStatus(onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void = { _ in }) async -> ReceiptStatus {
    let read = await Self.boundedReceiptRead(onVerifiedRevocation: onVerifiedRevocation)
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
  func purchaseStillPro(expectedOffer: AppleLifetimeOffering? = nil, onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void = { _ in }) async -> Outcome {
    let startingUserID = currentAppUserID
    // Receipt pre-flight (R14): a device that provably owns Pro never re-enters the purchase or
    // restore machinery — under default transfer semantics a RevenueCat receipt-post from a fresh
    // identity would move the entitlement OFF the account it is attached to.
    if await refreshReceiptStatus(onVerifiedRevocation: onVerifiedRevocation) == .entitled { return .purchased }
    // R15 ordering (review finding, 3 independent reviewers): verify the anonymous identity
    // BEFORE trusting CustomerInfo. A failed prior logOut leaves the SDK keyed to a departed
    // account; probing hasStillPro() against it would return a false `.purchased` — success
    // screen, no charge, no receipt, nothing unlocked — and make the staleIdentity retry
    // permanently unreachable. The CustomerInfo short-circuit is trusted only for a signed-in
    // session or a VERIFIED anonymous identity.
    let verifiedAnonymous = startingUserID == nil ? await ensureAnonymousIdentity() : false
    if startingUserID != nil || verifiedAnonymous {
      if await hasStillPro() { return .purchased } // already unlocked on this identity; never double-charge
    }
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
    if let expectedOffer, offering(for: package) != expectedOffer { return .unavailable }
    return await NativeSalesPurchaseBoundary.perform(policy: freshSalesPolicy(), unavailable: Outcome.unavailable,
                                                     installEnvironment: { await Self.verifiedInstallEnvironment() }) {
      // The policy await must not allow a departed identity to receive this new charge.
      guard self.currentAppUserID == startingUserID else { return .failed("identity changed") }
      do {
        let result = try await Purchases.shared.purchase(package: package)
        if result.userCancelled { return .cancelled }
        return Self.proEntitlementIsActive(in: result.customerInfo) ? .purchased : .pending
      } catch {
        if let rcError = error as? RevenueCat.ErrorCode, rcError == .paymentPendingError {
          return .pending // Ask-to-Buy: guardian approval arrives out-of-band
        }
        return .failed(error.localizedDescription)
      }
    }
  }

  /// Apple's verified installation environment for the sandbox pre-charge check. Anything short of a
  /// verified answer within the bound, including an OS before AppTransaction, is `unavailable`.
  private static func verifiedInstallEnvironment() async -> AppleInstallEnvironment {
    guard #available(iOS 16.0, macOS 13.0, *) else { return .unavailable }
    // Request cancellation on timeout; the fallback prevents late answers reaching checkout.
    // StoreKit controls cooperative cancellation and dismissal of its system UI.
    return await bounded(20_000_000_000, fallback: AppleInstallEnvironment.unavailable, cancelOnTimeout: true) {
      guard let result = try? await AppTransaction.shared, case .verified(let transaction) = result else { return .unavailable }
      switch transaction.environment {
      case .sandbox: return .sandbox
      case .xcode: return .xcode
      case .production: return .production
      default: return .unavailable
      }
    }
  }

  private func freshSalesPolicy() -> ProductPolicyRuntime? {
    let info = Bundle.main.infoDictionary ?? [:]
    guard let profile = NativeAccessConfiguration.backendRouteProfile(info: info),
      !NativeAccessConfiguration.trust(info: info).keys.isEmpty,
      NativeAccessConfiguration.sessionVerifier(info: info) != nil,
      let revisions = ProductPolicyRevisionStore.appGroup(),
      let origin = info["StillAccessSupabaseURL"] as? String,
      let build = info["CFBundleShortVersionString"] as? String else { return nil }
    return ProductPolicyRuntime(supabaseURL: origin, environment: profile.environment,
      surface: RatingPrompt.appSurface, build: build, routeProfile: profile, store: revisions)
  }

  /// Restore purchases (the visible restore affordance, R4) — works signed out. Pre-flights the
  /// receipt (R14): when the device already owns Pro, succeed WITHOUT calling RevenueCat restore,
  /// whose transfer semantics would strip the entitlement from whichever account it is attached
  /// to. Only receipt-negative devices (true recovery) reach RevenueCat.
  func restore(onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void = { _ in }) async -> Bool {
    let startingUserID = currentAppUserID
    if await refreshReceiptStatus(onVerifiedRevocation: onVerifiedRevocation) == .entitled { return true }
    // Same R15 ordering as purchaseStillPro(): never trust CustomerInfo on an unverified
    // identity — a stale departed account's Pro would fake a successful restore.
    let verifiedAnonymous = startingUserID == nil ? await ensureAnonymousIdentity() : false
    if startingUserID != nil || verifiedAnonymous {
      if await hasStillPro() { return true }
    }
    guard PurchaseDecision.readiness(
      isConfigured: isConfigured,
      startingAppUserID: startingUserID,
      currentAppUserID: currentAppUserID,
      packageAvailable: true,
      identityVerifiedAnonymous: verifiedAnonymous
    ) == .proceed else { return false }
    let info = try? await Purchases.shared.restorePurchases()
    return Self.proEntitlementIsActive(in: info)
  }

  /// Attach the device receipt to the signed-in Still account (R7 — RevenueCat syncPurchases).
  /// Guarded by the pure eligibility gate: session present, SDK identity EQUAL to it (a timed-out
  /// re-key can leave them divergent — attaching then would transfer the purchase to the wrong
  /// customer, AE13), and the transaction directly purchased (family-shared never transfers the
  /// buyer's entitlement to a family member's account, AE14).
  func attachPurchases(onVerifiedRevocation: @escaping (NativeVerifiedAppleRevocation) -> Void = { _ in }) async -> Bool {
    guard isConfigured else { return false }
    let read = await Self.boundedReceiptRead(onVerifiedRevocation: onVerifiedRevocation)
    guard PurchaseDecision.attachEligible(
      currentAppUserID: currentAppUserID,
      sdkAppUserID: Purchases.shared.appUserID,
      ownershipIsPurchased: read.ownershipIsPurchased,
      receiptEntitled: read.status == .entitled
    ) else { return false }
    let info = try? await Purchases.shared.syncPurchases()
    return Self.proEntitlementIsActive(in: info)
  }
}
