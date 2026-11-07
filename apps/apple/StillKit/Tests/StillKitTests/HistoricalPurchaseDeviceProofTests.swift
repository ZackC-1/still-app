import XCTest
@testable import StillKit

/// ISS-0132: a device whose only Still purchase is the historical `still_sync` product. The server
/// accepts only `still_pro_v3` as device evidence, so the historical purchase must never feed the
/// device-only ownership read. Read as history it held every Still Pro row at "verification
/// required", hid Get Still Pro and could not be cleared by Restore. It must read exactly like no
/// purchase: rows locked in the app and in Safari, while a refund of it is still published.
@MainActor
final class HistoricalPurchaseDeviceProofTests: XCTestCase {
  let lane = SafariAccessLaneTests()
  var f: AppleRightBindingTests { lane.f }
  let sellable = ApplePurchaseCatalog.stillProV3.productID
  let historical = ApplePurchaseCatalog.historicalStillSync.productID

  /// The scan exactly as `PurchaseManager.observeAppleOwnership` wires it, over fake StoreKit ports.
  func scan(_ latest: [String: NativeAppleOwnershipObservation],
            current: NativeAppleOwnershipObservation = .noPurchases)
    async -> (NativeAppleOwnershipObservation, [NativeVerifiedAppleRevocation], [String]) {
    var published: [NativeVerifiedAppleRevocation] = []
    var asked: [String] = []
    let result = await AppleOwnershipScan.run(
      products: ApplePurchaseCatalog.deviceProofProducts.map(\.productID),
      revocationOnly: [historical],
      latest: { product in asked.append(product); return latest[product] ?? .noPurchases },
      current: { current },
      onVerifiedRevocation: { published.append($0) })
    return (result, published, asked)
  }

  func revocation(_ product: String) -> NativeVerifiedAppleRevocation {
    NativeVerifiedAppleRevocation(identity: NativeVerifiedApplePurchase(environment: "production",
      appBundleId: "com.chartash.still", productId: product, originalTransactionId: "2000000000000001"),
      revokedAt: f.now)
  }

  func testDeviceProofIsTheSellableProductOnly() {
    XCTAssertEqual(ApplePurchaseCatalog.deviceProofProducts, [ApplePurchaseCatalog.stillProV3])
    XCTAssertFalse(ApplePurchaseCatalog.deviceProofProducts.contains(ApplePurchaseCatalog.historicalStillSync))
    XCTAssertTrue(ApplePurchaseCatalog.deviceProofProducts.allSatisfy(\.isSellable))
    // Linking, attach and revocation reads keep the historical product.
    XCTAssertTrue(ApplePurchaseCatalog.all.contains(ApplePurchaseCatalog.historicalStillSync))
  }

  func testAHistoricalOnlyPurchaseReadsAsNoPurchases() async throws {
    let (result, published, asked) = await scan([historical: .purchaseHistory])
    guard case .noPurchases = result else { return XCTFail("historical history counted as Still Pro: \(result)") }
    XCTAssertEqual(result.evidenceStatus, "none")
    XCTAssertTrue(published.isEmpty)
    XCTAssertEqual(asked, [sellable, historical], "the historical product is read for refunds only")
  }

  func testAnUnverifiedHistoricalAnswerDoesNotMakeTheReadUncertain() async {
    let (result, _, _) = await scan([historical: .unknown])
    guard case .noPurchases = result else { return XCTFail("an unverified historical answer held the rows: \(result)") }
  }

  func testAHistoricalRefundIsPublishedButIsNotHistory() async {
    let refund = revocation(historical)
    let (result, published, _) = await scan([historical: .verifiedRevocations([refund])])
    guard case .noPurchases = result else { return XCTFail("a historical refund counted as history: \(result)") }
    XCTAssertEqual(published.map(\.identity.productId), [historical], "the refund still reaches the revocation commit")
  }

  func testTheSellableProductStillCounts() async {
    let (bought, _, _) = await scan([sellable: .purchaseHistory, historical: .purchaseHistory])
    guard case .purchaseHistory = bought else { return XCTFail("a sellable purchase must count: \(bought)") }
    let (unsure, _, _) = await scan([sellable: .unknown])
    guard case .unknown = unsure else { return XCTFail("an unverified sellable answer stays unknown: \(unsure)") }
    let refund = revocation(sellable)
    let (refunded, published, _) = await scan([sellable: .verifiedRevocations([refund])])
    guard case .verifiedRevocations = refunded else { return XCTFail("a sellable refund is still history: \(refunded)") }
    XCTAssertEqual(published.count, 1)
  }

