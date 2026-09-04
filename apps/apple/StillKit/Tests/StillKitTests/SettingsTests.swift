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

  /// The first-sign-in merge is decided once, in the shared core, and the app must carry whichever
  /// side won without re-judging it. Both directions are checked here, because getting one of them
  /// wrong would leave the app and the Safari extension showing different settings from the web UI
  /// until the next reconcile.
  ///
  /// Direction one: the account was the more recently changed side, so the core hands down the
  /// account's settings. They land even though their device timestamp is OLDER than what this
  /// device has stored, which is exactly the case a naive timestamp comparison would reject.
  func testAnAccountThatWonTheFirstSignInMergeLandsEvenWithAnOlderDeviceTimestamp() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    store.save(StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 9_000))

    let accountWon = StoredSettingsRecord(
      settings: StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 7),
      syncMetadata: SettingsSyncMetadata(
        version: 1, serverUpdatedAt: "2026-09-01T10:00:00.000Z", lastWriteId: "w1"))

    XCTAssertTrue(store.applyRecord(accountWon))
    XCTAssertFalse(store.current().globalOn)
    XCTAssertEqual(store.currentRecord().syncMetadata?.version, 1)
  }

  /// Direction two: this device was the more recently changed side, so the core published the
  /// device's settings and the account echoed them back with server metadata attached. The record
  /// that lands therefore carries the device's own values, unchanged.
  func testADeviceThatWonTheFirstSignInMergeKeepsItsOwnSettings() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    let deviceSettings = StillSettings(
      globalOn: true, services: StillServices(youtube: false, instagram: true, tiktok: true, facebook: true),
      pauses: [], updatedAt: 9_000)
    store.save(deviceSettings)

    let publishedAndEchoedBack = StoredSettingsRecord(
      settings: deviceSettings,
      syncMetadata: SettingsSyncMetadata(
        version: 1, serverUpdatedAt: "2026-09-01T10:00:00.000Z", lastWriteId: "w2"))

    XCTAssertTrue(store.applyRecord(publishedAndEchoedBack))
    XCTAssertTrue(store.current().globalOn)
    XCTAssertFalse(store.current().services.youtube)
    XCTAssertEqual(store.currentRecord().syncMetadata?.lastWriteId, "w2")
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

  func testBridgeAcceptsARecordCarryingTheBrowserSideReconcileCounter() throws {
    // The web side stamps every record it persists with `syncEpoch`, a browser-local counter of
    // which account that browser profile is pointed at. It is meaningless here and this decoder
    // drops it, which is exactly what the web side expects: a record that comes back without one
    // is judged the way it always was. What must not happen is the record being rejected for
    // carrying it, because that would strand the app's own settings on the far side of the bridge.
    let store = SharedSettingsStore(backing: InMemoryBacking())
    let bridge = SettingsBridge(store: store)
    let json = """
    { "settings": { "globalOn": true, "services": { "youtube": true, "instagram": true, "tiktok": true, "facebook": true }, "pauses": [], "updatedAt": 10 }, "syncMetadata": null, "syncEpoch": 3 }
    """

    let reply = try XCTUnwrap(bridge.handle(rawBody: ["kind": "set", "settings": json]))
    let echoed = try JSONDecoder().decode(StoredSettingsRecord.self, from: Data(reply.utf8))
    XCTAssertTrue(echoed.settings.services.youtube)
    XCTAssertEqual(echoed.settings.updatedAt, 10)
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
