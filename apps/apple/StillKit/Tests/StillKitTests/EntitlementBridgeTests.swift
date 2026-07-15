import XCTest
@testable import StillKit

/// The entitlement lane of the App-Group bridge: parse, policy-routed set, get round-trip, the
/// read-only lane, the receipt-lane entry, and the reply envelope (issue #63 — replies carry the
/// install-generation id, with all keys present as explicit JSON null when absent; the envelope
/// gained `source` in the purchase-first change, plan 2026-07-15-001). Literal-string assertions
/// are deliberate: a regression to synthesized Codable's `encodeIfPresent` (which DROPS nil keys)
/// must fail here, not surface as a silent TS-side contract gap. In-memory backing — the same
/// seam BridgeTests uses.
final class EntitlementBridgeTests: XCTestCase {
  private func bridge(
    _ stored: EntitlementRecord? = nil,
    now: Int = 1_000,
    installId: String? = "install-A",
    receipt: ReceiptStatus = .noSignal,
    readOnly: Bool = false
  ) -> (EntitlementBridge, SharedEntitlementStore) {
    let store = SharedEntitlementStore(backing: InMemoryBacking())
    if let stored { store.save(stored) }
    return (
      EntitlementBridge(
        store: store, now: { now }, installId: { installId },
        receiptStatus: { receipt }, readOnly: readOnly),
      store
    )
  }

  // MARK: parse

  func testParseGet() {
    XCTAssertEqual(EntitlementRequest.parse(["kind": "getEntitlement"]), .get)
  }

  func testParseSet() {
    XCTAssertEqual(
      EntitlementRequest.parse(["kind": "setEntitlement", "entitled": true]),
      .set(entitled: true))
    XCTAssertEqual(
      EntitlementRequest.parse(["kind": "setEntitlement", "entitled": false]),
      .set(entitled: false))
  }

  func testParseRejectsSettingsAndMalformedMessages() {
    XCTAssertNil(EntitlementRequest.parse(["kind": "get"]))                    // settings lane
    XCTAssertNil(EntitlementRequest.parse(["kind": "set", "settings": "{}"])) // settings lane
    XCTAssertNil(EntitlementRequest.parse(["kind": "setEntitlement"]))         // missing bool
    XCTAssertNil(EntitlementRequest.parse(["kind": "setEntitlement", "entitled": "yes"]))
    XCTAssertNil(EntitlementRequest.parse("not a dict"))
  }

  // MARK: get / set

