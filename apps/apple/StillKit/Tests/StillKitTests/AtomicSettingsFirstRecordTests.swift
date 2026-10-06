import XCTest
@testable import StillKit

/// Owner decision 28 (the Apple app saves a first record when nothing is saved) and owner decision 30
/// (after an iPhone reinstall, Safari's retained copy replaces that first record while it is still
/// untouched). Every case runs through the real App Group file backing and the shared bridge.
final class AtomicSettingsFirstRecordTests: XCTestCase {
  private let account = "11111111-1111-1111-1111-111111111111"
  private let initializeUnknown = ["kind": "settingsAtomic", "command": "{\"action\":\"initialize\",\"ownership\":\"unknown\"}"]

  private func directory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("still-first-record-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }
  private final class Counter { var value = 0 }
  private func host(_ directory: URL, firstRecord: AtomicSettingsRecord.FirstRecord?) -> (store: SharedSettingsStore, bridge: SettingsBridge, notified: Counter) {
    let store = SharedSettingsStore(backing: AtomicSettingsBacking(directory: directory))
    let counter = Counter()
    return (store, SettingsBridge(store: store, notifyChanged: { counter.value += 1 }, firstRecord: firstRecord), counter)
  }
  private func object(_ data: Data?) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(data)) as? [String: Any])
  }
  private func object(_ json: String?) throws -> [String: Any] { try object(XCTUnwrap(json).data(using: .utf8)) }
  private func atomic(_ data: Data?) throws -> [String: Any] { try XCTUnwrap(object(data)["atomic"] as? [String: Any]) }
  private func settings(_ data: Data?) throws -> [String: Any] { try XCTUnwrap(object(data)["settings"] as? [String: Any]) }
  private func legacy(globalOn: Bool, instagram: Bool, updatedAt: Int, synced: Bool = false) throws -> Data {
    let settings: [String: Any] = ["globalOn": globalOn, "pauses": [String](), "updatedAt": updatedAt,
      "services": ["youtube": true, "instagram": instagram, "tiktok": true, "facebook": true]]
    let metadata: Any = synced ? ["version": 4, "serverUpdatedAt": "2026-09-01T00:00:00Z", "lastWriteId": NSNull()] as [String: Any] : NSNull()
    return try JSONSerialization.data(withJSONObject: ["settings": settings, "syncMetadata": metadata, "syncEpoch": synced ? 2 : 0], options: [.sortedKeys])
  }
  private func adopt(_ bridge: SettingsBridge, _ copy: Data) throws -> [String: Any] {
    try object(bridge.handle(rawBody: ["kind": "settingsAdopt", "settings": String(decoding: copy, as: UTF8.self)]))
  }

  // MARK: Decision 28 — the first record

  func testNewInstallSavesStillDefaultsNeverLinkedOnFirstInitialize() throws {
    let (store, bridge, notified) = host(try directory(), firstRecord: .newInstall)
    XCTAssertNil(store.encodedRecord())
    let reply = try object(bridge.handle(rawBody: initializeUnknown))
    let saved = store.encodedRecord()
    XCTAssertEqual(saved, try AtomicSettingsRecord.firstRecord(.newInstall))
    XCTAssertEqual(reply as NSDictionary, try object(saved) as NSDictionary)
    XCTAssertEqual(try atomic(saved)["ownership"] as? String, "never-linked")
    XCTAssertEqual(try atomic(saved)["sequence"] as? Int, 0)
    XCTAssertEqual(try settings(saved)["globalOn"] as? Bool, true)
    XCTAssertEqual(try settings(saved)["updatedAt"] as? Int, 0)
    XCTAssertEqual(try settings(saved)["services"] as? [String: Bool], ["youtube": true, "instagram": true, "tiktok": true, "facebook": true])
    XCTAssertEqual(notified.value, 1)
    XCTAssertTrue(AtomicSettingsRecord.isUntouchedFirstRecord(try XCTUnwrap(saved)))
  }

  func testUntouchedUpgradeSavesTheDefaultsItWasUsingWithUnknownOwnership() throws {
    let (store, bridge, _) = host(try directory(), firstRecord: .untouchedUpgrade)
    _ = bridge.handle(rawBody: initializeUnknown)
    let saved = store.encodedRecord()
    XCTAssertEqual(saved, try AtomicSettingsRecord.firstRecord(.untouchedUpgrade))
    XCTAssertEqual(try atomic(saved)["ownership"] as? String, "unknown")
    XCTAssertEqual(try settings(saved)["updatedAt"] as? Int, 0)
    XCTAssertTrue(try object(saved)["syncMetadata"] is NSNull)
    XCTAssertEqual(try object(saved)["syncEpoch"] as? Int, 0)
    // The same record the app's own conversion makes of a 2.x zero-stamp defaults record.
    XCTAssertEqual(saved, try AtomicSettingsRecord.initialize(legacy(globalOn: true, instagram: true, updatedAt: 0), ownership: "unknown"))
    XCTAssertTrue(AtomicSettingsRecord.isUntouchedFirstRecord(try XCTUnwrap(saved)))
  }

  func testAFirstRecordNeverReplacesAnySavedRecord() throws {
    for kind in [AtomicSettingsRecord.FirstRecord.newInstall, .untouchedUpgrade] {
      // A readable 2.x record with saved Off choices converts exactly as it would with no launch fact.
      let off = try legacy(globalOn: false, instagram: false, updatedAt: 5, synced: true)
      let withFact = host(try directory(), firstRecord: kind), withoutFact = host(try directory(), firstRecord: nil)
      withFact.store.saveRecord(try JSONDecoder().decode(StoredSettingsRecord.self, from: off))
      withoutFact.store.saveRecord(try JSONDecoder().decode(StoredSettingsRecord.self, from: off))
      _ = withFact.bridge.handle(rawBody: initializeUnknown); _ = withoutFact.bridge.handle(rawBody: initializeUnknown)
      XCTAssertEqual(withFact.store.encodedRecord(), withoutFact.store.encodedRecord(), "\(kind)")
      XCTAssertEqual(try settings(withFact.store.encodedRecord())["globalOn"] as? Bool, false)
      XCTAssertEqual((try settings(withFact.store.encodedRecord())["services"] as? [String: Bool])?["instagram"], false)
      XCTAssertEqual(try atomic(withFact.store.encodedRecord())["ownership"] as? String, "unknown")

      // An already modern record is returned untouched.
      let edited = try XCTUnwrap(AtomicSettingsRecord.commit(AtomicSettingsRecord.firstRecord(.newInstall), path: "services.tiktok", value: false, updatedAt: 9).data)
      let modernDirectory = try directory()
      try AtomicSettingsBacking(directory: modernDirectory).transaction { $0 = edited }
      let saved = host(modernDirectory, firstRecord: kind)
      _ = saved.bridge.handle(rawBody: initializeUnknown)
      XCTAssertEqual(saved.store.encodedRecord(), edited)

      // Unreadable and future records are held, never reset to a first record.
      for damaged in [Data("{\"settings\":{\"globalOn\":1}".utf8), Data("{\"settings\":{\"schemaVersion\":99,\"globalOn\":false,\"services\":{},\"updatedAt\":3}}".utf8)] {
        let damagedDirectory = try directory()
        try AtomicSettingsBacking(directory: damagedDirectory).transaction { $0 = damaged }
        let held = host(damagedDirectory, firstRecord: kind)
        XCTAssertEqual(held.bridge.handle(rawBody: initializeUnknown), "{\"status\":\"unavailable\"}")
        XCTAssertEqual(try AtomicSettingsBacking(directory: damagedDirectory).transaction { $0 }, damaged)
        XCTAssertEqual(held.notified.value, 0)
      }
    }
  }

  func testDoubleInitializationSavesOnceAndKeepsLaterChoices() throws {
    let (store, bridge, notified) = host(try directory(), firstRecord: .newInstall)
    let first = bridge.handle(rawBody: initializeUnknown)
    let second = bridge.handle(rawBody: initializeUnknown)
    XCTAssertEqual(first, second)
    XCTAssertEqual(notified.value, 1)
    XCTAssertEqual(store.encodedRecord(), try AtomicSettingsRecord.firstRecord(.newInstall))
    // A deliberate Off choice after the first record survives every later launch's initialize.
    _ = try store.commitIntent(path: "services.youtube", value: false, updatedAt: 50)
    let afterEdit = store.encodedRecord()
    for kind in [AtomicSettingsRecord.FirstRecord.newInstall, .untouchedUpgrade] {
      var relaunch = bridge
      relaunch.firstRecord = kind
      _ = relaunch.handle(rawBody: initializeUnknown)
      XCTAssertEqual(store.encodedRecord(), afterEdit)
    }
    XCTAssertEqual((try settings(afterEdit)["services"] as? [String: Bool])?["youtube"], false)
  }

  func testConcurrentFirstLaunchHostsSaveExactlyOneFirstRecord() throws {
    let shared = try directory()
    let hosts = (0..<8).map { host(shared, firstRecord: $0 % 2 == 0 ? .newInstall : .untouchedUpgrade) }
    var replies = [String](repeating: "", count: hosts.count)
    let lock = NSLock()
    DispatchQueue.concurrentPerform(iterations: hosts.count) { index in
      let reply = hosts[index].bridge.handle(rawBody: initializeUnknown)
      lock.lock(); replies[index] = reply ?? ""; lock.unlock()
    }
    let saved = try XCTUnwrap(hosts[0].store.encodedRecord())
    XCTAssertTrue(AtomicSettingsRecord.isUntouchedFirstRecord(saved))
    XCTAssertEqual(Set(replies).count, 1, "every host answers with the one saved record")
    XCTAssertEqual(try object(replies[0]) as NSDictionary, try object(saved) as NSDictionary)
    XCTAssertEqual(hosts.map(\.notified.value).reduce(0, +), 1, "only the host that actually saved notifies")
  }

  func testOnlyTheAppHostsInitializeSavesAFirstRecord() throws {
    // The Safari extension's bridge carries no launch fact: an absent record still refuses.
    let extensionHost = host(try directory(), firstRecord: nil)
    XCTAssertEqual(extensionHost.bridge.handle(rawBody: initializeUnknown), "{\"status\":\"unavailable\"}")
    XCTAssertNil(extensionHost.store.encodedRecord())
    // Other atomic commands never stand in a first record.
    let app = host(try directory(), firstRecord: .newInstall)
    let scope = ["kind": "settingsAtomic", "command": "{\"action\":\"scope\",\"accountId\":\"\(account)\"}"]
    XCTAssertEqual(app.bridge.handle(rawBody: scope), "{\"status\":\"unavailable\"}")
    XCTAssertNil(app.store.encodedRecord())
    // Coordination unavailable: no first record, no write.
    let degraded = SettingsBridge(store: SharedSettingsStore(backing: InMemoryBacking(), coordinationAvailable: false), notifyChanged: {}, firstRecord: .newInstall)
    XCTAssertEqual(degraded.handle(rawBody: initializeUnknown), "{\"status\":\"unavailable\"}")
  }

  func testANoOpIntentOnAnAbsentRecordCannotPreemptTheFirstRecord() throws {
    // "Absent" must mean actually absent: an intent that changes nothing writes nothing, so the
    // later first launch still saves the new-install record rather than converting a stray one.
    let (store, bridge, _) = host(try directory(), firstRecord: .newInstall)
    let reply = bridge.handle(rawBody: ["kind": "settingsIntent", "path": "globalOn", "value": true, "updatedAt": 10])
    XCTAssertFalse(reply?.isEmpty ?? true)
    XCTAssertNil(store.encodedRecord())
    _ = bridge.handle(rawBody: initializeUnknown)
    XCTAssertEqual(store.encodedRecord(), try AtomicSettingsRecord.firstRecord(.newInstall))
  }

  // MARK: Decision 30 — Safari's retained copy replaces an untouched first record

  func testAReinstallAdoptsSafarisLegacyCopyInsteadOfTheFirstRecord() throws {
    for kind in [AtomicSettingsRecord.FirstRecord.newInstall, .untouchedUpgrade] {
      let (store, app, _) = host(try directory(), firstRecord: kind)
      _ = app.handle(rawBody: initializeUnknown)
      let safari = SettingsBridge(store: store, notifyChanged: {})
      let copy = try legacy(globalOn: false, instagram: false, updatedAt: 42, synced: true)
      let reply = try adopt(safari, copy)
      XCTAssertEqual(reply["status"] as? String, "adopted")
      let saved = store.encodedRecord()
      XCTAssertEqual(try object(saved) as NSDictionary, try XCTUnwrap(reply["record"] as? [String: Any]) as NSDictionary)
      // Safari's saved values, exactly, with the conversion the app gives any saved 2.x record.
      var expected = try object(AtomicSettingsRecord.initialize(copy, ownership: "unknown"))
      var state = try XCTUnwrap(expected["atomic"] as? [String: Any]); state["sequence"] = 1; expected["atomic"] = state
      XCTAssertEqual(try object(saved) as NSDictionary, expected as NSDictionary)
      XCTAssertEqual(try settings(saved)["globalOn"] as? Bool, false)
      XCTAssertEqual(try settings(saved)["updatedAt"] as? Int, 42)
      XCTAssertFalse(AtomicSettingsRecord.isUntouchedFirstRecord(try XCTUnwrap(saved)))
      // Offered again (another page load), the copy is already saved: nothing changes.
      XCTAssertEqual(try adopt(safari, copy)["status"] as? String, "kept")
      XCTAssertEqual(store.encodedRecord(), saved)
      // And a later launch's initialize leaves it alone.
      _ = app.handle(rawBody: initializeUnknown)
      XCTAssertEqual(store.encodedRecord(), saved)
    }
  }

  func testAReinstallAdoptsSafarisModernCopyAsSavedOneStepLater() throws {
    // The old install's record: a never-linked Off choice, then signed in and out (generation 2).
    var old = try AtomicSettingsRecord.firstRecord(.newInstall)
    old = try XCTUnwrap(AtomicSettingsRecord.commit(old, path: "globalOn", value: false, updatedAt: 7).data)
    old = try AtomicSettingsRecord.command(old, command: Data("{\"action\":\"scope\",\"accountId\":\"\(account)\"}".utf8))
    old = try AtomicSettingsRecord.command(old, command: Data("{\"action\":\"scope\",\"accountId\":null}".utf8))
    var copy = try object(old); copy["futureRoot"] = ["kept": true]; copy["intentCommitted"] = true
    let copyBytes = try JSONSerialization.data(withJSONObject: copy)

    let (store, app, notified) = host(try directory(), firstRecord: .newInstall)
    _ = app.handle(rawBody: initializeUnknown)
    let reply = try adopt(SettingsBridge(store: store, notifyChanged: { notified.value += 1 }), copyBytes)
    XCTAssertEqual(reply["status"] as? String, "adopted")
    XCTAssertEqual(notified.value, 2)
    var expected = copy; expected.removeValue(forKey: "intentCommitted")
    var state = try XCTUnwrap(expected["atomic"] as? [String: Any])
    state["sequence"] = try XCTUnwrap(state["sequence"] as? Int) + 1; expected["atomic"] = state
    XCTAssertEqual(try object(store.encodedRecord()) as NSDictionary, expected as NSDictionary)
    XCTAssertEqual(try settings(store.encodedRecord())["globalOn"] as? Bool, false)
  }

  func testSafarisCopyNeverReplacesARecordThatIsNoLongerUntouched() throws {
    let copy = try legacy(globalOn: false, instagram: false, updatedAt: 42)
    // A choice made in the new install, a sign-in, or any saved 2.x record outranks the copy.
    var edited = try AtomicSettingsRecord.firstRecord(.newInstall)
    edited = try XCTUnwrap(AtomicSettingsRecord.commit(edited, path: "services.facebook", value: false, updatedAt: 3).data)
    let linked = try AtomicSettingsRecord.command(AtomicSettingsRecord.firstRecord(.newInstall), command: Data("{\"action\":\"scope\",\"accountId\":\"\(account)\"}".utf8))
    let converted = try AtomicSettingsRecord.initialize(legacy(globalOn: true, instagram: true, updatedAt: 3), ownership: "unknown")
    for saved in [edited, linked, converted, try legacy(globalOn: true, instagram: false, updatedAt: 3)] {
      let shared = try directory()
      try AtomicSettingsBacking(directory: shared).transaction { $0 = saved }
      let (store, bridge, notified) = host(shared, firstRecord: nil)
      let reply = try adopt(bridge, copy)
      XCTAssertEqual(reply["status"] as? String, "kept")
      XCTAssertEqual(store.encodedRecord(), saved)
      XCTAssertEqual(try object(saved) as NSDictionary, try XCTUnwrap(reply["record"] as? [String: Any]) as NSDictionary)
      XCTAssertEqual(notified.value, 0)
    }
    // Before the app's first launch there is nothing to replace: the copy waits for the first record.
    let (store, bridge, _) = host(try directory(), firstRecord: nil)
    let reply = try adopt(bridge, copy)
    XCTAssertEqual(reply["status"] as? String, "kept")
    XCTAssertTrue(reply["record"] is NSNull)
    XCTAssertNil(store.encodedRecord())
  }

  func testUnreadableOrDefaultCopiesAreNotAdopted() throws {
    let first = try AtomicSettingsRecord.firstRecord(.newInstall)
    let cases: [(String, Data)] = [
      ("refused", Data("not json".utf8)),
      ("refused", Data("{\"settings\":{\"schemaVersion\":99,\"globalOn\":false,\"services\":{},\"updatedAt\":3}}".utf8)),
      ("refused", Data("{\"settings\":{\"globalOn\":\"off\",\"services\":{},\"updatedAt\":3}}".utf8)),
      // Nothing deliberate to keep: the copy is itself an untouched first record or never-edited defaults.
      ("kept", first),
      ("kept", try AtomicSettingsRecord.firstRecord(.untouchedUpgrade)),
      ("kept", try legacy(globalOn: true, instagram: true, updatedAt: 0)),
      ("kept", Data("{\"settings\":{\"globalOn\":true,\"services\":{\"youtube\":true,\"instagram\":true,\"tiktok\":true,\"facebook\":true},\"pauses\":[],\"updatedAt\":0}}".utf8)),
    ]
    for (status, copy) in cases {
      let shared = try directory()
      try AtomicSettingsBacking(directory: shared).transaction { $0 = first }
      let (store, bridge, notified) = host(shared, firstRecord: nil)
      XCTAssertEqual(try adopt(bridge, copy)["status"] as? String, status, String(decoding: copy, as: UTF8.self))
      XCTAssertEqual(store.encodedRecord(), first)
      XCTAssertEqual(notified.value, 0)
    }
  }

  func testAdoptionMessageShapeIsExact() {
    XCTAssertEqual(BridgeRequest.parse(["kind": "settingsAdopt", "settings": "{}"]), .adopt(Data("{}".utf8)))
    XCTAssertNil(BridgeRequest.parse(["kind": "settingsAdopt", "settings": "{}", "force": true]))
    XCTAssertNil(BridgeRequest.parse(["kind": "settingsAdopt", "settings": 1]))
    XCTAssertNil(BridgeRequest.parse(["kind": "settingsAdopt", "settings": String(repeating: " ", count: 131_073)]))
    let unavailable = SettingsBridge(store: SharedSettingsStore(backing: InMemoryBacking(try? AtomicSettingsRecord.firstRecord(.newInstall)), coordinationAvailable: false), notifyChanged: {})
    XCTAssertEqual(unavailable.handle(rawBody: ["kind": "settingsAdopt", "settings": "{}"]), "{\"status\":\"unavailable\"}")
  }
}
