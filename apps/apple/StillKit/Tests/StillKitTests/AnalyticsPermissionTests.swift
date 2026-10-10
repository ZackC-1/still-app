import XCTest
@testable import StillKit

final class AnalyticsPermissionTests: XCTestCase {
  private func permission() -> [String: Any] {
    ["schemaVersion": 1, "state": "granted", "version": String(repeating: "a", count: 64),
     "origin": "00000000-0000-4000-8000-000000000001", "generation": 1,
     "provider": ["anonymousId": "00000000-0000-4000-8000-000000000002", "deviceId": "00000000-0000-4000-8000-000000000003"],
     "purposes": ["usage": true, "email": true, "ai": true]]
  }

  func testLegacyAnswersNeverGrantCombinedPermissionOrCreateIdentity() {
    for choice in [true, false] {
      let group = MemoryKeyValue()
      group.set(choice, forKey: AnalyticsIdentityStore.consentKey)
      let store = AnalyticsIdentityStore(group: group, newId: { XCTFail("read creates no identity"); return "" })
      XCTAssertNil(store.analyticsPermission)
      if choice { XCTAssertTrue(store.analyticsPermissionReply()["permission"] is NSNull) }
      else { XCTAssertEqual(store.analyticsPermissionReply()["permission"] as? Bool, false) }
      XCTAssertEqual(store.consent, choice)
      XCTAssertEqual(group.values.count, 1)
    }
  }

  func testTheExtensionReadsTheAppsPermissionReadOnly() {
    let group = MemoryKeyValue()
    let store = AnalyticsIdentityStore(group: group, newId: { XCTFail("the permission lane creates no identity"); return "" })
    let ask: [String: Any] = ["kind": "analyticsPermission"]
    // Nothing chosen yet (the app grants its default at launch): no permission, nothing written.
    XCTAssertTrue(store.extensionReply(rawBody: ask, platform: "ios", device: "phone")?["analyticsPermission"] is NSNull)
    XCTAssertTrue(group.values.isEmpty)
    // A 2.1 "off" stays off.
    group.set(false, forKey: AnalyticsIdentityStore.consentKey)
    XCTAssertEqual(store.extensionReply(rawBody: ask, platform: "ios", device: "phone")?["analyticsPermission"] as? Bool, false)
    // The app's granted record, then its stop, exactly as stored.
    XCTAssertEqual(store.commitAnalyticsPermission(permission())["ok"] as? Bool, true)
    let granted = store.extensionReply(rawBody: ask, platform: "macos", device: "desktop")?["analyticsPermission"] as? [String: Any]
    XCTAssertEqual(granted?["state"] as? String, "granted")
    XCTAssertEqual(granted?["origin"] as? String, permission()["origin"] as? String)
    store.setConsent(false)
    let stopped = store.extensionReply(rawBody: ask, platform: "macos", device: "desktop")?["analyticsPermission"] as? [String: Any]
    XCTAssertEqual(stopped?["state"] as? String, "stopped")
    XCTAssertEqual(group.values.count, 1, "reads never write")
    // Other kinds still fall through.
    XCTAssertNil(store.extensionReply(rawBody: ["kind": "commitAnalyticsPermission"], platform: "ios", device: "phone"))
  }

  func testGrantIsReadBackFromSameSlotAndLegacyOffRetainsStopAuthority() {
    let group = MemoryKeyValue()
    let store = AnalyticsIdentityStore(group: group)
    XCTAssertEqual(store.commitAnalyticsPermission(permission())["ok"] as? Bool, true)
    XCTAssertEqual(group.values.count, 1)
    XCTAssertTrue(store.consent)
    store.setConsent(false)
    XCTAssertFalse(store.consent)
    XCTAssertEqual(store.analyticsPermission?["state"] as? String, "stopped")
    XCTAssertEqual(store.analyticsPermission?["generation"] as? Int64, 2)
    XCTAssertEqual(store.analyticsPermission?["origin"] as? String, permission()["origin"] as? String)
    store.setConsent(true)
    XCTAssertFalse(store.consent, "an older switch cannot regrant combined permission")
    XCTAssertEqual(store.commitAnalyticsPermission(true)["ok"] as? Bool, false)
  }

  func testInvalidPermissionDoesNotOverwriteCommittedRecord() {
    let group = MemoryKeyValue()
    let store = AnalyticsIdentityStore(group: group)
    _ = store.commitAnalyticsPermission(permission())
    let original = group.string(forKey: AnalyticsIdentityStore.consentKey)
    var cases: [[String: Any]] = []
    for (key, value) in [("schemaVersion", true as Any), ("generation", false as Any),
                         ("generation", 1.5 as Any), ("generation", 9_007_199_254_740_992 as Any),
                         ("version", "unknown" as Any), ("extra", true as Any)] {
      var invalid = permission(); invalid[key] = value; cases.append(invalid)
    }
    var missingPurpose = permission(); missingPurpose["purposes"] = ["usage": true, "email": true]; cases.append(missingPurpose)
    for value in cases { XCTAssertEqual(store.commitAnalyticsPermission(value)["ok"] as? Bool, false) }
    XCTAssertEqual(group.string(forKey: AnalyticsIdentityStore.consentKey), original)
  }

  func testDuplicateAndEscapedStoredKeysAreNotPermission() throws {
    let group = MemoryKeyValue()
    let store = AnalyticsIdentityStore(group: group)
    let raw = String(data: try JSONSerialization.data(withJSONObject: permission()), encoding: .utf8)!
    group.set(raw.replacingOccurrences(of: "{", with: "{\"state\":\"stopped\",", range: raw.startIndex..<raw.index(after: raw.startIndex)), forKey: AnalyticsIdentityStore.consentKey)
    XCTAssertNil(store.analyticsPermission)
    group.set(raw.replacingOccurrences(of: "schemaVersion", with: "\\u0073chemaVersion"), forKey: AnalyticsIdentityStore.consentKey)
    XCTAssertNil(store.analyticsPermission)
  }

  func testRefusedPersistenceNeverReportsCommittedPermission() {
    let group = RefusingConsentStore()
    let store = AnalyticsIdentityStore(group: group)
    XCTAssertEqual(store.commitAnalyticsPermission(permission())["ok"] as? Bool, false)
    XCTAssertNil(store.analyticsPermission)
    XCTAssertEqual(store.commitAnalyticsPermission(false)["ok"] as? Bool, false)
  }
}

private final class RefusingConsentStore: AnalyticsKeyValue {
  func string(forKey key: String) -> String? { nil }
  func object(forKey key: String) -> Any? { nil }
  func set(_ value: Any?, forKey key: String) {}
}
