import Foundation
import XCTest
@testable import StillKit

/// A scriptable stand-in for the App Store. It records every call so a test can say exactly what
/// the check asked Apple for, and it offers only the two read-only members the seam has.
private final class FakeAppStore: FreePeriodRestoreStore, @unchecked Sendable {
  enum Sync { case succeeds, fails, cancelled, hangs }

  private let lock = NSLock()
  private var reads: [AppStoreEntitlementRead]
  private let sync: Sync
  private let readDelayNanoseconds: UInt64
  private var _readCount = 0
  private var _syncCount = 0
  private var _askedFor: [Set<String>] = []

  init(reads: [AppStoreEntitlementRead], sync: Sync = .succeeds, readDelayNanoseconds: UInt64 = 0) {
    self.reads = reads
    self.sync = sync
    self.readDelayNanoseconds = readDelayNanoseconds
  }

  var readCount: Int { lock.lock(); defer { lock.unlock() }; return _readCount }
  var syncCount: Int { lock.lock(); defer { lock.unlock() }; return _syncCount }
  var askedFor: [Set<String>] { lock.lock(); defer { lock.unlock() }; return _askedFor }

  func currentEntitlement(matching productIDs: Set<String>) async -> AppStoreEntitlementRead {
    let next: AppStoreEntitlementRead = {
      lock.lock(); defer { lock.unlock() }
      _readCount += 1
      _askedFor.append(productIDs)
      return reads.isEmpty ? .absent : reads.removeFirst()
    }()
    if readDelayNanoseconds > 0 { try? await Task.sleep(nanoseconds: readDelayNanoseconds) }
    return next
  }

  func syncWithAppStore() async throws {
    lock.lock()
    _syncCount += 1
    lock.unlock()
    switch sync {
    case .succeeds: return
    case .fails: throw URLError(.notConnectedToInternet)
    case .cancelled: throw CancellationError()
    case .hangs: try? await Task.sleep(nanoseconds: 5_000_000_000)
    }
  }
}

/// Holds a sync open until the test releases it, so two taps can overlap deterministically.
private final class GatedAppStore: FreePeriodRestoreStore, @unchecked Sendable {
  private let lock = NSLock()
  private var _syncCount = 0
  private var waiting: CheckedContinuation<Void, Never>?
  private var released = false

  var syncCount: Int { lock.lock(); defer { lock.unlock() }; return _syncCount }

  func currentEntitlement(matching productIDs: Set<String>) async -> AppStoreEntitlementRead { .absent }

  func syncWithAppStore() async throws {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      lock.lock()
      _syncCount += 1
      if released { lock.unlock(); continuation.resume(); return }
      waiting = continuation
      lock.unlock()
    }
  }

  func release() {
    lock.lock()
    released = true
    let continuation = waiting
    waiting = nil
    lock.unlock()
    continuation?.resume()
  }
}

@MainActor
final class FreePeriodRestoreTests: XCTestCase {
  private func check(
    _ store: FreePeriodRestoreStore,
    readDeadline: UInt64 = 2_000_000_000,
    syncDeadline: UInt64 = 2_000_000_000
  ) async -> FreePeriodRestoreResult {
    await FreePeriodRestoreCheck(
      store: store, readDeadlineNanoseconds: readDeadline, syncDeadlineNanoseconds: syncDeadline
    ).run()
  }

  // MARK: restored

  func testAPurchaseAlreadyOnThisDeviceIsRestoredWithoutAskingAppleToSync() async {
    let store = FakeAppStore(reads: [.verified])
    let result = await check(store)
    XCTAssertEqual(result, .restored)
    XCTAssertEqual(store.syncCount, 0, "no sign-in sheet when the purchase is already here")
  }

  func testAPurchaseTheSyncBringsBackIsRestored() async {
    let store = FakeAppStore(reads: [.absent, .verified])
    let result = await check(store)
    XCTAssertEqual(result, .restored)
    XCTAssertEqual(store.syncCount, 1)
  }

  // MARK: none

  func testAVerifiedEmptyListAfterASuccessfulSyncIsNone() async {
    let store = FakeAppStore(reads: [.absent, .absent])
    let result = await check(store)
    XCTAssertEqual(result, .none)
    XCTAssertEqual(store.syncCount, 1)
    XCTAssertEqual(store.readCount, 2, "none needs a fresh read after the sync, not the stale one")
  }

  // MARK: failed — never none

  func testASyncErrorIsFailedNeverNone() async {
    let store = FakeAppStore(reads: [.absent, .absent], sync: .fails)
    let result = await check(store)
    XCTAssertEqual(result, .failed, "a sync that did not reach Apple proves nothing about purchases")
    XCTAssertEqual(store.readCount, 1, "the list is not re-read after a failed sync")
  }

  func testACancelledSignInIsFailedNeverNone() async {
    let result = await check(FakeAppStore(reads: [.absent, .absent], sync: .cancelled))
    XCTAssertEqual(result, .failed)
  }

