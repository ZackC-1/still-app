import XCTest
@testable import StillKit

/// StillKit parity with the reviewed TypeScript AtomicSettingsWriter for unknown-ownership,
/// account-free records (local-only edits), initialization provenance, and the recovery of the
/// pending-limit pause that earlier StillKit builds persisted on those records.
final class AtomicSettingsLocalOnlyTests: XCTestCase {
  private let account = "11111111-1111-1111-1111-111111111111"

  private func directory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("still-local-only-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }
  private func root(_ data: Data?) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(data)) as? [String: Any])
  }
  private func state(_ data: Data?) throws -> [String: Any] { try XCTUnwrap(root(data)["atomic"] as? [String: Any]) }
  private func settings(_ data: Data?) throws -> [String: Any] { try XCTUnwrap(root(data)["settings"] as? [String: Any]) }
  private func step(_ data: Data?, _ path: String) throws -> Int {
    try XCTUnwrap(((settings(data)["clocks"] as? [String: Any])?[path] as? [String: Int])?["localStep"])
  }
  private func encode(_ object: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }
  /// A readable 2.1.x record moved into the unknown local-only authority.
  private func unknownRecord(updatedAt: Int = 1) throws -> Data {
    let legacy = try JSONEncoder().encode(StoredSettingsRecord(settings: StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: updatedAt), syncMetadata: nil))
    return try AtomicSettingsRecord.initialize(legacy, ownership: "unknown")
  }
  /// The exact shape earlier StillKit builds persisted after 64 queued unknown local edits and one more.
  private func legacyPendingLimitRecord(pendingCount: Int = 64) throws -> Data {
    var record = try root(unknownRecord())
    var atomic = try XCTUnwrap(record["atomic"] as? [String: Any])
    var settings = try XCTUnwrap(record["settings"] as? [String: Any])
    var clocks = try XCTUnwrap(settings["clocks"] as? [String: Any])
    clocks["globalOn"] = ["baseRevision": 0, "localStep": pendingCount]
    settings["clocks"] = clocks
    settings["globalOn"] = pendingCount % 2 == 0
    settings["updatedAt"] = 10 + pendingCount
    atomic["pending"] = (0..<pendingCount).map { i in
      ["writeId": String(format: "00000000-0000-4000-8000-%012d", i + 1), "scope": atomic["scope"]!, "receipt": NSNull(),
       "operations": [["path": "globalOn", "value": i % 2 == 1, "baseRevision": 0, "localStep": i + 1]]] as [String: Any]
    }
    atomic["held"] = ["globalOn": pendingCount % 2 == 1, "sites.youtube.related": true]
    atomic["paused"] = "pending-limit"
    atomic["sequence"] = pendingCount + 2
    record["settings"] = settings; record["atomic"] = atomic
    return try encode(record)
  }

  // MARK: D1 — unknown local-only edits never queue and never reach a pending limit

  func testUnknownLocalEditsSaveInPlaceBeyondSixtyFourWithoutQueueing() throws {
    let backing = AtomicSettingsBacking(directory: try directory())
    let store = SharedSettingsStore(backing: backing)
    try backing.transaction { $0 = try unknownRecord() }
    let initial = try state(store.encodedRecord())
    for i in 0..<200 {
      let value = i % 2 != 0
      let committed = try store.commitIntent(path: "globalOn", value: value, updatedAt: 100 + i)
      XCTAssertTrue(committed.changed, "edit \(i)")
      let atomic = try state(committed.data)
      XCTAssertEqual((atomic["pending"] as? [Any])?.count, 0, "edit \(i)")
      XCTAssertEqual(atomic["paused"] as? NSNull, NSNull(), "edit \(i)")
      XCTAssertEqual(atomic["held"] as? [String: Bool], [:], "edit \(i)")
      XCTAssertEqual(atomic["ownership"] as? String, "unknown")
      XCTAssertEqual(atomic["scope"] as? NSDictionary, initial["scope"] as? NSDictionary)
      XCTAssertEqual(atomic["sequence"] as? Int, i + 1)
      XCTAssertEqual(try settings(committed.data)["globalOn"] as? Bool, value)
      XCTAssertEqual(try settings(committed.data)["updatedAt"] as? Int, 100 + i)
      XCTAssertEqual(try step(committed.data, "globalOn"), i + 1)
      XCTAssertEqual(store.current().globalOn, value)
    }
    // A matching request is not an edit and writes nothing.
    let before = try store.readCommittedRecord()
    let repeated = try store.commitIntent(path: "globalOn", value: true, updatedAt: 999)
    XCTAssertFalse(repeated.changed); XCTAssertEqual(try store.readCommittedRecord(), before)
    // Expanded fields are local-only edits too.
    let feature = try store.commitIntent(path: "sites.youtube.related", value: true, updatedAt: 1_000)
    XCTAssertEqual((try settings(feature.data)["sites"] as? [String: Bool])?["youtube.related"], true)
    XCTAssertEqual((try state(feature.data)["pending"] as? [Any])?.count, 0)
  }

  func testUnknownLocalEditsRetainExistingRequestsAndSaveADeliberateHeldChoice() throws {
    var record = try root(legacyPendingLimitRecord())
    var atomic = try XCTUnwrap(record["atomic"] as? [String: Any])
    atomic["paused"] = NSNull(); atomic["held"] = ["globalOn": false, "services.youtube": false]
    atomic["futureState"] = ["keep": true]; record["atomic"] = atomic; record["futureRoot"] = ["keep": true]
    let raw = try encode(record)
    let pending = try XCTUnwrap(atomic["pending"] as? NSArray)
    let saved = try AtomicSettingsRecord.commit(raw, path: "globalOn", value: false, updatedAt: 500)
    XCTAssertTrue(saved.changed)
    let next = try state(saved.data)
    XCTAssertEqual(next["pending"] as? NSArray, pending)
    XCTAssertEqual(next["held"] as? [String: Bool], ["services.youtube": false])
    XCTAssertEqual(next["futureState"] as? [String: Bool], ["keep": true])
    XCTAssertEqual(try root(saved.data)["futureRoot"] as? [String: Bool], ["keep": true])
    // The saved field was On under an Off overlay: the deliberate Off choice is saved with a new stamp.
    XCTAssertEqual(try settings(saved.data)["globalOn"] as? Bool, false)
    XCTAssertEqual(try step(saved.data, "globalOn"), 65)
    XCTAssertEqual(try settings(saved.data)["updatedAt"] as? Int, 500)
    XCTAssertEqual(next["paused"] as? NSNull, NSNull())
  }

  func testTwoIndependentHostsSaveUnknownLocalEditsWithDistinctSteps() throws {
    let dir = try directory()
    let first = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir))
    let peer = SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir))
    try AtomicSettingsBacking(directory: dir).transaction { $0 = try unknownRecord() }
    _ = try first.commitIntent(path: "globalOn", value: false, updatedAt: 10)
    _ = try peer.commitIntent(path: "services.youtube", value: false, updatedAt: 10)
    _ = try peer.commitIntent(path: "globalOn", value: true, updatedAt: 10)
    let saved = first.encodedRecord()
    XCTAssertEqual(try step(saved, "globalOn"), 2); XCTAssertEqual(try step(saved, "services.youtube"), 1)
    XCTAssertFalse(first.current().services.youtube); XCTAssertTrue(first.current().globalOn)
    XCTAssertEqual((try state(saved)["pending"] as? [Any])?.count, 0)
    XCTAssertEqual(try state(saved)["sequence"] as? Int, 3)
  }

  func testIneligibleUnknownAccountFreeRecordsRefuseWithoutWriting() throws {
    let base = try root(unknownRecord())
    let receipt: [String: Any] = ["version": 1, "lineage": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "revision": 1, "mac": String(repeating: "A", count: 43)]
    var shapes: [(String, [String: Any])] = []
    func shape(_ name: String, _ change: (inout [String: Any], inout [String: Any]) -> Void) {
      var record = base; var atomic = base["atomic"] as! [String: Any]
      change(&record, &atomic); record["atomic"] = atomic; shapes.append((name, record))
    }
    let scope = (base["atomic"] as! [String: Any])["scope"]!
    let request: [String: Any] = ["writeId": "dddddddd-dddd-dddd-dddd-dddddddddddd", "scope": scope, "receipt": NSNull(),
      "operations": [["path": "globalOn", "value": false, "baseRevision": 0, "localStep": 1]]]
    shape("anchor") { _, a in a["anchor"] = receipt }
    shape("ordering-hold") { _, a in a["paused"] = "ordering-hold" }
    shape("coordination-unavailable") { _, a in a["paused"] = "coordination-unavailable" }
    shape("receipt-bound request") { _, a in var r = request; r["receipt"] = receipt; a["pending"] = [r] }
    shape("transferred request") { _, a in var r = request; r["originScope"] = scope; a["pending"] = [r] }
    shape("other-generation request") { _, a in var r = request; r["scope"] = ["accountId": NSNull(), "generation": 5]; a["pending"] = [r] }
    shape("sequence saturated") { _, a in a["sequence"] = 9_007_199_254_740_991 }
    shape("ordering saturated") { r, _ in
      var settings = r["settings"] as! [String: Any]; var clocks = settings["clocks"] as! [String: Any]
      clocks["globalOn"] = ["baseRevision": 0, "localStep": 1_048_575]; settings["clocks"] = clocks; r["settings"] = settings
    }
    for (name, record) in shapes {
      let raw = try encode(record)
      let backing = InMemoryBacking(raw); let store = SharedSettingsStore(backing: backing)
      XCTAssertThrowsError(try store.commitIntent(path: "globalOn", value: false, updatedAt: 10), name)
      XCTAssertEqual(backing.read(), raw, name)
      // None of these is the retired pending-limit artifact, so a wake leaves it untouched too.
      XCTAssertEqual(try store.initializeAtomic(ownership: "unknown"), raw, name)
      XCTAssertEqual(backing.read(), raw, name)
    }
  }

  func testAccountScopedAndOtherOwnershipJournalsStillQueue() throws {
    for ownership in ["previous-account", "never-linked"] {
      let legacy = try JSONEncoder().encode(StoredSettingsRecord(settings: StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 1), syncMetadata: nil))
      let raw = try AtomicSettingsRecord.initialize(legacy, ownership: ownership)
      let saved = try AtomicSettingsRecord.commit(raw, path: "globalOn", value: false, updatedAt: 10)
      XCTAssertEqual((try state(saved.data)["pending"] as? [Any])?.count, 1, ownership)
    }
    // An unknown record that enters an account is no longer account-free local authority.
    let scoped = try AtomicSettingsRecord.command(try unknownRecord(), command: JSONSerialization.data(withJSONObject: ["action": "scope", "accountId": account]))
    XCTAssertEqual(try state(scoped)["paused"] as? String, "ownership-unconfirmed")
    let held = try AtomicSettingsRecord.commit(scoped, path: "globalOn", value: false, updatedAt: 10)
    XCTAssertEqual(try state(held.data)["held"] as? [String: Bool], ["globalOn": false])
    XCTAssertEqual((try state(held.data)["pending"] as? [Any])?.count, 0)
  }

  // MARK: D2 — absence is not provenance

  func testInitializeOnAbsentRecordWritesNothingLikeTypeScript() throws {
    let backing = AtomicSettingsBacking(directory: try directory())
    let store = SharedSettingsStore(backing: backing)
    for ownership in ["unknown", "previous-account", "never-linked"] {
      XCTAssertThrowsError(try store.initializeAtomic(ownership: ownership), ownership)
      XCTAssertThrowsError(try store.atomicCommand(JSONSerialization.data(withJSONObject: ["action": "initialize", "ownership": ownership])), ownership)
      XCTAssertNil(try store.readCommittedRecord(), ownership)
    }
  }

  // MARK: D3 — readable zero-stamp records initialize for every ownership marker

  func testZeroStampSyncedRecordInitializesForEveryOwnershipKeepingChoicesAndSyncState() throws {
    let metadata = SettingsSyncMetadata(version: 7, serverUpdatedAt: "2026-09-01T00:00:00Z", lastWriteId: nil)
    let services = StillServices(youtube: true, instagram: false, tiktok: true, facebook: false)
    for ownership in ["unknown", "previous-account", "never-linked"] {
      for sync in [metadata, nil] {
        var record = try root(JSONEncoder().encode(StoredSettingsRecord(settings: StillSettings(globalOn: false, services: services, pauses: [], updatedAt: 0), syncMetadata: sync, syncEpoch: 2)))
        record["futureRoot"] = ["keep": true]
        let raw = try encode(record)
        let backing = InMemoryBacking(raw); let store = SharedSettingsStore(backing: backing)
        let data = try store.initializeAtomic(ownership: ownership)
        let name = "\(ownership) \(sync == nil ? "local" : "synced")"
        let modern = try settings(data)
        XCTAssertEqual(modern["schemaVersion"] as? Int, 2, name)
        XCTAssertEqual(modern["globalOn"] as? Bool, false, name)
        XCTAssertEqual(modern["updatedAt"] as? Int, 0, name)
        XCTAssertEqual(modern["services"] as? [String: Bool], ["youtube": true, "instagram": false, "tiktok": true, "facebook": false], name)
        XCTAssertEqual((modern["sites"] as? [String: Bool])?["youtube.shorts"], true, name)
        XCTAssertEqual((modern["sites"] as? [String: Bool])?["instagram.reels"], false, name)
        XCTAssertEqual((modern["sites"] as? [String: Bool])?["youtube.related"], false, name)
        let decoded = try JSONDecoder().decode(StoredSettingsRecord.self, from: data)
        XCTAssertEqual(decoded.syncMetadata, sync, name); XCTAssertEqual(decoded.syncEpoch, 2, name)
        XCTAssertEqual(try root(data)["futureRoot"] as? [String: Bool], ["keep": true], name)
        XCTAssertEqual(try state(data)["ownership"] as? String, ownership, name)
        XCTAssertEqual(store.current().services, services, name)
        XCTAssertFalse(store.current().globalOn, name)
        XCTAssertEqual(try store.initializeAtomic(ownership: ownership), data, name)
      }
    }
  }

  func testFutureAndUnreadableRecordsStillRefuseInitializationUntouched() throws {
    let valid = try root(JSONEncoder().encode(StoredSettingsRecord(settings: StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 0), syncMetadata: nil)))
    var damaged: [(String, Data)] = []
    for (name, change) in [("future", { (s: inout [String: Any]) in s["schemaVersion"] = 99 }),
                           ("malformed", { (s: inout [String: Any]) in s["globalOn"] = 1 }),
                           ("negative stamp", { (s: inout [String: Any]) in s["updatedAt"] = -1 })] as [(String, (inout [String: Any]) -> Void)] {
      var record = valid; var settings = record["settings"] as! [String: Any]; change(&settings); record["settings"] = settings
      damaged.append((name, try encode(record)))
    }
    damaged.append(("not json", Data("{".utf8)))
    for (name, raw) in damaged {
      for ownership in ["unknown", "previous-account", "never-linked"] {
        let backing = InMemoryBacking(raw); let store = SharedSettingsStore(backing: backing)
        XCTAssertThrowsError(try store.initializeAtomic(ownership: ownership), "\(name) \(ownership)")
        XCTAssertEqual(backing.read(), raw, "\(name) \(ownership)")
      }
    }
  }

  // MARK: Recovery of the retired pending-limit pause

  func testWakeRecoversRetiredPendingLimitKeepingEverySavedValue() throws {
    for count in [64, 0] { // 0: the queue was already retired by a later account-free scope change
      let raw = try legacyPendingLimitRecord(pendingCount: count)
      let backing = AtomicSettingsBacking(directory: try directory())
      try backing.transaction { $0 = raw }
      let store = SharedSettingsStore(backing: backing)
      let shownBefore = store.current()
      let recovered = try store.initializeAtomic(ownership: "unknown")
      let before = try root(raw), after = try root(recovered)
      var expected = try XCTUnwrap(before["atomic"] as? [String: Any])
      expected["paused"] = NSNull(); expected["sequence"] = (expected["sequence"] as! Int) + 1
      XCTAssertEqual(after["atomic"] as? NSDictionary, expected as NSDictionary, "\(count)")
      XCTAssertEqual(after["settings"] as? NSDictionary, before["settings"] as? NSDictionary, "\(count)")
      XCTAssertEqual(store.current(), shownBefore, "\(count)")
      XCTAssertEqual(try store.readCommittedRecord(), recovered)
      // A later wake leaves the recovered record alone; edits are admitted again.
      XCTAssertEqual(try store.initializeAtomic(ownership: "unknown"), recovered)
      let held = count % 2 == 1
      let edit = try store.commitIntent(path: "globalOn", value: !held, updatedAt: 900)
      XCTAssertTrue(edit.changed)
      XCTAssertEqual(try state(edit.data)["held"] as? [String: Bool], ["sites.youtube.related": true])
      XCTAssertEqual(try state(edit.data)["pending"] as? NSArray, expected["pending"] as? NSArray)
      XCTAssertEqual(try settings(edit.data)["globalOn"] as? Bool, !held)
    }
  }

  func testDirectCommitRecoversRetiredPendingLimitWithoutAWake() throws {
    let raw = try legacyPendingLimitRecord()
    // The held overlay is Off and the saved field is On: turning it On saves no new stamp but
    // clears the overlay; turning the held Pro feature Off saves the person's deliberate choice.
    let on = try AtomicSettingsRecord.commit(raw, path: "globalOn", value: true, updatedAt: 900)
    XCTAssertTrue(on.changed)
    XCTAssertEqual(try state(on.data)["paused"] as? NSNull, NSNull())
    XCTAssertEqual(try state(on.data)["held"] as? [String: Bool], ["sites.youtube.related": true])
    XCTAssertEqual(try step(on.data, "globalOn"), 64)
    let off = try AtomicSettingsRecord.commit(on.data, path: "sites.youtube.related", value: false, updatedAt: 901)
    XCTAssertEqual(try state(off.data)["held"] as? [String: Bool], [:])
    XCTAssertEqual((try settings(off.data)["sites"] as? [String: Bool])?["youtube.related"], false)
    XCTAssertEqual((try state(off.data)["pending"] as? [Any])?.count, 64)
  }

  func testPendingLimitOutsideTheRetiredLocalShapeIsNotRecovered() throws {
    var shapes: [Data] = []
    for change in [{ (a: inout [String: Any]) in a["ownership"] = "previous-account" },
                   { (a: inout [String: Any]) in a["anchor"] = ["version": 1, "lineage": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "revision": 1, "mac": String(repeating: "A", count: 43)] }] {
      var record = try root(legacyPendingLimitRecord()); var atomic = record["atomic"] as! [String: Any]
      change(&atomic); record["atomic"] = atomic; shapes.append(try encode(record))
    }
    var scoped = try root(legacyPendingLimitRecord()); var atomic = scoped["atomic"] as! [String: Any]
    let scope: [String: Any] = ["accountId": account, "generation": 1]
    atomic["scope"] = scope
    atomic["pending"] = (atomic["pending"] as! [[String: Any]]).map { var p = $0; p["scope"] = scope; return p }
    scoped["atomic"] = atomic; shapes.append(try encode(scoped))
    for raw in shapes {
      let backing = InMemoryBacking(raw); let store = SharedSettingsStore(backing: backing)
      XCTAssertEqual(try store.initializeAtomic(ownership: "unknown"), raw)
      XCTAssertEqual(backing.read(), raw)
    }
  }
}
