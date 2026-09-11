import Foundation
import XCTest
@testable import StillKit

final class AccountSyncStatusTests: XCTestCase {
  private func status() -> [String: Any] {
    [
      "accountId": "11111111-1111-4111-8111-111111111111",
      "email": "reader@example.test",
      "lastSyncedAt": 1_700_000_000_123.5,
      "pendingUpload": false,
      "cloudReachable": true,
      "updatedAt": 1_700_000_000_456.5,
    ]
  }

  func testAppWritesStatusThatSafariReadsFromSharedBacking() throws {
    let backing = InMemoryBacking()
    let app = AccountSyncStatusStore(backing: backing)
    let safari = AccountSyncStatusStore(backing: backing)
    XCTAssertTrue(app.save(rawStatus: status()))
    let reply = try XCTUnwrap(safari.readReply(rawBody: ["kind": "getAccountSyncStatus"]))
    let json = try XCTUnwrap(reply["accountSyncStatus"] as? String)
    let value = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    XCTAssertEqual(value["accountId"] as? String, "11111111-1111-4111-8111-111111111111")
    XCTAssertEqual(value["email"] as? String, "reader@example.test")
    XCTAssertEqual(value["lastSyncedAt"] as? Double, 1_700_000_000_123.5)
    XCTAssertEqual(value["pendingUpload"] as? Bool, false)
    XCTAssertEqual(value["cloudReachable"] as? Bool, true)
    XCTAssertEqual(value["updatedAt"] as? Double, 1_700_000_000_456.5)
  }

  func testInvalidStatusCannotReplaceCurrentAccount() throws {
    let store = AccountSyncStatusStore(backing: InMemoryBacking())
    XCTAssertTrue(store.save(rawStatus: status()))
    let initial = store.peek()
    let invalidFields: [(String, Any)] = [
      ("accountId", ""), ("accountId", "not-a-uuid"), ("accountId", NSNull()),
      ("email", String(repeating: "a", count: 321)), ("email", 123),
      ("email", String(repeating: "😀", count: 161)),
      ("lastSyncedAt", -1), ("lastSyncedAt", true), ("lastSyncedAt", "12"),
      ("lastSyncedAt", Double.infinity), ("lastSyncedAt", Double.nan),
      ("updatedAt", -1), ("updatedAt", false), ("updatedAt", NSNull()),
      ("updatedAt", Double.infinity), ("updatedAt", Double.nan),
      ("pendingUpload", 1), ("pendingUpload", "false"), ("pendingUpload", NSNull()),
      ("cloudReachable", 0), ("cloudReachable", "true"), ("cloudReachable", NSNull()),
    ]
    for (key, value) in invalidFields {
      var invalid = status()
      invalid[key] = value
      XCTAssertFalse(store.save(rawStatus: invalid), "accepted invalid \(key): \(value)")
      XCTAssertEqual(store.peek(), initial, "mutated for invalid \(key)")
    }
    for key in status().keys {
      var missing = status()
      missing.removeValue(forKey: key)
      XCTAssertFalse(store.save(rawStatus: missing), "accepted missing \(key)")
      XCTAssertEqual(store.peek(), initial)
    }
    for malformed: Any in ["{}", [], 1, true] {
      XCTAssertFalse(store.save(rawStatus: malformed))
      XCTAssertEqual(store.peek(), initial)
    }
  }

  func testNullClearsAccountImmediatelyForSiblingReader() throws {
    let backing = InMemoryBacking()
    let app = AccountSyncStatusStore(backing: backing)
    let safari = AccountSyncStatusStore(backing: backing)
    XCTAssertTrue(app.save(rawStatus: status()))
    XCTAssertTrue(app.save(rawStatus: NSNull()))
    XCTAssertNil(safari.peek())
    let reply = try XCTUnwrap(safari.readReply(rawBody: ["kind": "getAccountSyncStatus"]))
    XCTAssertTrue(reply["accountSyncStatus"] is NSNull)
  }

  func testNullableFieldsStayExplicitAndBoundaryValuesAreAccepted() throws {
    let store = AccountSyncStatusStore(backing: InMemoryBacking())
    var value = status()
    value["email"] = NSNull()
    value["lastSyncedAt"] = NSNull()
    value["updatedAt"] = 0
    value["pendingUpload"] = true
    value["cloudReachable"] = false
    XCTAssertTrue(store.save(rawStatus: value))
    let reply = try XCTUnwrap(store.readReply(rawBody: ["kind": "getAccountSyncStatus"]))
    let json = try XCTUnwrap(reply["accountSyncStatus"] as? String)
    let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    XCTAssertTrue(decoded["email"] is NSNull)
    XCTAssertTrue(decoded["lastSyncedAt"] is NSNull)
    XCTAssertEqual(store.peek()?.updatedAt, 0)
    XCTAssertEqual(store.peek()?.pendingUpload, true)
    XCTAssertEqual(store.peek()?.cloudReachable, false)
    value["email"] = String(repeating: "a", count: 320)
    value["lastSyncedAt"] = 0
    XCTAssertTrue(store.save(rawStatus: value))
    XCTAssertEqual(store.peek()?.email?.count, 320)
    XCTAssertEqual(store.peek()?.lastSyncedAt, 0)
  }

  func testSafariReadLaneRejectsSettersAndArbitraryKeysWithoutMutation() {
    let store = AccountSyncStatusStore(backing: InMemoryBacking())
    XCTAssertTrue(store.save(rawStatus: status()))
    let initial = store.peek()
    for kind in ["setAccountSyncStatus", "set", "clear", "signOut", "get"] {
      XCTAssertNil(store.readReply(rawBody: ["kind": kind, "status": NSNull(), "key": "still:account-sync-status"]))
      XCTAssertEqual(store.peek(), initial)
    }
    XCTAssertNil(store.readReply(rawBody: ["key": "still:account-sync-status"]))
    XCTAssertNil(store.readReply(rawBody: "getAccountSyncStatus"))
    store.clear()
    XCTAssertNil(store.peek())
  }

  func testMissingOrCorruptStoredStatusReturnsExplicitNull() throws {
    for data in [nil, Data("garbage".utf8), Data("{}".utf8), Data("null".utf8)] {
      let store = AccountSyncStatusStore(backing: InMemoryBacking(data))
      let reply = try XCTUnwrap(store.readReply(rawBody: ["kind": "getAccountSyncStatus"]))
      XCTAssertTrue(reply["accountSyncStatus"] is NSNull)
    }
    var invalid = status()
    invalid["accountId"] = "invalid"
    let data = try JSONSerialization.data(withJSONObject: invalid)
    let store = AccountSyncStatusStore(backing: InMemoryBacking(data))
    XCTAssertNil(store.peek())
  }
}
