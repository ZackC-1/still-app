import XCTest
@testable import StillKit

final class SettingsTests: XCTestCase {
  func testDefaultsMatchTheWebSide() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    XCTAssertEqual(store.current(), .default)
    XCTAssertTrue(StillSettings.default.globalOn)
    XCTAssertTrue(StillSettings.default.services.youtube)
  }

  func testRoundTrip() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    var settings = StillSettings.default
    settings.services.youtube = false
    settings.updatedAt = 100
    store.save(settings)
    XCTAssertEqual(store.current().services.youtube, false)
    XCTAssertEqual(store.current().updatedAt, 100)
  }

  /// The JSON must match the TypeScript StillSettings exactly, or the WKWebView UI can't read it.
  func testJSONShapeMatchesWebUI() throws {
    let settings = StillSettings(
      globalOn: true,
      services: StillServices(youtube: false, instagram: true, tiktok: true, facebook: true),
      pauses: ["youtube.com"],
      updatedAt: 5,
    )
    let data = try JSONEncoder().encode(settings)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(object["globalOn"] as? Bool, true)
    XCTAssertEqual(object["pauses"] as? [String], ["youtube.com"])
    XCTAssertEqual(object["updatedAt"] as? Int, 5)
    let services = try XCTUnwrap(object["services"] as? [String: Any])
    XCTAssertEqual(services["youtube"] as? Bool, false)
    XCTAssertEqual(services["facebook"] as? Bool, true)
  }

  func testLastWriteWins() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    store.save(StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 50))

    // An older incoming set is ignored.
    XCTAssertFalse(store.applyRemote(StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 40)))
    XCTAssertTrue(store.current().globalOn)

    // A newer incoming set wins.
    XCTAssertTrue(store.applyRemote(StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 60)))
    XCTAssertFalse(store.current().globalOn)
  }

  /// Issue: a synced user's popup/extension edit stamps a newer settings.updatedAt but keeps the
  /// same sync metadata (version + serverUpdatedAt). shouldApply must accept it on an equal server
  /// base, or those edits are silently dropped — matching the web SettingsCache's LWW fallthrough.
  func testMetadataTieBreaksOnSettingsUpdatedAt() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    let meta = SettingsSyncMetadata(version: 3, serverUpdatedAt: "2026-07-09T18:00:00.000Z", lastWriteId: "w1")
    store.saveRecord(StoredSettingsRecord(
      settings: StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 100),
      syncMetadata: meta))

    // A local dirty edit: same metadata, newer settings.updatedAt, changed content → must win.
    let localEdit = StoredSettingsRecord(
      settings: StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 200),
      syncMetadata: meta)
    XCTAssertTrue(store.applyRecord(localEdit))
    XCTAssertFalse(store.current().globalOn)

    // An older-timestamped same-metadata write is still ignored.
    let stale = StoredSettingsRecord(
      settings: StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 150),
      syncMetadata: meta)
    XCTAssertFalse(store.applyRecord(stale))
    XCTAssertFalse(store.current().globalOn)

    // A higher server version still wins regardless of settings.updatedAt (server authority).
    let newerServer = StoredSettingsRecord(
      settings: StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 10),
      syncMetadata: SettingsSyncMetadata(version: 4, serverUpdatedAt: "2026-07-09T17:00:00.000Z", lastWriteId: "w2"))
    XCTAssertTrue(store.applyRecord(newerServer))
    XCTAssertTrue(store.current().globalOn)
  }

  /// A web-written JSON blob decodes into the Swift model (interop direction: web → native).
  func testDecodesWebWrittenJSON() throws {
    let json = """
    { "globalOn": false, "services": { "youtube": true, "instagram": false, "tiktok": true, "facebook": true }, "pauses": ["instagram.com"], "updatedAt": 1782264630248 }
    """
    let settings = try JSONDecoder().decode(StillSettings.self, from: Data(json.utf8))
    XCTAssertFalse(settings.globalOn)
    XCTAssertFalse(settings.services.instagram)
    XCTAssertEqual(settings.pauses, ["instagram.com"])
    XCTAssertEqual(settings.updatedAt, 1782264630248)
  }

  func testDecodesBackCompatBlobWithAbsentFields() throws {
    let json = """
    { "globalOn": true, "services": { "youtube": true }, "updatedAt": 1782264630248 }
    """
    let settings = try JSONDecoder().decode(StillSettings.self, from: Data(json.utf8))
    XCTAssertTrue(settings.globalOn)
    XCTAssertTrue(settings.services.youtube)
    XCTAssertFalse(settings.services.instagram)
    XCTAssertFalse(settings.services.tiktok)
    XCTAssertFalse(settings.services.facebook)
    XCTAssertEqual(settings.pauses, [])
  }

  func testBridgeAcceptsBackCompatBlobWithAbsentFields() throws {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    let bridge = SettingsBridge(store: store)
    let json = """
    { "globalOn": true, "services": { "youtube": true }, "updatedAt": 10 }
    """

    let reply = try XCTUnwrap(bridge.handle(rawBody: ["kind": "set", "settings": json]))
    let echoed = try JSONDecoder().decode(StoredSettingsRecord.self, from: Data(reply.utf8))
    XCTAssertTrue(echoed.settings.services.youtube)
    XCTAssertFalse(echoed.settings.services.instagram)
    XCTAssertEqual(echoed.settings.pauses, [])
    XCTAssertNil(echoed.syncMetadata)
  }

  func testBridgeDropsUnknownEntitlementFields() throws {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    let bridge = SettingsBridge(store: store)
    let json = """
    { "globalOn": true, "services": { "youtube": true, "instagram": true, "tiktok": true, "facebook": true, "entitlement": true }, "pauses": [], "updatedAt": 10, "entitlement": { "pro": true } }
    """

    let reply = try XCTUnwrap(bridge.handle(rawBody: ["kind": "set", "settings": json]))
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any])
    XCTAssertNil(object["entitlement"])
    let settings = try XCTUnwrap(object["settings"] as? [String: Any])
    XCTAssertNil(settings["entitlement"])
    let services = try XCTUnwrap(settings["services"] as? [String: Any])
    XCTAssertNil(services["entitlement"])
  }
}
