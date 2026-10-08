// Behavioral probe links the actual StillKit types and extracts the two pure helpers from
// PurchaseManager/WebBridgeRouter. No StoreKit/provider/secret or App Group fixtures are used.
import Foundation
import StillKit

@main struct AppleRouterRepairsProbe {
  enum Failure: Error { case expected(String), commit }
  @MainActor static func require(_ value: Bool, _ message: String) throws {
    guard value else { throw Failure.expected(message) }
  }
  @MainActor static func main() async throws {
    let identity = NativeVerifiedApplePurchase(environment: "sandbox", appBundleId: "test.app",
      productId: "still_pro_v3", originalTransactionId: "123", isRevoked: true)
    let refund = NativeVerifiedAppleRevocation(identity: identity, revokedAt: 100)
    var fence = AppleAccessRevocationFence()
    let localBeforeRefund = fence.generation, accountBeforeRefund = fence.generation
    fence.observe(refund)
    // No binding exists, but successful removal (including a no-op durable commit) fences both lanes.
    try require(fence.retry { _ in }, "successful/no-binding commit")
    try require(!fence.permitsInstall(localBeforeRefund), "stale local install")
    try require(!fence.permitsInstall(accountBeforeRefund), "stale account install")
    try require(fence.permitsInstall(fence.generation), "fresh install after settled removal")
    // Real route lineage gate: a current v3 candidate must remain available when its catalog
    // scan re-reports a successfully committed historical refund. Each modern oracle shares
    // this same production helper; read-only observations cannot indefinitely fence themselves.
    let historicalIdentity = NativeVerifiedApplePurchase(environment: "sandbox", appBundleId: "test.app",
      productId: "still_sync", originalTransactionId: "456", isRevoked: true)
    let historicalRefund = NativeVerifiedAppleRevocation(identity: historicalIdentity, revokedAt: 90)
    var catalogFence = AppleAccessRevocationFence()
    catalogFence.observe(historicalRefund)
    try require(catalogFence.retry { _ in }, "historical refund committed")
    let currentV3 = NativeVerifiedApplePurchase(environment: "sandbox", appBundleId: "test.app",
      productId: "still_pro_v3", originalTransactionId: "789", isRevoked: false)
    for oracle in ["link", "local install", "account install", "receipt", "benefit read"] {
      let lineage = catalogFence.generation
      catalogFence.observe(historicalRefund)
      var writes = 0
      try require(catalogFence.retry { _ in writes += 1 }, "settled historical observation")
      try require(writes == 0, "\(oracle): settled refund must not rewrite durable storage")
      try require(catalogFence.permitsInstall(lineage) && !currentV3.isRevoked,
        "\(oracle): committed historical refund must not suppress current v3 candidate")
    }
    let beforeNewRefund = catalogFence.generation
    let newRefund = NativeVerifiedAppleRevocation(identity: identity, revokedAt: refund.revokedAt)
    catalogFence.observe(newRefund)
    try require(!catalogFence.permitsInstall(beforeNewRefund) && !catalogFence.ready,
      "new refund synchronously fences every delayed oracle before any durable commit")
    try require(!catalogFence.retry { _ in throw Failure.commit }, "failed commit must be unavailable")
    try require(!catalogFence.ready && !catalogFence.permitsInstall(catalogFence.generation),
      "failed commit fences fresh install")
    catalogFence.observe(newRefund)
    var attempts = 0
    try require(catalogFence.retry { _ in attempts += 1 }, "verified pending commit retries")
    try require(attempts == 1, "failed refund remains pending and retries only once")
    let afterRetry = catalogFence.generation
    catalogFence.observe(newRefund)
    try require(catalogFence.permitsInstall(afterRetry), "successful retry deduplicates subsequent observations")

    // Every authority-key component matters; a different original tuple, environment, owner,
    // product, bundle or revocation timestamp is a new cryptographically verified observation.
    let controls = [
      NativeVerifiedAppleRevocation(identity: NativeVerifiedApplePurchase(environment: "production",
        appBundleId: identity.appBundleId, productId: identity.productId,
        originalTransactionId: identity.originalTransactionId, isRevoked: true), revokedAt: refund.revokedAt),
      NativeVerifiedAppleRevocation(identity: NativeVerifiedApplePurchase(environment: identity.environment,
        appBundleId: "other.app", productId: identity.productId,
        originalTransactionId: identity.originalTransactionId, isRevoked: true), revokedAt: refund.revokedAt),
      NativeVerifiedAppleRevocation(identity: NativeVerifiedApplePurchase(environment: identity.environment,
        appBundleId: identity.appBundleId, productId: "still_sync",
        originalTransactionId: identity.originalTransactionId, isRevoked: true), revokedAt: refund.revokedAt),
      NativeVerifiedAppleRevocation(identity: NativeVerifiedApplePurchase(environment: identity.environment,
        appBundleId: identity.appBundleId, productId: identity.productId,
        originalTransactionId: "999", isRevoked: true), revokedAt: refund.revokedAt),
      NativeVerifiedAppleRevocation(identity: NativeVerifiedApplePurchase(environment: identity.environment,
        appBundleId: identity.appBundleId, productId: identity.productId,
        originalTransactionId: identity.originalTransactionId, ownership: .familyShared, isRevoked: true), revokedAt: refund.revokedAt),
      NativeVerifiedAppleRevocation(identity: identity, revokedAt: refund.revokedAt + 1)
    ]
    for control in controls {
      let lineage = fence.generation
      fence.observe(control)
      try require(!fence.permitsInstall(lineage) && !fence.ready, "different authority key must fence")
      try require(fence.retry { _ in }, "different authority key commits")
    }

    // A personally purchased observation must not be deduplicated against failed family-only
    // evidence: the purchased proof is allowed to upgrade account revocation as well as local.
    var ownershipFence = AppleAccessRevocationFence()
    let familyIdentity = NativeVerifiedApplePurchase(environment: identity.environment,
      appBundleId: identity.appBundleId, productId: identity.productId,
      originalTransactionId: identity.originalTransactionId, ownership: .familyShared, isRevoked: true)
    ownershipFence.observe(NativeVerifiedAppleRevocation(identity: familyIdentity, revokedAt: refund.revokedAt))
    try require(!ownershipFence.retry { _ in throw Failure.commit }, "family removal initially failed")
    ownershipFence.observe(refund)
    var committedOwnership: [NativeVerifiedApplePurchase.Ownership] = []
    try require(ownershipFence.retry { committedOwnership.append($0.identity.ownership) }, "both owned removal authorities retry")
    try require(committedOwnership == [.familyShared, .purchased], "purchased upgrade must survive pending family dedup")

    var latestCalls: [String] = [], currentCalls = 0, callbacks = 0
    let observed = await AppleOwnershipScan.run(products: ["pro", "historical"], latest: { product in
      latestCalls.append(product)
      return product == "pro" ? .verifiedRevocations([refund]) : .purchaseHistory
    }, current: { currentCalls += 1; return .unknown }, onVerifiedRevocation: { _ in callbacks += 1 })
    guard case .verifiedRevocations(let revocations) = observed else { throw Failure.expected("known refund") }
    try require(revocations.count == 1 && callbacks == 1 && currentCalls == 0,
      "refund must publish before potentially hung current entitlements")
    try require(latestCalls == ["pro", "historical"], "latest history precedes current scan")

    // A second historical provider read can stall: the first verified refund must already commit.
    var release: CheckedContinuation<NativeAppleOwnershipObservation, Never>?
    callbacks = 0
    let delayed = Task { @MainActor in
      await AppleOwnershipScan.run(products: ["pro", "slow"], latest: { product in
        if product == "pro" { return .verifiedRevocations([refund]) }
        return await withCheckedContinuation { release = $0 }
      }, current: { throwNeverCurrent() }, onVerifiedRevocation: { _ in callbacks += 1 })
    }
    while release == nil { await Task.yield() }
    try require(callbacks == 1, "known refund callback cannot wait for peer provider read")
    release!.resume(returning: .unknown)
    guard case .verifiedRevocations = await delayed.value else { throw Failure.expected("refund retained after unknown") }

    let unknown = await AppleOwnershipScan.run(products: ["pro"], latest: { _ in .unknown },
      current: { .noPurchases }, onVerifiedRevocation: { _ in callbacks += 1 })
    guard case .unknown = unknown else { throw Failure.expected("unknown is not absence") }
    try require(callbacks == 1, "unknown must never fabricate revocation")
    let empty = await AppleOwnershipScan.run(products: ["pro"], latest: { _ in .noPurchases },
      current: { .noPurchases }, onVerifiedRevocation: { _ in callbacks += 1 })
    guard case .noPurchases = empty else { throw Failure.expected("completed empty observation") }
    let history = await AppleOwnershipScan.run(products: ["pro"], latest: { _ in .purchaseHistory },
      current: { .noPurchases }, onVerifiedRevocation: { _ in callbacks += 1 })
    guard case .purchaseHistory = history else { throw Failure.expected("verified history is not absence") }
    let cancelled = Task { @MainActor in
      await AppleOwnershipScan.run(products: ["pro"], latest: { _ in .noPurchases }, current: {
        do { try await Task.sleep(nanoseconds: 60_000_000_000) } catch { return .unknown }
        return .noPurchases
      }, onVerifiedRevocation: { _ in callbacks += 1 })
    }
    await Task.yield(); cancelled.cancel()
    guard case .unknown = await cancelled.value else { throw Failure.expected("cancelled scan is unknown") }
    print("PASS: stale local/account install; no-binding refund; failed durable commit/retry; settled historical refund/current-v3 eligibility; full authority-key controls; duplicate observation; history-before-current; immediate peer-independent callback; unknown/absence; cancellation")
  }
  static func throwNeverCurrent() -> NativeAppleOwnershipObservation { fatalError("known refund must skip current") }
}