  func testGetAgainstEmptyStoreRepliesMarkerOnlyEnvelope() {
    // The post-reinstall state (issue #63): App Group has the install marker but no entitlement
    // record. All four keys present, entitlement fields explicit null — literal string so an
    // encodeIfPresent regression (dropped keys) fails loudly.
    let (bridge, _) = bridge()
    XCTAssertEqual(
      bridge.handle(.get),
      #"{"entitled":null,"installId":"install-A","source":null,"updatedAt":null}"#)
  }

  func testGetWithDegradedAppGroupRepliesAllNullEnvelope() {
    // Old app build / unprovisioned App Group: no marker either. Still a full envelope.
    let (bridge, _) = bridge(installId: nil)
    XCTAssertEqual(
      bridge.handle(.get),
      #"{"entitled":null,"installId":null,"source":null,"updatedAt":null}"#)
  }

  func testSetStampsClockAndPersists() {
    let (bridge, store) = bridge(now: 42_000)
    let reply = bridge.handle(.set(entitled: true))
    XCTAssertEqual(
      reply,
      #"{"entitled":true,"installId":"install-A","source":"server","updatedAt":42000}"#)
    XCTAssertEqual(
      store.peek(), EntitlementRecord(entitled: true, updatedAt: 42_000, source: .server))
  }

  func testGetRoundTripsStoredRecord() {
    let record = EntitlementRecord(entitled: true, updatedAt: 7)
    let (bridge, _) = bridge(record)
    XCTAssertEqual(
      bridge.handle(.get),
      #"{"entitled":true,"installId":"install-A","source":"server","updatedAt":7}"#)
  }

  func testGetWithStoredRecordButNoMarkerRepliesExplicitNullInstallId() {
    // Record present, marker absent (degraded App Group / pre-marker build): installId must still
    // appear as explicit null, never a dropped key.
    let record = EntitlementRecord(entitled: true, updatedAt: 7)
    let (bridge, _) = bridge(record, installId: nil)
    XCTAssertEqual(
      bridge.handle(.get),
      #"{"entitled":true,"installId":null,"source":"server","updatedAt":7}"#)
  }

  func testServerRevocationOverwritesWhenReceiptSilent() {
    // Server-lane false over a server-source stamp with a cold receipt (noSignal): writes —
    // account-derived Pro leaves with the account (AE12 semantics at the bridge).
    let (bridge, store) = bridge(EntitlementRecord(entitled: true, updatedAt: 7), now: 9)
    _ = bridge.handle(.set(entitled: false))
    XCTAssertEqual(
      store.peek(), EntitlementRecord(entitled: false, updatedAt: 9, source: .server))
  }

  func testHandleRawBodyFallsThroughForNonEntitlementMessages() {
    let (bridge, _) = bridge()
    XCTAssertNil(bridge.handle(rawBody: ["kind": "get"]))
    XCTAssertEqual(
      bridge.handle(rawBody: ["kind": "getEntitlement"]),
      #"{"entitled":null,"installId":"install-A","source":null,"updatedAt":null}"#)
  }

  // MARK: policy through the bridge (R13 — the enforcement seat is HERE, not the router)

  func testBlockedSignOutDowngradeRestampsReceiptTrue() {
    // AE2 at the bridge: sign-out proposes false, the live receipt says entitled — the write is
    // blocked and converted into a fresher receipt-true stamp; the reply reflects the survivor.
    let (bridge, store) = bridge(
      EntitlementRecord(entitled: true, updatedAt: 7, source: .server), now: 99,
      receipt: .entitled)
    let reply = bridge.handle(.set(entitled: false))
    XCTAssertEqual(
      store.peek(), EntitlementRecord(entitled: true, updatedAt: 99, source: .receipt))
    XCTAssertEqual(
      reply,
      #"{"entitled":true,"installId":"install-A","source":"receipt","updatedAt":99}"#)
  }

  func testServerFalseDroppedOverReceiptStampOnNoSignal() {
    // Cold cache during sign-out on a device that bought Pro: the receipt-source stamp survives.
    let (bridge, store) = bridge(
      EntitlementRecord(entitled: true, updatedAt: 7, source: .receipt), now: 99)
    let reply = bridge.handle(.set(entitled: false))
    XCTAssertEqual(
      store.peek(), EntitlementRecord(entitled: true, updatedAt: 7, source: .receipt))
    XCTAssertEqual(
      reply,
      #"{"entitled":true,"installId":"install-A","source":"receipt","updatedAt":7}"#)
  }

  // MARK: read-only lane (the Safari extension handler)

  func testReadOnlyBridgeRefusesSetWithoutWriting() {
    // The extension process must never write the stamp — a writable lane would be an
    // entitlement-forgery surface. The refusal replies with current state and mutates nothing.
    let (bridge, store) = bridge(
      EntitlementRecord(entitled: true, updatedAt: 7), now: 99, readOnly: true)
    let reply = bridge.handle(.set(entitled: false))
    XCTAssertEqual(store.peek(), EntitlementRecord(entitled: true, updatedAt: 7, source: .server))
    XCTAssertEqual(
      reply,
      #"{"entitled":true,"installId":"install-A","source":"server","updatedAt":7}"#)
  }

  func testReadOnlyBridgeStillReplies() {
    let (bridge, _) = bridge(readOnly: true)
    XCTAssertEqual(
      bridge.handle(.get),
      #"{"entitled":null,"installId":"install-A","source":null,"updatedAt":null}"#)
  }

  // MARK: receipt lane (native launch/foreground/purchase/restore restamps)

  func testApplyReceiptEntitledStampsReceiptTrue() {
    let (bridge, store) = bridge(now: 500, receipt: .entitled)
    let result = bridge.applyReceipt(.entitled)
    XCTAssertEqual(result, EntitlementRecord(entitled: true, updatedAt: 500, source: .receipt))
    XCTAssertEqual(store.peek(), result)
  }

  func testApplyReceiptNoSignalProposesNothing() {
    let stored = EntitlementRecord(entitled: true, updatedAt: 7, source: .receipt)
    let (bridge, store) = bridge(stored, now: 500)
    XCTAssertEqual(bridge.applyReceipt(.noSignal), stored)
    XCTAssertEqual(store.peek(), stored)
  }

  func testApplyReceiptRevocationClearsReceiptStamp() {
    // AE6: a verified revocation clears the receipt-source stamp.
    let (bridge, store) = bridge(
      EntitlementRecord(entitled: true, updatedAt: 7, source: .receipt), now: 500,
      receipt: .verifiedNotEntitled)
    _ = bridge.applyReceipt(.verifiedNotEntitled)
    XCTAssertEqual(
      store.peek(), EntitlementRecord(entitled: false, updatedAt: 500, source: .receipt))
  }

  func testReadOnlyBridgeRefusesApplyReceipt() {
    // The receipt lane is app-process-only: a read-only bridge (the extension handler) must
    // refuse applyReceipt exactly like set proposals (testing review pin).
    let stored = EntitlementRecord(entitled: true, updatedAt: 7, source: .server)
    let (bridge, store) = bridge(stored, now: 500, receipt: .entitled, readOnly: true)
    XCTAssertEqual(bridge.applyReceipt(.entitled), stored)
    XCTAssertEqual(store.peek(), stored)
  }

  func testApplyReceiptRevocationNeverClobbersServerStamp() {
    // Double-purchase user refunds the Apple side: web-granted (server) Pro survives.
    let stored = EntitlementRecord(entitled: true, updatedAt: 7, source: .server)
    let (bridge, store) = bridge(stored, now: 500, receipt: .verifiedNotEntitled)
    XCTAssertEqual(bridge.applyReceipt(.verifiedNotEntitled), stored)
    XCTAssertEqual(store.peek(), stored)
  }
}
