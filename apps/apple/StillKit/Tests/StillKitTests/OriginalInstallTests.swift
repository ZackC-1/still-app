import Foundation
import XCTest
@testable import StillKit

final class OriginalInstallTests: XCTestCase {
  private func freshDefaults(_ name: String) -> UserDefaults {
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return defaults
  }

  func testRecordsVersionAndPurchaseDateOnce() {
    let defaults = freshDefaults("still.originalInstall.tests.once")
    let first = OriginalInstallRecord(
      applicationVersion: "2.0.0",
      originalPurchaseDate: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let later = OriginalInstallRecord(
      applicationVersion: "3.0.0",
      originalPurchaseDate: Date(timeIntervalSince1970: 1_800_000_000)
    )

    XCTAssertEqual(OriginalInstall.recordIfAbsent(first, defaults: defaults), first)
    XCTAssertEqual(OriginalInstall.recordIfAbsent(later, defaults: defaults), first)
    XCTAssertEqual(OriginalInstall.current(defaults), first)
  }

  func testMalformedStoredValueReadsAsAbsent() {
    let defaults = freshDefaults("still.originalInstall.tests.malformed")
    defaults.set(Data("not-json".utf8), forKey: OriginalInstall.storageKey)

    XCTAssertNil(OriginalInstall.current(defaults))
  }
}
