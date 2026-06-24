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
    XCTAssertFalse(decoded.globalOn)
    XCTAssertEqual(decoded.updatedAt, 42)
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
    let decoded = try JSONDecoder().decode(StillSettings.self, from: Data(reply.utf8))
    XCTAssertFalse(decoded.globalOn)
    XCTAssertEqual(decoded.updatedAt, 7)
  }

  // MARK: set + last-write-wins

  func testSetNewerWritesAndEchoesIt() throws {
    let (bridge, store) = bridge(settings(globalOn: true, updatedAt: 100))
    let reply = bridge.handle(.set(settings(globalOn: false, updatedAt: 200)))
    XCTAssertFalse(store.current().globalOn)
    XCTAssertEqual(store.current().updatedAt, 200)
    let echoed = try JSONDecoder().decode(StillSettings.self, from: Data(reply.utf8))
    XCTAssertEqual(echoed.updatedAt, 200)
  }

  /// A stale `set` (lower updatedAt) is ignored, and the reply hands the web side the newer value the
  /// App Group already held — so the web cache reconciles instead of silently clobbering (KTD4).
  func testSetStaleIsIgnoredAndEchoesTheKeptValue() throws {
    let (bridge, store) = bridge(settings(globalOn: true, updatedAt: 500))
    let reply = bridge.handle(.set(settings(globalOn: false, updatedAt: 400)))
    XCTAssertTrue(store.current().globalOn)            // unchanged
    XCTAssertEqual(store.current().updatedAt, 500)
    let echoed = try JSONDecoder().decode(StillSettings.self, from: Data(reply.utf8))
    XCTAssertTrue(echoed.globalOn)                     // the kept (newer) value, not the stale write
    XCTAssertEqual(echoed.updatedAt, 500)
  }

  func testSetOnEmptyStoreAccepts() {
    let (bridge, store) = bridge()
    _ = bridge.handle(.set(settings(globalOn: false, updatedAt: 1)))
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
    let decoded = try JSONDecoder().decode(StillSettings.self, from: Data(getReply.utf8))
    XCTAssertEqual(decoded.updatedAt, 1782264630248)   // survives the JS Date.now()-sized millis
    XCTAssertFalse(decoded.globalOn)
  }

  func testRawBodyReturnsNilForGarbage() {
    let (bridge, _) = bridge()
    XCTAssertNil(bridge.handle(rawBody: ["kind": "nonsense"]))
  }
}
