import XCTest
@testable import StillKit

/// T9 (U3-W4): the Safari extension handler refuses atomic commands natively. Initialize, scope and
/// acknowledge belong to the app (the only cloud client and converter); the extension commits
/// single-field intents, reads, and offers its retained copy after a reinstall.
final class ExtensionBridgeAuthorityTests: XCTestCase {
  private let account = "11111111-1111-1111-1111-111111111111"

  private func directory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("still-extension-bridge-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }
  private final class Counter { var value = 0 }
  private func atomic(_ command: String) -> [String: Any] { ["kind": "settingsAtomic", "command": command] }
  private var commands: [String] {
    [
      "{\"action\":\"initialize\",\"ownership\":\"unknown\"}",
      "{\"action\":\"initialize\",\"ownership\":\"never-linked\"}",
      "{\"action\":\"scope\",\"accountId\":\"\(account)\"}",
      "{\"action\":\"scope\",\"accountId\":null}",
      "{\"action\":\"acknowledge\",\"envelope\":{},\"scope\":{\"accountId\":null,\"generation\":0}}",
    ]
  }

  func testExtensionRefusesEveryAtomicCommandWithoutWriting() throws {
    for start in [nil, try AtomicSettingsRecord.firstRecord(.newInstall),
                  try JSONEncoder().encode(StoredSettingsRecord(settings: StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 9), syncMetadata: nil))] {
      let dir = try directory()
      if let start { try AtomicSettingsBacking(directory: dir).transaction { $0 = start } }
      let notified = Counter()
      let bridge = SettingsBridge.safariExtension(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)), notifyChanged: { notified.value += 1 })
      for command in commands {
        XCTAssertEqual(bridge.handle(rawBody: atomic(command)), "{\"status\":\"unavailable\"}", command)
      }
      XCTAssertEqual(try AtomicSettingsBacking(directory: dir).transaction { $0 }, start)
      XCTAssertEqual(notified.value, 0)
      XCTAssertNil(bridge.firstRecord)
    }
  }

  /// Review P2: over an absent, legacy or first-record App Group, a coarse `set` carrying a modern
  /// record must not plant extension-chosen ownership, scope or account.
  func testExtensionRefusesModernRecordsThroughSetWithoutWriting() throws {
    var planted = try XCTUnwrap(JSONSerialization.jsonObject(with: AtomicSettingsRecord.firstRecord(.newInstall)) as? [String: Any])
    var state = try XCTUnwrap(planted["atomic"] as? [String: Any])
    state["ownership"] = "previous-account"
    state["scope"] = ["accountId": account, "generation": 4]
    planted["atomic"] = state
    let modern = String(decoding: try JSONSerialization.data(withJSONObject: planted), as: UTF8.self)
    // A modern settings document without an atomic state (schemaVersion 2), decodable as a record.
    let schemaOnly = "{\"settings\":{\"schemaVersion\":2,\"globalOn\":false,\"services\":{\"youtube\":true,\"instagram\":true,\"tiktok\":true,\"facebook\":true},\"pauses\":[],\"updatedAt\":5},\"syncMetadata\":null}"
    let legacy = try JSONEncoder().encode(StoredSettingsRecord(settings: StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 9), syncMetadata: nil))
    for start in [nil, legacy, try AtomicSettingsRecord.firstRecord(.newInstall)] {
      for incoming in [modern, schemaOnly] {
        let dir = try directory()
        if let start { try AtomicSettingsBacking(directory: dir).transaction { $0 = start } }
        let notified = Counter()
        let bridge = SettingsBridge.safariExtension(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)), notifyChanged: { notified.value += 1 })
        XCTAssertEqual(bridge.handle(rawBody: ["kind": "set", "settings": incoming]), "{\"status\":\"unavailable\"}", incoming)
        XCTAssertEqual(bridge.handle(BridgeRequest.setPreserved(Data(incoming.utf8))), "{\"status\":\"unavailable\"}")
        XCTAssertEqual(try AtomicSettingsBacking(directory: dir).transaction { $0 }, start)
        XCTAssertEqual(notified.value, 0)
      }
    }
    // A legacy record through set still works for the extension (its 2.x path).
    let dir = try directory()
    let bridge = SettingsBridge.safariExtension(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)), notifyChanged: {})
    XCTAssertNotEqual(bridge.handle(rawBody: ["kind": "set", "settings": String(decoding: legacy, as: UTF8.self)]), "{\"status\":\"unavailable\"}")
    XCTAssertNotNil(try AtomicSettingsBacking(directory: dir).transaction { $0 })
  }

  func testExtensionKeepsItsOwnLanes() throws {
    let dir = try directory()
    try AtomicSettingsBacking(directory: dir).transaction { $0 = try AtomicSettingsRecord.firstRecord(.newInstall) }
    let bridge = SettingsBridge.safariExtension(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)), notifyChanged: {})
    // Reads and single-field intents still work.
    XCTAssertNotEqual(bridge.handle(rawBody: ["kind": "get"]), "")
    let reply = try XCTUnwrap(bridge.handle(rawBody: ["kind": "settingsIntent", "path": "services.youtube", "value": false, "updatedAt": 10]))
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any])
    XCTAssertEqual(object["status"] as? String, "committed")
    XCTAssertEqual(object["changed"] as? Bool, true)
    // The reinstall adoption offer stays available to the extension (it decides nothing itself).
    let adopt = try XCTUnwrap(bridge.handle(rawBody: ["kind": "settingsAdopt", "settings": "{}"]))
    XCTAssertTrue(adopt.contains("\"status\":\"kept\""), adopt)
  }

  func testTheAppBridgeStillAdmitsAtomicCommands() throws {
    let dir = try directory()
    let app = SettingsBridge(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)), notifyChanged: {}, firstRecord: .newInstall)
    XCTAssertTrue(app.admitsAtomicCommands)
    let reply = try XCTUnwrap(app.handle(rawBody: atomic(commands[0])))
    XCTAssertNotEqual(reply, "{\"status\":\"unavailable\"}")
    XCTAssertEqual(try AtomicSettingsBacking(directory: dir).transaction { $0 }, try AtomicSettingsRecord.firstRecord(.newInstall))
  }

  /// The extension handler (app target, not built by `swift test`) must use the refusing bridge.
  func testTheSafariHandlerUsesTheExtensionBridge() throws {
    let handler = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Still/Shared (Extension)/SafariWebExtensionHandler.swift")
    let source = try String(contentsOf: handler, encoding: .utf8)
    XCTAssertTrue(source.contains("private let bridge = SettingsBridge.safariExtension(store: .appGroup())"))
    XCTAssertFalse(source.contains("SettingsBridge(store:"))
    // Its benefit read resolves under the app-bound account session (one purchase everywhere).
    XCTAssertTrue(source.contains("private let entitlementBridge = EntitlementBridge.safariExtension(store: .appGroup())"))
    XCTAssertFalse(source.contains("EntitlementBridge(store:"))
    // The background reads this lane's reply under `entitlement` (packages/ext-safari).
    XCTAssertTrue(source.contains("payload = [\"entitlement\": entitlementJSON]"))
  }
}
