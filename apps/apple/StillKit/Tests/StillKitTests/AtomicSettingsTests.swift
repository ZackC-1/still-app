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
