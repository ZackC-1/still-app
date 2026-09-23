import XCTest
@testable import StillKit

final class MemoryKeyValue: AnalyticsKeyValue {
  var values: [String: Any] = [:]
  func string(forKey key: String) -> String? { values[key] as? String }
  func object(forKey key: String) -> Any? { values[key] }
  func set(_ value: Any?, forKey key: String) { values[key] = value }
}

final class AnalyticsIdentityTests: XCTestCase {
  private var counter = 0
  private func ids() -> () -> String {
    { [unowned self] in
      self.counter += 1
      return String(format: "00000000-0000-4000-8000-%012d", self.counter)
    }
  }

  func testFirstLaunchCreatesAndSharesAnAnchor() {
    let group = MemoryKeyValue()
    let cloud = MemoryKeyValue()
    let context = AnalyticsIdentityStore(group: group, newId: ids())
      .appContext(appVersion: "2.1.0", ubiquitous: cloud, earlierInstallVersion: nil)
    XCTAssertTrue(context.created)
    XCTAssertFalse(context.returning)
    XCTAssertNil(context.previousVersion)
    XCTAssertEqual(cloud.string(forKey: AnalyticsIdentityStore.anchorKey), context.install.anchorId)
    XCTAssertNotEqual(context.install.installId, context.install.anchorId)
    XCTAssertTrue(context.consent)
    XCTAssertFalse(context.noticeSeen)
  }

  func testRelaunchKeepsTheRecord() {
    let group = MemoryKeyValue()
    let store = AnalyticsIdentityStore(group: group, newId: ids())
    let first = store.appContext(appVersion: "2.1.0", ubiquitous: MemoryKeyValue(), earlierInstallVersion: nil)
    let again = store.appContext(appVersion: "2.1.0", ubiquitous: MemoryKeyValue(), earlierInstallVersion: nil)
    XCTAssertFalse(again.created)
    XCTAssertEqual(again.install, first.install)
    XCTAssertNil(again.previousVersion)
  }

  func testASecondDeviceOnTheSameAppleIdIsReturning() {
    let cloud = MemoryKeyValue()
    let phone = AnalyticsIdentityStore(group: MemoryKeyValue(), newId: ids())
      .appContext(appVersion: "2.1.0", ubiquitous: cloud, earlierInstallVersion: nil)
    let mac = AnalyticsIdentityStore(group: MemoryKeyValue(), newId: ids())
      .appContext(appVersion: "2.1.0", ubiquitous: cloud, earlierInstallVersion: nil)
    XCTAssertTrue(mac.returning)
    XCTAssertEqual(mac.install.anchorId, phone.install.anchorId)
    XCTAssertNotEqual(mac.install.installId, phone.install.installId)
  }

  func testAnEarlierInstallIsAnUpdateNotANewInstall() {
    let context = AnalyticsIdentityStore(group: MemoryKeyValue(), newId: ids())
      .appContext(appVersion: "2.1.0", ubiquitous: MemoryKeyValue(), earlierInstallVersion: "2.0.0")
    XCTAssertTrue(context.created)
    XCTAssertEqual(context.previousVersion, "2.0.0")
    XCTAssertFalse(context.returning)
  }

  func testAVersionChangeReportsThePreviousVersionOnce() {
    let store = AnalyticsIdentityStore(group: MemoryKeyValue(), newId: ids())
    _ = store.appContext(appVersion: "2.1.0", ubiquitous: nil, earlierInstallVersion: nil)
    XCTAssertEqual(store.appContext(appVersion: "2.2.0", ubiquitous: nil, earlierInstallVersion: nil).previousVersion, "2.1.0")
    XCTAssertNil(store.appContext(appVersion: "2.2.0", ubiquitous: nil, earlierInstallVersion: nil).previousVersion)
  }

  func testTheExtensionSharesTheAppsRecordAndFollowsItsSwitch() {
    let group = MemoryKeyValue()
    let app = AnalyticsIdentityStore(group: group, newId: ids())
    let context = app.appContext(appVersion: "2.1.0", ubiquitous: MemoryKeyValue(), earlierInstallVersion: nil)
    app.setConsent(false)
    let reply = AnalyticsIdentityStore(group: group, newId: ids()).extensionReply(rawBody: ["kind": "analyticsContext"])
    let analytics = reply?["analytics"] as? [String: Any]
    XCTAssertEqual(analytics?["installId"] as? String, context.install.installId)
    XCTAssertEqual(analytics?["anchorId"] as? String, context.install.anchorId)
    XCTAssertEqual(analytics?["consent"] as? Bool, false)
  }

  func testAnExtensionThatRunsFirstCreatesARecordTheAppAdopts() {
    let group = MemoryKeyValue()
    let fromExtension = AnalyticsIdentityStore(group: group, newId: ids()).extensionInstall()
    XCTAssertEqual(fromExtension.anchorId, fromExtension.installId)
    let context = AnalyticsIdentityStore(group: group, newId: ids())
      .appContext(appVersion: "2.1.0", ubiquitous: MemoryKeyValue(), earlierInstallVersion: nil)
    XCTAssertEqual(context.install, fromExtension)
    XCTAssertFalse(context.created)
  }

  func testUnknownKindsAndCorruptRecordsAreIgnored() {
    let group = MemoryKeyValue()
    group.set("{\"installId\":\"https://x\",\"anchorId\":\"y\"}", forKey: AnalyticsIdentityStore.installKey)
    let store = AnalyticsIdentityStore(group: group, newId: ids())
    XCTAssertNil(store.extensionReply(rawBody: ["kind": "set"]))
    XCTAssertNil(store.storedInstall())
    XCTAssertTrue(AnalyticsIdentityStore.isId(store.extensionInstall().installId))
  }
}
