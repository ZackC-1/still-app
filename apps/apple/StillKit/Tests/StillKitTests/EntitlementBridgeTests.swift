import XCTest
@testable import StillKit

/// The entitlement lane of the App-Group bridge: parse, set-stamps-updatedAt, get round-trip, and
/// the reply envelope (issue #63 — replies carry the install-generation id, with all keys present
/// as explicit JSON null when absent). Literal-string assertions are deliberate: a regression to
/// synthesized Codable's `encodeIfPresent` (which DROPS nil keys) must fail here, not surface as a
/// silent TS-side contract gap. In-memory backing — the same seam BridgeTests uses.
final class EntitlementBridgeTests: XCTestCase {
  private func bridge(
    _ stored: EntitlementRecord? = nil,
    now: Int = 1_000,
    installId: String? = "install-A"
  ) -> (EntitlementBridge, SharedEntitlementStore) {
    let store = SharedEntitlementStore(backing: InMemoryBacking())
    if let stored { store.save(stored) }
    return (EntitlementBridge(store: store, now: { now }, installId: { installId }), store)
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
    // record. All three keys present, entitlement fields explicit null — literal string so an
    // encodeIfPresent regression (dropped keys) fails loudly.
    let (bridge, _) = bridge()
    XCTAssertEqual(
      bridge.handle(.get),
      #"{"entitled":null,"installId":"install-A","updatedAt":null}"#)
  }

  func testGetWithDegradedAppGroupRepliesAllNullEnvelope() {
    // Old app build / unprovisioned App Group: no marker either. Still a full envelope.
    let (bridge, _) = bridge(installId: nil)
    XCTAssertEqual(
      bridge.handle(.get),
      #"{"entitled":null,"installId":null,"updatedAt":null}"#)
  }

  func testSetStampsClockAndPersists() {
    let (bridge, store) = bridge(now: 42_000)
    let reply = bridge.handle(.set(entitled: true))
    XCTAssertEqual(reply, #"{"entitled":true,"installId":"install-A","updatedAt":42000}"#)
    XCTAssertEqual(store.peek(), EntitlementRecord(entitled: true, updatedAt: 42_000))
  }

  func testGetRoundTripsStoredRecord() {
    let record = EntitlementRecord(entitled: true, updatedAt: 7)
    let (bridge, _) = bridge(record)
    XCTAssertEqual(
      bridge.handle(.get),
      #"{"entitled":true,"installId":"install-A","updatedAt":7}"#)
  }

  func testGetWithStoredRecordButNoMarkerRepliesExplicitNullInstallId() {
    // Record present, marker absent (degraded App Group / pre-marker build): installId must still
    // appear as explicit null, never a dropped key.
    let record = EntitlementRecord(entitled: true, updatedAt: 7)
    let (bridge, _) = bridge(record, installId: nil)
    XCTAssertEqual(
      bridge.handle(.get),
      #"{"entitled":true,"installId":null,"updatedAt":7}"#)
  }

  func testRevocationOverwrites() {
    let (bridge, store) = bridge(EntitlementRecord(entitled: true, updatedAt: 7), now: 9)
    _ = bridge.handle(.set(entitled: false))
    XCTAssertEqual(store.peek(), EntitlementRecord(entitled: false, updatedAt: 9))
  }

  func testHandleRawBodyFallsThroughForNonEntitlementMessages() {
    let (bridge, _) = bridge()
    XCTAssertNil(bridge.handle(rawBody: ["kind": "get"]))
    XCTAssertEqual(
      bridge.handle(rawBody: ["kind": "getEntitlement"]),
      #"{"entitled":null,"installId":"install-A","updatedAt":null}"#)
  }
}