  func testASyncThatOutlivesItsDeadlineIsFailed() async {
    let started = Date()
    let result = await check(
      FakeAppStore(reads: [.absent, .absent], sync: .hangs), syncDeadline: 50_000_000)
    XCTAssertEqual(result, .failed)
    XCTAssertLessThan(Date().timeIntervalSince(started), 3, "the deadline settles the reply")
  }

  func testOnlyAnUnverifiedPurchaseAfterTheSyncIsFailedNeitherRestoredNorNone() async {
    let result = await check(FakeAppStore(reads: [.absent, .unverified]))
    XCTAssertEqual(result, .failed)
  }

  func testAReadAfterTheSyncThatOutlivesItsDeadlineIsFailed() async {
    let result = await check(
      FakeAppStore(reads: [.absent, .absent], readDelayNanoseconds: 1_000_000_000),
      readDeadline: 50_000_000)
    XCTAssertEqual(result, .failed)
  }

  func testAnUnverifiedPurchaseBeforeTheSyncStillAsksApple() async {
    let store = FakeAppStore(reads: [.unverified, .verified])
    let result = await check(store)
    XCTAssertEqual(result, .restored)
    XCTAssertEqual(store.syncCount, 1)
  }

  // MARK: scope

  func testTheCheckAsksOnlyAboutStillsOwnProducts() async {
    let store = FakeAppStore(reads: [.absent, .absent])
    _ = await FreePeriodRestoreCheck(store: store).run()
    XCTAssertEqual(store.askedFor, [["still_sync", "still_pro_v3"], ["still_sync", "still_pro_v3"]])
  }

  func testASecondTapWhileACheckRunsJoinsItInsteadOfAskingAppleAgain() async {
    let store = GatedAppStore()
    let restore = FreePeriodRestoreCheck(store: store)
    let first = Task { await restore.run() }
    let second = Task { await restore.run() }
    // Let both taps arrive before the App Store answers.
    for _ in 0..<50 where store.syncCount == 0 { await Task.yield() }
    try? await Task.sleep(nanoseconds: 50_000_000)
    store.release()
    let results = [await first.value, await second.value]
    XCTAssertEqual(results, [.none, .none])
    XCTAssertEqual(store.syncCount, 1, "one tap, one possible sign-in sheet")

    // After it settles, a new tap is a new check.
    _ = await restore.run()
    XCTAssertEqual(store.syncCount, 2)
  }

  // MARK: reply

  func testTheReplyCarriesTheConclusiveAnswerAndEntitledOnlyWhenRestored() {
    let restored = FreePeriodRestoreCheck.reply(for: .restored)
    XCTAssertEqual(restored["restore"] as? String, "restored")
    XCTAssertEqual(restored["entitled"] as? Bool, true)
    for result in [FreePeriodRestoreResult.none, .failed] {
      let reply = FreePeriodRestoreCheck.reply(for: result)
      XCTAssertEqual(reply["restore"] as? String, result.rawValue)
      XCTAssertEqual(reply["entitled"] as? Bool, false)
    }
    XCTAssertEqual(Set(restored.keys), ["entitled", "restore"])
  }

  // MARK: paid stays off

  /// The router refreshes the App Group stamp after the check through the existing receipt lane
  /// (`applyReceipt`, StampPolicy). While the paid tier is off, what the Safari extension reads to
  /// decide what it blocks and which controls it shows must be identical before and after a past
  /// buyer's purchase is restored: free features free, Pro-only controls unavailable.
  func testARestoredPurchaseWhilePaidIsOffChangesNothingTheSafariExtensionReads() throws {
    XCTAssertFalse(MonetizationConfig.paidTierEnabled)
    let store = SharedEntitlementStore(backing: InMemoryBacking())
    let app = EntitlementBridge(
      store: store, now: { 1_000 }, installId: { "install-A" }, receiptStatus: { .entitled })
    let safariExtension = EntitlementBridge(
      store: store, now: { 1_000 }, installId: { "install-A" }, readOnly: true)

    let before = try XCTUnwrap(safariExtension.handle(rawBody: ["kind": "getBenefitAccess"]))
    let stamp = app.applyReceipt(.entitled)
    XCTAssertEqual(stamp?.entitled, true, "the receipt lane records the purchase as it does at launch")
    let after = try XCTUnwrap(safariExtension.handle(rawBody: ["kind": "getBenefitAccess"]))

    XCTAssertEqual(after, before, "a restored purchase must not change the extension's access while paid is off")
    let reply = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(after.utf8)) as? [String: Any])
    let snapshot = try XCTUnwrap(reply["snapshot"] as? [String: Any])
    let states = try XCTUnwrap(snapshot["states"] as? [String: String])
    for feature in PackagedFeatureRegistry.features {
      XCTAssertEqual(
        states[feature.id], feature.tier == "free" ? "free" : "unsupported",
        "\(feature.id) must not unlock while the paid tier is off")
    }
  }
}
