import XCTest
@testable import StillKit

/// The web ↔ native bridge (KTD4): message encode/decode, last-write-wins on `set`, and stale
/// acknowledgments. These run with an in-memory backing — no WebKit, signing, or device — so the
/// conflict logic the human Xcode build exercises on-device is already proven here.
final class BridgeTests: XCTestCase {
  private func bridge(_ stored: StillSettings? = nil) -> (SettingsBridge, SharedSettingsStore) {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    if let stored { store.save(stored) }
    return (SettingsBridge(store: store), store)
  }

  private func settings(globalOn: Bool = true, updatedAt: Int) -> StillSettings {
    StillSettings(globalOn: globalOn, services: StillServices(), pauses: [], updatedAt: updatedAt)
  }

  // MARK: parse

  func testParseGet() {
    XCTAssertEqual(BridgeRequest.parse(["kind": "get"]), .get)
  }

  func testParseSetDecodesSettings() throws {
    let json = SettingsBridge.encode(settings(globalOn: false, updatedAt: 42))
    let request = BridgeRequest.parse(["kind": "set", "settings": json])
    guard case let .set(decoded) = request else { return XCTFail("expected .set") }
    XCTAssertFalse(decoded.settings.globalOn)
    XCTAssertEqual(decoded.settings.updatedAt, 42)
    XCTAssertNil(decoded.syncMetadata)
  }

  func testParseRejectsUnknownAndMalformed() {
    XCTAssertNil(BridgeRequest.parse(["kind": "delete"]))            // unknown kind
    XCTAssertNil(BridgeRequest.parse(["kind": "set"]))               // set without settings
    XCTAssertNil(BridgeRequest.parse(["kind": "set", "settings": "{not json"]))
    XCTAssertNil(BridgeRequest.parse("not a dict"))
    XCTAssertNil(BridgeRequest.parse(["nokind": true]))
  }

  // MARK: get

  func testGetOnEmptyStoreReturnsEmptyString() {
    let (bridge, _) = bridge()
    XCTAssertEqual(bridge.handle(.get), "")
  }

  func testGetReturnsStoredSettingsAsJSON() throws {
    let (bridge, _) = bridge(settings(globalOn: false, updatedAt: 7))
    let reply = bridge.handle(.get)
    let decoded = try JSONDecoder().decode(StoredSettingsRecord.self, from: Data(reply.utf8))
    XCTAssertFalse(decoded.settings.globalOn)
    XCTAssertEqual(decoded.settings.updatedAt, 7)
  }

  // MARK: set + last-write-wins

  func testSetNewerWritesAndEchoesIt() throws {
    let (bridge, store) = bridge(settings(globalOn: true, updatedAt: 100))
    let reply = bridge.handle(.set(StoredSettingsRecord(settings: settings(globalOn: false, updatedAt: 200), syncMetadata: nil)))
    XCTAssertFalse(store.current().globalOn)
    XCTAssertEqual(store.current().updatedAt, 200)
    let echoed = try JSONDecoder().decode(StoredSettingsRecord.self, from: Data(reply.utf8))
    XCTAssertEqual(echoed.settings.updatedAt, 200)
  }

  /// The cross-process change signal fires ONLY when a `set` actually changed the store: an applied
  /// write notifies once, a stale/echoed write notifies never — the no-ping-pong invariant the app ↔
  /// extension Darwin bridge relies on. Uses the injected notifier, so no real system-wide Darwin
  /// notification is posted from tests.
  func testSetNotifiesOnlyWhenTheStoreActuallyChanged() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    store.save(settings(globalOn: true, updatedAt: 100))
    var notifications = 0
    let bridge = SettingsBridge(store: store, notifyChanged: { notifications += 1 })

    _ = bridge.handle(.set(StoredSettingsRecord(settings: settings(globalOn: false, updatedAt: 200), syncMetadata: nil)))
    XCTAssertEqual(notifications, 1)                   // applied → one broadcast

    _ = bridge.handle(.set(StoredSettingsRecord(settings: settings(globalOn: true, updatedAt: 150), syncMetadata: nil)))
    XCTAssertEqual(notifications, 1)                   // stale → ignored, no broadcast

    _ = bridge.handle(.get)
    XCTAssertEqual(notifications, 1)                   // reads never broadcast
  }

  /// A stale `set` (lower updatedAt) is ignored, and the reply hands the web side the newer value the
  /// App Group already held — so the web cache reconciles instead of silently clobbering (KTD4).
  func testSetStaleIsIgnoredAndEchoesTheKeptValue() throws {
    let (bridge, store) = bridge(settings(globalOn: true, updatedAt: 500))
    let reply = bridge.handle(.set(StoredSettingsRecord(settings: settings(globalOn: false, updatedAt: 400), syncMetadata: nil)))
    XCTAssertTrue(store.current().globalOn)            // unchanged
    XCTAssertEqual(store.current().updatedAt, 500)
    let echoed = try JSONDecoder().decode(StoredSettingsRecord.self, from: Data(reply.utf8))
    XCTAssertTrue(echoed.settings.globalOn)            // the kept (newer) value, not the stale write
    XCTAssertEqual(echoed.settings.updatedAt, 500)
  }

  func testSetOnEmptyStoreAccepts() {
    let (bridge, store) = bridge()
    _ = bridge.handle(.set(StoredSettingsRecord(settings: settings(globalOn: false, updatedAt: 1), syncMetadata: nil)))
    XCTAssertEqual(store.current().updatedAt, 1)
    XCTAssertFalse(store.current().globalOn)
  }

  // MARK: raw body round-trip (the path the WKScriptMessageHandler / SafariWebExtensionHandler take)

  func testRawBodySetThenGetRoundTrips() throws {
    let (bridge, _) = bridge()
    let json = SettingsBridge.encode(settings(globalOn: false, updatedAt: 1782264630248))
    let setReply = bridge.handle(rawBody: ["kind": "set", "settings": json])
    XCTAssertNotNil(setReply)
    let getReply = try XCTUnwrap(bridge.handle(rawBody: ["kind": "get"]))
    let decoded = try JSONDecoder().decode(StoredSettingsRecord.self, from: Data(getReply.utf8))
    XCTAssertEqual(decoded.settings.updatedAt, 1782264630248)   // survives the JS Date.now()-sized millis
    XCTAssertFalse(decoded.settings.globalOn)
  }

  func testMetadataRecordRoundTrips() throws {
    let metadata = SettingsSyncMetadata(version: 4, serverUpdatedAt: "2026-07-09T18:00:00.000Z", lastWriteId: "w1")
    let record = StoredSettingsRecord(settings: settings(globalOn: false, updatedAt: 1), syncMetadata: metadata)
    let (bridge, store) = bridge()
    let reply = bridge.handle(.set(record))
    XCTAssertEqual(store.currentRecord().syncMetadata, metadata)
    let echoed = try JSONDecoder().decode(StoredSettingsRecord.self, from: Data(reply.utf8))
    XCTAssertEqual(echoed.syncMetadata, metadata)
  }

  func testRawBodyReturnsNilForGarbage() {
    let (bridge, _) = bridge()
    XCTAssertNil(bridge.handle(rawBody: ["kind": "nonsense"]))
  }
}
