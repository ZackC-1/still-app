import XCTest
@testable import StillKit

/// The R13 never-downgrade matrix, cell by cell (plan 2026-07-15-001, ADR 0003). Inputs are the
/// proposed record (value + lane), the cached receipt status, and the current stamp; the policy
/// returns write-or-drop. The two load-bearing source-aware cells: a signed-out web purchaser's
/// Mac still re-locks Safari (server-lane false over a server stamp writes even on noSignal), and
/// a receipt refund never clobbers web-granted Pro (receipt-lane false over a server stamp drops).
final class StampPolicyTests: XCTestCase {
  private func record(
    _ entitled: Bool, at updatedAt: Int = 100, source: EntitlementSource
  ) -> EntitlementRecord {
    EntitlementRecord(entitled: entitled, updatedAt: updatedAt, source: source)
  }

  // MARK: true proposals always write

  func testTrueWritesFromServerLane() {
    let proposed = record(true, source: .server)
    XCTAssertEqual(
      StampPolicy.decide(proposed: proposed, receipt: .noSignal, current: nil),
      .write(proposed))
  }

  func testTrueWritesFromReceiptLaneOverServerStamp() {
    // Server may refresh true, receipt may refresh true — value true never blocks.
    let proposed = record(true, source: .receipt)
    XCTAssertEqual(
      StampPolicy.decide(
        proposed: proposed, receipt: .entitled, current: record(true, at: 50, source: .server)),
      .write(proposed))
  }

  func testEqualValueTrueStillWritesToRefreshUpdatedAt() {
    // The extension's 30-day TTL keys off updatedAt; refreshing an unchanged value is the point.
    let proposed = record(true, at: 200, source: .receipt)
    XCTAssertEqual(
      StampPolicy.decide(
        proposed: proposed, receipt: .entitled, current: record(true, at: 100, source: .receipt)),
      .write(proposed))
  }

  // MARK: receipt entitled blocks every downgrade (AE2)

  func testSignOutFalseBlockedAndRestampedWhenReceiptEntitled() {
    // AE2: sign-out proposes false over a receipt-entitled device → blocked, restamped
    // receipt-true so the stamp's updatedAt refreshes rather than staling toward the TTL.
    let proposed = record(false, at: 300, source: .server)
    XCTAssertEqual(
      StampPolicy.decide(
        proposed: proposed, receipt: .entitled, current: record(true, at: 100, source: .server)),
      .write(record(true, at: 300, source: .receipt)))
  }

  func testReceiptLaneFalseAlsoBlockedWhenReceiptEntitled() {
    // A stale refund proposal racing a repurchase: the live status wins.
    let proposed = record(false, at: 300, source: .receipt)
    XCTAssertEqual(
      StampPolicy.decide(
        proposed: proposed, receipt: .entitled, current: record(true, at: 100, source: .receipt)),
      .write(record(true, at: 300, source: .receipt)))
  }

  // MARK: verifiedNotEntitled — lane ownership decides

  func testServerLaneFalseWritesOnVerifiedNotEntitledOverAnyStamp() {
    let proposed = record(false, source: .server)
    XCTAssertEqual(
      StampPolicy.decide(
        proposed: proposed, receipt: .verifiedNotEntitled,
        current: record(true, source: .receipt)),
      .write(proposed))
  }

  func testReceiptLaneFalseWritesOnVerifiedNotEntitledOverReceiptStamp() {
    // AE6: refund (revocationDate observed) clears the receipt-source stamp.
    let proposed = record(false, source: .receipt)
    XCTAssertEqual(
      StampPolicy.decide(
        proposed: proposed, receipt: .verifiedNotEntitled,
        current: record(true, source: .receipt)),
      .write(proposed))
  }

  func testReceiptLaneFalseDropsOnVerifiedNotEntitledOverServerStamp() {
    // Double-purchase user refunds the Apple side: web-granted (server) Pro must survive; only
    // the server lane may downgrade its own grants.
    XCTAssertEqual(
      StampPolicy.decide(
        proposed: record(false, source: .receipt), receipt: .verifiedNotEntitled,
        current: record(true, source: .server)),
      .drop)
  }

  func testReceiptLaneFalseWritesOnVerifiedNotEntitledWithNoStamp() {
    // Refund observed at launch with a wiped App Group: writing false is harmless and correct.
    let proposed = record(false, source: .receipt)
    XCTAssertEqual(
      StampPolicy.decide(proposed: proposed, receipt: .verifiedNotEntitled, current: nil),
      .write(proposed))
  }

  // MARK: noSignal — ambiguity never downgrades a receipt stamp

  func testServerLaneFalseWritesOnNoSignalOverServerStamp() {
    // AE12: sign-out on a web purchaser's Mac (no receipt) re-locks Safari — the ratified
    // shared-machine invariant survives purchase-first.
    let proposed = record(false, source: .server)
    XCTAssertEqual(
      StampPolicy.decide(
        proposed: proposed, receipt: .noSignal, current: record(true, source: .server)),
      .write(proposed))
  }

  func testServerLaneFalseWritesOnNoSignalWithNoStamp() {
    let proposed = record(false, source: .server)
    XCTAssertEqual(
      StampPolicy.decide(proposed: proposed, receipt: .noSignal, current: nil),
      .write(proposed))
  }

  func testServerLaneFalseDropsOnNoSignalOverReceiptStamp() {
    // Cold StoreKit cache during sign-out on a device that bought Pro: receipt-derived Pro
    // survives ambiguity; only verified revocation or a live receipt read may change it.
    XCTAssertEqual(
      StampPolicy.decide(
        proposed: record(false, source: .server), receipt: .noSignal,
        current: record(true, source: .receipt)),
      .drop)
  }

  func testReceiptLaneFalseDropsOnNoSignalAlways() {
    XCTAssertEqual(
      StampPolicy.decide(
        proposed: record(false, source: .receipt), receipt: .noSignal,
        current: record(true, source: .receipt)),
      .drop)
    XCTAssertEqual(
      StampPolicy.decide(
        proposed: record(false, source: .receipt), receipt: .noSignal,
        current: record(true, source: .server)),
      .drop)
    XCTAssertEqual(
      StampPolicy.decide(
        proposed: record(false, source: .receipt), receipt: .noSignal, current: nil),
      .drop)
  }

  // MARK: legacy stamp (build 3, no source field) decodes as server-sourced

  func testLegacyStampWithoutSourceBehavesAsServerSourced() {
    // A build-3 stamp has no source key; it decodes as .server, so a sign-out (server lane,
    // noSignal) may still downgrade it — the pre-migration invariant is preserved.
    let store = SharedEntitlementStore(backing: InMemoryBacking())
    let legacy = #"{"entitled":true,"updatedAt":100}"#.data(using: .utf8)!
    let decoded = try? JSONDecoder().decode(EntitlementRecord.self, from: legacy)
    XCTAssertEqual(decoded, EntitlementRecord(entitled: true, updatedAt: 100, source: .server))
    _ = store // silence unused when assertions compile out
  }
}
