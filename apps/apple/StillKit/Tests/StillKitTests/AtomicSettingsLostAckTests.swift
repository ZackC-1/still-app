import XCTest
@testable import StillKit

/// U3-W3: a host (the app or the Safari extension handler) is killed after its App Group write and
/// before its reply reaches the caller. The bridge calls `notifyChanged` after the locked atomic
/// replacement has returned and before it builds the reply, so the injected notifier marks that
/// exact point: it captures what a peer process reads there, and the test then discards the reply
/// as a killed host would. A relaunch is a new store and bridge over the same App Group directory.
/// The compiled two-process SIGKILL version of this case lives in packages/core
/// (atomic-settings.test.ts, "killed after the App Group write but before replying").
final class AtomicSettingsLostAckTests: XCTestCase {
  private let account = "11111111-1111-1111-1111-111111111111"
  private let session = "cccccccc-cccc-cccc-cccc-cccccccccccc"
  private let lineage = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

  private final class Counter { var value = 0 }

  private func directory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("still-lost-ack-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }
  private func store(_ dir: URL) -> SharedSettingsStore { SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)) }
  private func state(_ data: Data?) throws -> [String: Any] {
    let root = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(data)) as? [String: Any])
    return try XCTUnwrap(root["atomic"] as? [String: Any])
  }
  private func globalOn(_ data: Data?) throws -> Bool? {
    let root = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(data)) as? [String: Any])
    return (root["settings"] as? [String: Any])?["globalOn"] as? Bool
  }
  private func reply(_ json: String) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
  }
  private func seed(_ dir: URL, ownership: String = "unknown") throws {
    let s = store(dir)
    s.save(StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 1))
    _ = try s.initializeAtomic(ownership: ownership)
  }
  /// Signed-in, acknowledged scope: each choice queues one immutable request.
  private func seedLinked(_ dir: URL) throws {
    try seed(dir)
    let s = store(dir)
    _ = try s.atomicCommand(JSONSerialization.data(withJSONObject: ["action": "scope", "accountId": account, "sessionId": session]))
    let root = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(s.encodedRecord())) as? [String: Any])
    let scope = try XCTUnwrap((root["atomic"] as? [String: Any])?["scope"])
    _ = try s.atomicCommand(JSONSerialization.data(withJSONObject: ["action": "acknowledge", "scope": scope,
      "envelope": ["protocol": 2, "empty": true, "settings": try XCTUnwrap(root["settings"]), "version": 0,
        "serverUpdatedAt": NSNull(), "lastWriteId": NSNull(), "lineage": lineage,
        "receipt": ["version": 1, "lineage": lineage, "revision": 0, "mac": String(repeating: "A", count: 43)]]]))
  }
  /// Sends one intent through a host that "dies" right after its durable write: returns what a
  /// peer read at that moment. The host's reply is discarded, never delivered.
  private func killedAfterWrite(_ dir: URL, path: String = "globalOn", value: Bool, updatedAt: Int) throws -> Data? {
    var peerAtDeath: Data?
    let dying = SettingsBridge(store: store(dir), notifyChanged: { peerAtDeath = self.store(dir).encodedRecord() })
    _ = dying.handle(.intent(path: path, value: value, updatedAt: updatedAt))
    return peerAtDeath
  }

  func testKilledAfterAppGroupWriteKeepsOneDurableRequestAndDuplicateIsANoOp() throws {
    let dir = try directory(); try seedLinked(dir)
    let durable = try XCTUnwrap(try killedAfterWrite(dir, value: false, updatedAt: 10), "the write was durable before the reply")
    XCTAssertEqual(try globalOn(durable), false)
    XCTAssertEqual((try state(durable)["pending"] as? [Any])?.count, 1)
    // Relaunch: a new process reads exactly what the peer read when the host died.
    let notified = Counter()
    let relaunched = SettingsBridge(store: store(dir), notifyChanged: { notified.value += 1 })
    XCTAssertEqual(relaunched.handle(.get), String(data: durable, encoding: .utf8))
    let duplicate = try reply(relaunched.handle(.intent(path: "globalOn", value: false, updatedAt: 10)))
    XCTAssertEqual(duplicate["changed"] as? Bool, false)
    XCTAssertEqual(duplicate["status"] as? String, "committed")
    XCTAssertEqual(store(dir).encodedRecord(), durable)
    XCTAssertEqual(notified.value, 0)
  }

  func testKilledAtPendingLimitDuplicateNeitherQueuesNorPauses() throws {
    let dir = try directory(); try seedLinked(dir)
    let s = store(dir)
    for i in 0..<63 { _ = try s.commitIntent(path: "globalOn", value: i % 2 == 1, updatedAt: 10 + i) }
    let durable = try XCTUnwrap(try killedAfterWrite(dir, value: true, updatedAt: 100))
    let atLimit = try state(durable)
    XCTAssertEqual((atLimit["pending"] as? [Any])?.count, 64)
    XCTAssertTrue(atLimit["paused"] is NSNull)
    let duplicate = try reply(SettingsBridge(store: store(dir), notifyChanged: {}).handle(.intent(path: "globalOn", value: true, updatedAt: 100)))
    XCTAssertEqual(duplicate["changed"] as? Bool, false)
    XCTAssertEqual(store(dir).encodedRecord(), durable)
    // A genuinely different later choice is kept in the local hold, never dropped.
    _ = try store(dir).commitIntent(path: "globalOn", value: false, updatedAt: 101)
    let held = try state(store(dir).encodedRecord())
    XCTAssertEqual(held["paused"] as? String, "pending-limit")
    XCTAssertEqual(held["held"] as? [String: Bool], ["globalOn": false])
    XCTAssertEqual((held["pending"] as? [Any])?.count, 64)
  }

  func testKilledUnknownOwnerOffSurvivesWakeWithoutRewrite() throws {
    let dir = try directory(); try seed(dir)
    let durable = try XCTUnwrap(try killedAfterWrite(dir, value: false, updatedAt: 10))
    XCTAssertEqual(try globalOn(durable), false)
    let relaunched = store(dir)
    XCTAssertEqual(try relaunched.initializeAtomic(ownership: "unknown"), durable)
    let duplicate = try reply(SettingsBridge(store: relaunched, notifyChanged: {}).handle(.intent(path: "globalOn", value: false, updatedAt: 10)))
    XCTAssertEqual(duplicate["changed"] as? Bool, false)
    XCTAssertEqual(store(dir).encodedRecord(), durable)
  }

  func testKilledBeforeReplacementLeavesOnlyAnUnreadOrphanThatAPeerRemoves() throws {
    let dir = try directory(); try seed(dir)
    let before = try XCTUnwrap(store(dir).encodedRecord())
    // What a writer killed between its temporary write and the rename leaves behind.
    let orphan = dir.appendingPathComponent("still-settings." + UUID().uuidString + ".tmp")
    var other = try XCTUnwrap(JSONSerialization.jsonObject(with: before) as? [String: Any])
    var settings = try XCTUnwrap(other["settings"] as? [String: Any]); settings["globalOn"] = false; other["settings"] = settings
    try JSONSerialization.data(withJSONObject: other).write(to: orphan)
    XCTAssertEqual(store(dir).encodedRecord(), before)
    XCTAssertEqual(try globalOn(store(dir).encodedRecord()), true)
    XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
  }
}
