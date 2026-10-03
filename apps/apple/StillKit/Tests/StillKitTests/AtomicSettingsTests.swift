import XCTest
@testable import StillKit

final class AtomicSettingsTests: XCTestCase {
  private func directory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("still-atomic-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }
  private func seed(_ store: SharedSettingsStore) throws {
    store.save(StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 1))
    _ = try store.initializeAtomic(ownership: "unknown")
  }
  private func root(_ data: Data) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  private func acknowledgement(_ settings: Any, scope: Any) throws -> Data {
    let lineage = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    return try JSONSerialization.data(withJSONObject: ["action": "acknowledge", "scope": scope,
      "envelope": ["protocol": 2, "empty": true, "settings": settings, "version": 0,
        "serverUpdatedAt": NSNull(), "lastWriteId": NSNull(), "lineage": lineage,
        "receipt": ["version": 1, "lineage": lineage, "revision": 0, "mac": String(repeating: "A", count: 43)]]])
  }
  func testNeverLinkedNullScopeRetainsRawOffRecordAtAllBounds() throws {
    let initial = try JSONEncoder().encode(StoredSettingsRecord(settings: StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 1), syncMetadata: nil))
    let baseline = try AtomicSettingsRecord.initialize(initial, ownership: "never-linked")
    let saved = try AtomicSettingsRecord.commit(baseline, path: "globalOn", value: false, updatedAt: 10).data
    let nullScope = Data("{\"action\":\"scope\",\"accountId\":null}".utf8)
    for bound in ["ordinary", "generation", "sequence", "epoch"] {
      var record = try root(saved); var state = try XCTUnwrap(record["atomic"] as? [String: Any])
      var scope = try XCTUnwrap(state["scope"] as? [String: Any])
      record["futureRoot"] = ["retained": false]; state["futureState"] = ["retained": true]
      if bound == "generation" { scope["generation"] = 9_007_199_254_740_991 }
      if bound == "sequence" { state["sequence"] = 9_007_199_254_740_991 }
      if bound == "epoch" { record["syncEpoch"] = 9_007_199_254_740_991 }
      state["scope"] = scope; record["atomic"] = state
      let raw = try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
      let backing = AtomicSettingsBacking(directory: try directory()); try backing.transaction { $0 = raw }
      let store = SharedSettingsStore(backing: backing)
      XCTAssertEqual(try AtomicSettingsRecord.command(raw, command: nullScope), raw, bound)
      _ = try store.atomicCommand(nullScope)
      XCTAssertEqual(try store.readCommittedRecord(), raw, bound)
      XCTAssertFalse(store.current().globalOn)
      let invalid = Data("{\"action\":\"scope\",\"accountId\":null,\"sessionId\":\"cccccccc-cccc-cccc-cccc-cccccccccccc\"}".utf8)
      XCTAssertThrowsError(try AtomicSettingsRecord.command(raw, command: invalid))
    }
    let originalState = try XCTUnwrap(root(saved)["atomic"] as? [String: Any])
    let original = try XCTUnwrap((originalState["pending"] as? [[String: Any]])?.first)
    let linked = try AtomicSettingsRecord.command(AtomicSettingsRecord.command(saved, command: nullScope), command: Data("{\"action\":\"scope\",\"accountId\":\"11111111-1111-1111-1111-111111111111\",\"sessionId\":\"cccccccc-cccc-cccc-cccc-cccccccccccc\"}".utf8))
    let linkedState = try XCTUnwrap(root(linked)["atomic"] as? [String: Any])
    let captured = try XCTUnwrap(linkedState["scope"])
    var command = try root(acknowledgement(XCTUnwrap(root(baseline)["settings"]), scope: captured))
    var envelope = try XCTUnwrap(command["envelope"] as? [String: Any]); envelope["empty"] = false; command["envelope"] = envelope
    let waiting = try AtomicSettingsRecord.command(linked, command: JSONSerialization.data(withJSONObject: command))
    let waitingRoot = try root(waiting); let waitingState = try XCTUnwrap(waitingRoot["atomic"] as? [String: Any])
    let pending = try XCTUnwrap((waitingState["pending"] as? [[String: Any]])?.first)
    XCTAssertEqual(pending["writeId"] as? String, original["writeId"] as? String)
    XCTAssertEqual(pending["operations"] as? NSArray, original["operations"] as? NSArray)
    XCTAssertEqual(pending["originScope"] as? NSDictionary, original["scope"] as? NSDictionary)
    XCTAssertEqual((waitingRoot["settings"] as? [String: Any])?["globalOn"] as? Bool, false)
    envelope["settings"] = waitingRoot["settings"]; command["envelope"] = envelope
    let accepted = try root(AtomicSettingsRecord.command(waiting, command: JSONSerialization.data(withJSONObject: command)))
    XCTAssertEqual(((accepted["atomic"] as? [String: Any])?["pending"] as? [Any])?.count, 0)
    XCTAssertEqual((accepted["settings"] as? [String: Any])?["globalOn"] as? Bool, false)
  }

  func testSameAccountResumeKeepsCompleteRecordAndExplicitSignoutFencesIt() throws {
    let dir = try directory(); let store = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)); try seed(store)
    let account = "11111111-1111-1111-1111-111111111111"
    let session = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    let initial = try root(XCTUnwrap(store.encodedRecord()))
    func scope(_ id: Any) throws {
      var command: [String: Any] = ["action": "scope", "accountId": id]
      if id is String { command["sessionId"] = session }
      _ = try store.atomicCommand(JSONSerialization.data(withJSONObject: command))
    }
    try scope(account)
    let linked = try root(XCTUnwrap(store.encodedRecord())); let state = try XCTUnwrap(linked["atomic"] as? [String: Any])
    _ = try store.atomicCommand(acknowledgement(XCTUnwrap(initial["settings"]), scope: XCTUnwrap(state["scope"])))
    for i in 0..<65 { _ = try store.commitIntent(path: "globalOn", value: i % 2 != 0, updatedAt: i + 10) }
    let before = try XCTUnwrap(store.encodedRecord()); let beforeRoot = try root(before)
    let beforeState = try XCTUnwrap(beforeRoot["atomic"] as? [String: Any])
    XCTAssertEqual((beforeState["pending"] as? [Any])?.count, 64)
    XCTAssertEqual((beforeState["held"] as? [String: Bool])?["globalOn"], false)
    let peer = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir))
    _ = try peer.atomicCommand(JSONSerialization.data(withJSONObject: ["action": "scope", "accountId": account, "sessionId": session]))
    XCTAssertEqual(peer.encodedRecord(), before)
    try scope(NSNull()); let signedOut = try root(XCTUnwrap(store.encodedRecord()))
    XCTAssertEqual((signedOut["atomic"] as? [String: Any])?["pending"] as? [String], [])
    XCTAssertEqual((signedOut["atomic"] as? [String: Any])?["held"] as? [String: Bool], ["globalOn": false])
    try scope(account)
    let replacement = try root(XCTUnwrap(store.encodedRecord())); let replacementState = try XCTUnwrap(replacement["atomic"] as? [String: Any])
    let oldScope = try XCTUnwrap(beforeState["scope"] as? [String: Any]); let nextScope = try XCTUnwrap(replacementState["scope"] as? [String: Any])
    XCTAssertGreaterThan(try XCTUnwrap(nextScope["generation"] as? Int), try XCTUnwrap(oldScope["generation"] as? Int))
    _ = try store.atomicCommand(acknowledgement(XCTUnwrap(initial["settings"]), scope: nextScope))
    _ = try store.commitIntent(path: "services.youtube", value: false, updatedAt: 100)
    let current = try root(XCTUnwrap(store.encodedRecord())); let currentState = try XCTUnwrap(current["atomic"] as? [String: Any])
    let pending = try XCTUnwrap(currentState["pending"] as? [[String: Any]])
    XCTAssertEqual(pending.count, 1); XCTAssertEqual(currentState["ownership"] as? String, "previous-account")
    XCTAssertEqual(pending[0]["scope"] as? NSDictionary, nextScope as NSDictionary)
    let stable = store.encodedRecord()
    _ = try store.atomicCommand(acknowledgement(XCTUnwrap(initial["settings"]), scope: oldScope))
    XCTAssertEqual(store.encodedRecord(), stable)
  }
  func testFutureLocalAcknowledgementRetainsBytesAndDoesNotNotify() throws {
    try assertRejectedLocalAcknowledgement { $0["schemaVersion"] = 99 }
  }
  func testDamagedLocalAcknowledgementsRetainBytesAndDoNotNotify() throws {
    try assertRejectedLocalAcknowledgement { $0["globalOn"] = 1 }
    try assertRejectedLocalAcknowledgement { $0.removeValue(forKey: "globalOn") }
    try assertRejectedLocalAcknowledgement { $0["services"] = ["youtube": "false"] }
  }
  private func assertRejectedLocalAcknowledgement(_ damage: (inout [String: Any]) -> Void) throws {
    let dir = try directory(); let backing = AtomicSettingsBacking(directory: dir)
    let store = SharedSettingsStore(backing: backing); try seed(store)
    let initial = try root(XCTUnwrap(store.encodedRecord()))
    _ = try store.atomicCommand(JSONSerialization.data(withJSONObject: ["action": "scope", "accountId": "11111111-1111-1111-1111-111111111111"]))
    var damaged = try root(XCTUnwrap(store.encodedRecord()))
    var settings = try XCTUnwrap(damaged["settings"] as? [String: Any]); damage(&settings); damaged["settings"] = settings
    let raw = try JSONSerialization.data(withJSONObject: damaged)
    try backing.transaction { $0 = raw }
    let state = try XCTUnwrap(damaged["atomic"] as? [String: Any])
    let command = try acknowledgement(XCTUnwrap(initial["settings"]), scope: XCTUnwrap(state["scope"]))
    var notifications = 0; let bridge = SettingsBridge(store: store, notifyChanged: { notifications += 1 })
    XCTAssertEqual(bridge.handle(.atomic(command)), "{\"status\":\"unavailable\"}")
    XCTAssertEqual(try store.readCommittedRecord(), raw); XCTAssertEqual(notifications, 0)
    XCTAssertThrowsError(try store.atomicCommand(command)) { error in
      XCTAssertEqual(error as? AtomicSettingsRecord.Failure, .unreadable)
    }
  }
  func testTwoIndependentHostsAllocateFromCommittedRecord() throws {
    let dir = try directory()
    let first = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir))
    let peer = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir))
    try seed(first)
    _ = try first.commitIntent(path: "globalOn", value: false, updatedAt: 10)
    _ = try peer.commitIntent(path: "services.youtube", value: false, updatedAt: 10)
    _ = try peer.commitIntent(path: "globalOn", value: true, updatedAt: 10)
    let saved = try root(XCTUnwrap(first.encodedRecord()))
    let settings = try XCTUnwrap(saved["settings"] as? [String: Any])
    let clocks = try XCTUnwrap(settings["clocks"] as? [String: [String: Int]])
    XCTAssertEqual(clocks["globalOn"]?["localStep"], 2)
    XCTAssertEqual(clocks["services.youtube"]?["localStep"], 1)
    XCTAssertFalse(first.current().services.youtube)
    let state = try XCTUnwrap(saved["atomic"] as? [String: Any])
    let pending = try XCTUnwrap(state["pending"] as? [[String: Any]])
    XCTAssertEqual(pending.count, 3)
    XCTAssertEqual(Set(pending.compactMap { $0["writeId"] as? String }).count, 3)
  }
  @MainActor
  func testMainActorReadWaitsForALivePeerLockOnTheMacOSTestHost() async throws {
    let dir = try directory()
    let store = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)); try seed(store)
    let before = try store.readCommittedRecord(); let locked = DispatchSemaphore(value: 0)
    let released = expectation(description: "live peer releases lock")
    DispatchQueue.global().async {
      let peer = AtomicSettingsBacking(directory: dir)
      defer { released.fulfill() }
      _ = try? peer.transaction { _ in locked.signal(); Thread.sleep(forTimeInterval: 0.2) }
    }
    XCTAssertEqual(locked.wait(timeout: .now() + 2), .success)
    let callback = expectation(description: "main queue callback resumes")
    let began = ProcessInfo.processInfo.systemUptime
    var callbackDelay = 0.0
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) {
      callbackDelay = ProcessInfo.processInfo.systemUptime - began; callback.fulfill()
    }
    XCTAssertEqual(try store.readCommittedRecord(), before)
    let readDelay = ProcessInfo.processInfo.systemUptime - began
    await fulfillment(of: [released, callback], timeout: 2)
    XCTAssertGreaterThan(readDelay, 0.1); XCTAssertGreaterThan(callbackDelay, 0.1)
    print("native-main-actor-live-peer-characterization readMs=\(readDelay * 1000) callbackMs=\(callbackDelay * 1000)")
    // Deliberate test contention is not ordinary iOS suspension or packaged-device evidence.
  }
  func testFailedReplacementDoesNotNotifyOrChangePeerBytes() throws {
    let dir = try directory()
    let peer = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir))
    try seed(peer)
    let before = peer.encodedRecord()
    enum Injected: Error { case failure }
    let failing = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir, beforeReplace: { throw Injected.failure }))
    var notifications = 0
    let bridge = SettingsBridge(store: failing, notifyChanged: { notifications += 1 })
    XCTAssertEqual(bridge.handle(.intent(path: "globalOn", value: false, updatedAt: 10)), "")
    XCTAssertEqual(peer.encodedRecord(), before)
    XCTAssertEqual(notifications, 0)
    XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: dir.path).contains { $0.hasSuffix(".tmp") })
  }
  func testLegacyReadOnlyProjectionAllOffMigratesUnderLockWithoutNewIntent() throws {
    let dir = try directory()
    let old = StillSettings(globalOn: false, services: StillServices(youtube: false, instagram: false, tiktok: false, facebook: false), pauses: [], updatedAt: 7)
    let legacy = try JSONEncoder().encode(StoredSettingsRecord(settings: old, syncMetadata: nil))
    let store = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir, legacyRead: { legacy }))
    _ = try store.initializeAtomic(ownership: "unknown")
    let peer = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir))
    XCTAssertEqual(peer.current(), old)
    let saved = try root(XCTUnwrap(peer.encodedRecord()))
    let state = try XCTUnwrap(saved["atomic"] as? [String: Any])
    XCTAssertEqual(state["ownership"] as? String, "unknown")
    XCTAssertEqual((state["pending"] as? [Any])?.count, 0)
  }
  func testFirstReadFreezesLegacyBytesWithoutInferringOwnership() throws {
    let dir = try directory()
    var legacy: Data? = try JSONEncoder().encode(StoredSettingsRecord(settings: StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 7), syncMetadata: nil))
    let backing = AtomicSettingsBacking(directory: dir, legacyRead: { legacy })
    let first = try backing.transaction { $0 }
    legacy = try JSONEncoder().encode(StoredSettingsRecord(settings: .default, syncMetadata: nil))
    let peer = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir, legacyRead: { legacy }))
    XCTAssertEqual(try peer.readCommittedRecord(), first)
    XCTAssertFalse(peer.current().globalOn)
    XCTAssertNil(try root(XCTUnwrap(first))["atomic"])
  }
  func testCoarseSnapshotCannotEraseModernIntentOrProvenance() throws {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    try seed(store)
    _ = try store.commitIntent(path: "globalOn", value: false, updatedAt: 10)
    let before = store.encodedRecord()
    XCTAssertFalse(store.applyRemote(StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 100)))
    _ = SettingsBridge(store: store, notifyChanged: {}).handle(.set(StoredSettingsRecord(settings: .default, syncMetadata: nil, syncEpoch: 100)))
    XCTAssertEqual(store.encodedRecord(), before)
  }
  func testLegacyBridgePreservesOpaqueSavedMembersBeforeMigration() throws {
    let backing = InMemoryBacking(Data("{\"settings\":{\"globalOn\":false,\"services\":{\"youtube\":false,\"instagram\":false,\"tiktok\":false,\"facebook\":false,\"future\":false},\"sites\":{\"youtube\":{\"opaque\":false}},\"future\":{\"saved\":false},\"pauses\":[],\"updatedAt\":7},\"syncMetadata\":null,\"futureRoot\":false}".utf8))
    let store = SharedSettingsStore(backing: backing)
    let incoming = StoredSettingsRecord(settings: StillSettings(globalOn: false, services: StillServices(youtube: false, instagram: false, tiktok: false, facebook: false), pauses: [], updatedAt: 8), syncMetadata: nil)
    XCTAssertTrue(store.applyRecord(incoming))
    let saved = try root(XCTUnwrap(backing.read()))
    let settings = try XCTUnwrap(saved["settings"] as? [String: Any])
    XCTAssertEqual((settings["future"] as? [String: Bool])?["saved"], false)
    XCTAssertEqual((settings["services"] as? [String: Bool])?["future"], false)
    XCTAssertNotNil(settings["sites"])
    XCTAssertEqual(saved["futureRoot"] as? Bool, false)
    XCTAssertFalse(store.current().globalOn)
  }
  func testMalformedFutureAndAbsentAreNeverFresh() throws {
    for raw in [nil, Data("broken".utf8), Data("{\"schemaVersion\":99,\"globalOn\":false}".utf8)] as [Data?] {
      let backing = InMemoryBacking(raw)
      let store = SharedSettingsStore(backing: backing)
      XCTAssertThrowsError(try store.initializeAtomic(ownership: "unknown"))
      XCTAssertEqual(backing.read(), raw)
    }
  }
  func testIntentNoOpDoesNotWriteOrNotify() throws {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    try seed(store)
    let before = store.encodedRecord()
    var notifications = 0
    let bridge = SettingsBridge(store: store, notifyChanged: { notifications += 1 })
    _ = bridge.handle(.intent(path: "globalOn", value: true, updatedAt: 20))
    XCTAssertEqual(store.encodedRecord(), before)
    XCTAssertEqual(notifications, 0)
  }
  func testUnavailableCoordinationKeepsSavedChoicesAndCannotInitializeModernAuthority() throws {
    let old = StillSettings(globalOn: false, services: StillServices(youtube: false, instagram: false, tiktok: false, facebook: false), pauses: [], updatedAt: 7)
    let data = try JSONEncoder().encode(StoredSettingsRecord(settings: old, syncMetadata: nil))
    let backing = InMemoryBacking(data)
    let fallback = SharedSettingsStore(backing: backing, coordinationAvailable: false)
    XCTAssertEqual(fallback.current(), old)
    XCTAssertThrowsError(try fallback.initializeAtomic(ownership: "unknown"))
    XCTAssertEqual(backing.read(), data)
  }
  func testUnavailableModernWriterKeepsRequestedChoiceInLocalHoldAndReportsPaused() throws {
    let original = SharedSettingsStore(backing: InMemoryBacking())
    try seed(original)
    let backing = InMemoryBacking(original.encodedRecord())
    let fallback = SharedSettingsStore(backing: backing, coordinationAvailable: false)
    var notifications = 0
    let bridge = SettingsBridge(store: fallback, notifyChanged: { notifications += 1 })
    let reply = bridge.handle(.intent(path: "globalOn", value: false, updatedAt: 10))
    XCTAssertEqual(try root(Data(reply.utf8))["status"] as? String, "paused")
    XCTAssertFalse(fallback.current().globalOn)
    let stored = try root(XCTUnwrap(backing.read()))
    let atomic = try XCTUnwrap(stored["atomic"] as? [String: Any])
    XCTAssertEqual(atomic["paused"] as? String, "coordination-unavailable")
    XCTAssertEqual((atomic["pending"] as? [Any])?.count, 0)
    XCTAssertEqual(notifications, 0)
  }
  func testFailedReplacementsDoNotLeakDescriptorsOrTemporaryResources() throws {
    let dir = try directory()
    let peer = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir))
    try seed(peer)
    enum Injected: Error { case failure }
    let store = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir, beforeReplace: { throw Injected.failure }))
    let before = try FileManager.default.contentsOfDirectory(atPath: "/dev/fd").count
    for _ in 0..<50 { XCTAssertThrowsError(try store.commitIntent(path: "globalOn", value: false, updatedAt: 10)) }
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: "/dev/fd").count, before)
    XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: dir.path).contains { $0.hasSuffix(".tmp") })
  }
  func testStrictBridgeIntentRejectsUnknownAndNumericBooleans() {
    XCTAssertNil(BridgeRequest.parse(["kind": "settingsIntent", "path": "globalOn", "value": 1, "updatedAt": 10]))
    XCTAssertNil(BridgeRequest.parse(["kind": "settingsIntent", "path": "sites.tiktok", "value": false, "updatedAt": 10]))
    XCTAssertNil(BridgeRequest.parse(["kind": "settingsIntent", "path": "globalOn", "value": false, "updatedAt": true]))
    XCTAssertNil(BridgeRequest.parse(["kind": "settingsIntent", "path": "globalOn", "value": false, "updatedAt": 10, "extra": true]))
  }
}
