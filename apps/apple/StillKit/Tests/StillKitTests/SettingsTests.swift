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

  // MARK: - Two people, one device

  /// Alice's account, as it sits in the shared container after she has used this device for a
  /// while: everything switched off, a settings row saved many times over, and one repoint on the
  /// clock from the sign-in that pointed this device at her.
  private func alicesRecord() -> StoredSettingsRecord {
    StoredSettingsRecord(
      settings: StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 9_000),
      syncMetadata: SettingsSyncMetadata(
        version: 99, serverUpdatedAt: "2026-09-01T10:00:00.000Z", lastWriteId: "alice"),
      syncEpoch: 1)
  }

  /// Bob signs in on the same device after Alice signs out. His account is new, so it is on a much
  /// lower version than the one Alice left behind, and its settings carry an older timestamp. The
  /// raised repoint counter is the shared core saying it has already decided this account is what
  /// this device is now pointed at.
  private func bobsRecord() -> StoredSettingsRecord {
    StoredSettingsRecord(
      settings: StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 12),
      syncMetadata: SettingsSyncMetadata(
        version: 3, serverUpdatedAt: "2026-08-01T10:00:00.000Z", lastWriteId: "bob"),
      syncEpoch: 2)
  }

  /// The shared-device case this container used to get wrong, driven the way the app drives it: as
  /// a bridge `set`, because the harm was never only that the write was refused. The reply to a
  /// refused write is whatever the container still holds, the web layer takes that reply as the
  /// resolved truth, and Alice's settings were then published into Bob's account. So both halves
  /// are asserted: what the container keeps, and what it says back.
  func testASecondPersonSigningInGetsTheirOwnSettingsAndTheFirstPersonsAreNotHandedBack() throws {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    let bridge = SettingsBridge(store: store, notifyChanged: {})
    store.saveRecord(alicesRecord())

    let reply = try XCTUnwrap(bridge.handle(rawBody: [
      "kind": "set", "settings": SettingsBridge.encodeRecord(bobsRecord()),
    ]))
    let resolved = try JSONDecoder().decode(StoredSettingsRecord.self, from: Data(reply.utf8))

    XCTAssertTrue(store.current().globalOn)
    XCTAssertEqual(store.currentRecord().syncMetadata?.lastWriteId, "bob")
    XCTAssertEqual(store.currentRecord().syncEpoch, 2)
    XCTAssertTrue(resolved.settings.globalOn)
    XCTAssertEqual(resolved.syncMetadata?.lastWriteId, "bob")
  }

  /// The same device, updated from a build that had no repoint counter at all. The record left
  /// behind cannot say how many times it has been repointed, and the honest answer is none, so it
  /// must not outrank a record that has been repointed however high its version happens to be.
  func testARecordWithNoRepointCounterCannotDisplaceARepointedOne() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    store.saveRecord(bobsRecord())

    var alicesOldBuildRecord = alicesRecord()
    alicesOldBuildRecord.syncEpoch = nil

    XCTAssertFalse(store.applyRecord(alicesOldBuildRecord))
    XCTAssertTrue(store.current().globalOn)
    XCTAssertEqual(store.currentRecord().syncMetadata?.lastWriteId, "bob")
  }

  /// Saving bare settings says what the settings are, not which account this device is pointed at.
  /// If that write reset the counter, the very next record from the previous account would look
  /// like the higher-ranked one again and the whole guarantee would last exactly one save.
  func testSavingBareSettingsKeepsTheRepointCounter() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    store.saveRecord(bobsRecord())

    store.save(StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 20))

    XCTAssertEqual(store.currentRecord().syncEpoch, 2)
    XCTAssertFalse(store.applyRecord(alicesRecord()))
    XCTAssertEqual(store.currentRecord().syncMetadata?.lastWriteId, "bob")
  }

  /// The same rule on the other write path. `applyRemote` takes bare settings with no sync
  /// metadata, which say what the settings are and nothing about which account this device is
  /// pointed at, so it has to carry the counter through as well. Proved directly rather than in
  /// passing: no shipped caller reaches this method today, so nothing else would notice.
  func testApplyingBareRemoteSettingsKeepsTheRepointCounter() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    store.saveRecord(StoredSettingsRecord(
      settings: StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 12),
      syncMetadata: nil,
      syncEpoch: 2))

    XCTAssertTrue(store.applyRemote(
      StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 30)))

    XCTAssertEqual(store.currentRecord().syncEpoch, 2)
    XCTAssertFalse(
      store.applyRecord(alicesRecord()),
      "the counter has to survive this write, or the previous account's record wins again"
    )
  }

  /// Within one account nothing about the ordering changes: the server version still decides, and
  /// the counter answers only the question of whether two records belong to the same account.
  func testWithinOneAccountTheServerVersionStillDecides() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    store.saveRecord(StoredSettingsRecord(
      settings: StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 9_000),
      syncMetadata: SettingsSyncMetadata(
        version: 4, serverUpdatedAt: "2026-09-01T10:00:00.000Z", lastWriteId: "w1"),
      syncEpoch: 2))

    let laterWriteOnTheSameAccount = StoredSettingsRecord(
      settings: StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 12),
      syncMetadata: SettingsSyncMetadata(
        version: 5, serverUpdatedAt: "2026-09-01T11:00:00.000Z", lastWriteId: "w2"),
      syncEpoch: 2)

    XCTAssertTrue(store.applyRecord(laterWriteOnTheSameAccount))
    XCTAssertFalse(store.current().globalOn)
    XCTAssertEqual(store.currentRecord().syncEpoch, 2)

    // And the version is what decides, not the server timestamp beside it. Every other record in
    // this file moves the two together, so either one alone would carry those assertions; this pair
    // disagrees on purpose, which leaves the version as the only thing that can answer.
    let higherVersionWithAnEarlierServerStamp = StoredSettingsRecord(
      settings: StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 3),
      syncMetadata: SettingsSyncMetadata(
        version: 6, serverUpdatedAt: "2026-08-01T10:00:00.000Z", lastWriteId: "w3"),
      syncEpoch: 2)

    XCTAssertTrue(store.applyRecord(higherVersionWithAnEarlierServerStamp))
    XCTAssertEqual(store.currentRecord().syncMetadata?.version, 6)
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

  /// `syncEpoch` counts how many times a sign-in has repointed a device at a different account.
  /// The web side stamps every record it persists with it, and this side has to carry it back
  /// unchanged: the shared container, the app and the Safari extension all order records by it, so
  /// a round trip that quietly dropped it would put every one of them back to ordering two
  /// different people's settings by a number that only means something inside one account.
  func testBridgeCarriesTheRepointCounterBackUnderTheNameTheWebSideUses() throws {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    let bridge = SettingsBridge(store: store)
    let json = """
    { "settings": { "globalOn": true, "services": { "youtube": true, "instagram": true, "tiktok": true, "facebook": true }, "pauses": [], "updatedAt": 10 }, "syncMetadata": null, "syncEpoch": 3 }
    """

    let reply = try XCTUnwrap(bridge.handle(rawBody: ["kind": "set", "settings": json]))
    let echoed = try JSONDecoder().decode(StoredSettingsRecord.self, from: Data(reply.utf8))
    XCTAssertTrue(echoed.settings.services.youtube)
    XCTAssertEqual(echoed.settings.updatedAt, 10)
    XCTAssertEqual(echoed.syncEpoch, 3)
    XCTAssertEqual(store.currentRecord().syncEpoch, 3)

    // The key on the wire, not just the Swift property: the web side reads this JSON by name.
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any])
    XCTAssertEqual(object["syncEpoch"] as? Int, 3)
  }

  /// A record written before the counter existed still has to be accepted, and the app has to keep
  /// reading it exactly as it always did rather than treating the missing counter as an error.
  func testBridgeStillAcceptsARecordWithNoRepointCounter() throws {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    let bridge = SettingsBridge(store: store)
    let json = """
    { "settings": { "globalOn": false, "services": { "youtube": true, "instagram": true, "tiktok": true, "facebook": true }, "pauses": [], "updatedAt": 10 }, "syncMetadata": null }
    """

    let reply = try XCTUnwrap(bridge.handle(rawBody: ["kind": "set", "settings": json]))
    let echoed = try JSONDecoder().decode(StoredSettingsRecord.self, from: Data(reply.utf8))
    XCTAssertFalse(echoed.settings.globalOn)
    XCTAssertNil(echoed.syncEpoch)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any])
    XCTAssertNil(object["syncEpoch"])
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
