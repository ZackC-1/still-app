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
  }
}
