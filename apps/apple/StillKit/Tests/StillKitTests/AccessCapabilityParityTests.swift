import Foundation
import XCTest
@testable import StillKit

/// TS/Swift parity for the Still Pro dormancy gate (owner decision 6). The shared fixture
/// packages/shared-types/fixtures/access-capabilities.json is the packaged capability set while the
/// paid tier is off; packages/core's `accessCapabilities` test reads the same file. StillKit's
/// default supported set must equal it exactly and stay free-only, so no Still Pro feature can
/// resolve to an effective state from the native host while paid is off.
final class AccessCapabilityParityTests: XCTestCase {
  struct Fixture: Decodable {
    let schema: Int
    let paidOffSupported: [String]
    let paidOnSafariSupported: [String]
  }

  static func fixture() throws -> Fixture {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let raw = try Data(contentsOf: root.appendingPathComponent("packages/shared-types/fixtures/access-capabilities.json"))
    return try JSONDecoder().decode(Fixture.self, from: raw)
  }

  func testDefaultSupportedSetEqualsTheSharedPaidOffSet() throws {
    let fixture = try Self.fixture()
    XCTAssertEqual(fixture.schema, 1)
    XCTAssertFalse(MonetizationConfig.paidTierEnabled)
    let expected = Set(fixture.paidOffSupported)
    XCTAssertEqual(expected.count, fixture.paidOffSupported.count)
    XCTAssertEqual(NativeAccessContext().supported, expected)
    XCTAssertEqual(NativeAccessContext(paidMode: false).supported, expected)
    // The default stays free-only even in paid mode: a host must supply implemented Pro features.
    XCTAssertEqual(NativeAccessContext(paidMode: true).supported, expected)
    let free = PackagedFeatureRegistry.features.filter { $0.tier == "free" }.map(\.id) + [PackagedFeatureRegistry.tiktokAlias]
    XCTAssertEqual(Set(free), expected)
  }

  func testNativeSafariPaidOnSetMatchesTheSharedTypeScriptFixture() throws {
    let fixture = try Self.fixture()
    XCTAssertEqual(Set(fixture.paidOnSafariSupported).count, fixture.paidOnSafariSupported.count)
    XCTAssertEqual(NativeAppleAccessCapabilities.supported(paidMode: true), Set(fixture.paidOnSafariSupported))
    XCTAssertEqual(NativeAppleAccessCapabilities.supported(paidMode: false), Set(fixture.paidOffSupported))
  }

  func testEveryProFeatureResolvesUnsupportedFromTheDefaultContext() {
    let pro = PackagedFeatureRegistry.features.filter { $0.tier == "pro" }.map(\.id)
    XCTAssertEqual(pro.count, 12)
    let snapshot = resolveAccessSnapshot(AccessCacheRecord(), evidence: [], context: NativeAccessContext())
    for id in pro { XCTAssertEqual(snapshot.states[id], "unsupported", id) }
    for id in PackagedFeatureRegistry.features.filter({ $0.tier == "free" }).map(\.id) + [PackagedFeatureRegistry.tiktokAlias] {
      XCTAssertEqual(snapshot.states[id], "free", id)
    }
    XCTAssertNil(snapshot.refreshAfterMs)
    XCTAssertEqual(snapshot.independentProtection, [])
  }
}