  // MARK: The app target's wiring (read from source: StoreKit itself cannot run here)

  private var appSource: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Still/Shared (App)")
  }
  /// Text from `start` up to the first `end` after it.
  private func slice(_ source: String, from start: String, to end: String) throws -> String {
    let open = try XCTUnwrap(source.range(of: start), "cannot find \(start)")
    let close = source.range(of: end, range: open.upperBound..<source.endIndex)?.lowerBound ?? source.endIndex
    return String(source[open.lowerBound..<close])
  }

  func testDeviceOnlyPurchaseReadsUseTheDeviceProofProducts() throws {
    let manager = try String(contentsOf: appSource.appendingPathComponent("Purchases/PurchaseManager.swift"), encoding: .utf8)
    let ownership = try slice(manager, from: "func observeAppleOwnership(", to: "\n  }\n")
    XCTAssertTrue(ownership.contains("products: ApplePurchaseCatalog.deviceProofProducts"))
    XCTAssertTrue(ownership.contains("revocationOnly: [ApplePurchaseCatalog.historicalStillSync.productID]"))
    XCTAssertFalse(ownership.contains("ApplePurchaseCatalog.all"), "the current-entitlements filter must not count still_sync")
    let evidence = try slice(manager, from: "private func appleEvidence(", to: "\n  }\n")
    XCTAssertTrue(evidence.contains("for product in ApplePurchaseCatalog.deviceProofProducts"))
    XCTAssertFalse(evidence.contains("ApplePurchaseCatalog.all"))
    let purchase = try slice(manager, from: "func purchasePro(offer:", to: "\n  }\n")
    XCTAssertTrue(purchase.contains("self.sellableReceiptRead("), "the pre-purchase check counts only still_pro_v3")
    XCTAssertTrue(purchase.contains("historicalCountsAsOwned: false"))
    XCTAssertFalse(purchase.contains("let receipt = await self.refreshReceiptStatus"))
    let read = try slice(manager, from: "func sellableReceiptRead(", to: "\n  }\n")
    XCTAssertTrue(read.contains("ApplePurchaseCatalog.deviceProofProducts"))
    // Account linking keeps the historical product: the server decides a paid legacy right.
    let link = try slice(manager, from: "func verifiedAppleLinkPurchaseIdentities(", to: "\n  }\n")
    XCTAssertTrue(link.contains("for product in ApplePurchaseCatalog.all"))

    let router = try String(contentsOf: appSource.appendingPathComponent("WebBridgeRouter.swift"), encoding: .utf8)
    let restore = try slice(router, from: "case \"restorePro\":", to: "\n    case \"")
    XCTAssertTrue(restore.contains("self.proRestore.run()"))
    XCTAssertFalse(restore.contains("self.freePeriodRestore.run()"), "the Still Pro Restore must not report still_sync")
    XCTAssertTrue(restore.contains("self.purchases.sellableReceiptRead"))
    XCTAssertTrue(router.contains("productIDs: Set(ApplePurchaseCatalog.deviceProofProducts.map(\\.productID))"))
    let historical = try slice(router, from: "case \"appleHistoricalPurchase\":", to: "\n    case \"")
    XCTAssertTrue(historical.contains("guard Set(dict.keys) == [\"kind\"], frame.isTrusted"))
    XCTAssertTrue(historical.contains("guard MonetizationConfig.paidTierEnabled"))
  }

  /// End to end through the access record: the app's own rows and Safari's rows are locked, as for
  /// someone who never bought, not "verification required".
  func testAHistoricalOnlyDeviceLocksStillProInTheAppAndInSafari() async throws {
    let (observation, _, _) = await scan([historical: .purchaseHistory])
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust)
    let app = try store.observeAppleBenefits(wall: f.now, ownership: observation, paidMode: true, platform: .mac)
    XCTAssertEqual(Set(app.states.filter { lane.pro.contains($0.key) }.values), ["locked"])
    XCTAssertEqual(lane.proRows(try lane.states(store)), ["locked"])
    // Reading the historical purchase as history (the old wiring) is what held them.
    let held = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust)
    _ = try held.observeAppleBenefits(wall: f.now, ownership: .purchaseHistory, paidMode: true, platform: .mac)
    XCTAssertEqual(lane.proRows(try lane.states(held)), ["verification_required"])
  }
}
