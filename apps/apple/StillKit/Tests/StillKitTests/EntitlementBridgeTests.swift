import XCTest
@testable import StillKit

/// The entitlement lane of the App-Group bridge: parse, set-stamps-updatedAt, get round-trip, and
/// the empty-store reply. In-memory backing — the same seam BridgeTests uses.
final class EntitlementBridgeTests: XCTestCase {
  private func bridge(
    _ stored: EntitlementRecord? = nil,
    now: Int = 1_000
  ) -> (EntitlementBridge, SharedEntitlementStore) {
    let store = SharedEntitlementStore(backing: InMemoryBacking())
    if let stored { store.save(stored) }
    return (EntitlementBridge(store: store, now: { now }), store)
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

  func testGetAgainstEmptyStoreRepliesEmpty() {
    let (bridge, _) = bridge()
    XCTAssertEqual(bridge.handle(.get), "")
  }

  func testSetStampsClockAndPersists() throws {
    let (bridge, store) = bridge(now: 42_000)
    let reply = bridge.handle(.set(entitled: true))
    let decoded = try JSONDecoder().decode(EntitlementRecord.self, from: Data(reply.utf8))
    XCTAssertEqual(decoded, EntitlementRecord(entitled: true, updatedAt: 42_000))
    XCTAssertEqual(store.peek(), decoded)
  }

  func testGetRoundTripsStoredRecord() throws {
    let record = EntitlementRecord(entitled: true, updatedAt: 7)
    let (bridge, _) = bridge(record)
    let reply = bridge.handle(.get)
    let decoded = try JSONDecoder().decode(EntitlementRecord.self, from: Data(reply.utf8))
    XCTAssertEqual(decoded, record)
  }

  func testRevocationOverwrites() {
    let (bridge, store) = bridge(EntitlementRecord(entitled: true, updatedAt: 7), now: 9)
    _ = bridge.handle(.set(entitled: false))
    XCTAssertEqual(store.peek(), EntitlementRecord(entitled: false, updatedAt: 9))
  }

  func testHandleRawBodyFallsThroughForNonEntitlementMessages() {
    let (bridge, _) = bridge()
    XCTAssertNil(bridge.handle(rawBody: ["kind": "get"]))
    XCTAssertEqual(bridge.handle(rawBody: ["kind": "getEntitlement"]), "")
  }
}
