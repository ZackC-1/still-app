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
    let paidOnSafariDesktopSupported: [String]
    let paidOnSafariMobileSupported: [String]
  }

  static func fixture() throws -> Fixture {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let raw = try Data(contentsOf: root.appendingPathComponent("packages/shared-types/fixtures/access-capabilities.json"))
    return try JSONDecoder().decode(Fixture.self, from: raw)
  }

  func testDefaultSupportedSetFollowsTheShippedPaidSwitch() throws {
    let fixture = try Self.fixture()
    XCTAssertEqual(fixture.schema, 1)
    XCTAssertTrue(MonetizationConfig.paidTierEnabled)
    let expected = Set(fixture.paidOffSupported)
    XCTAssertEqual(expected.count, fixture.paidOffSupported.count)
    // Shipped paid on: the default context holds the free features plus this platform's extras.
    XCTAssertEqual(NativeAccessContext().supported, NativeAppleAccessCapabilities.supported(paidMode: true))
    XCTAssertTrue(expected.isSubset(of: NativeAccessContext().supported))
    // Paid off: exactly the shared free set.
    XCTAssertEqual(NativeAppleAccessCapabilities.supported(paidMode: false), expected)
    let free = PackagedFeatureRegistry.features.filter { $0.tier == "free" }.map(\.id) + [PackagedFeatureRegistry.tiktokAlias]
    XCTAssertEqual(Set(free), expected)
  }

  func testNativeSafariPaidOnSetsMatchTheSharedTypeScriptFixturePerPlatform() throws {
    let fixture = try Self.fixture()
    XCTAssertEqual(Set(fixture.paidOnSafariDesktopSupported).count, fixture.paidOnSafariDesktopSupported.count)
    XCTAssertEqual(Set(fixture.paidOnSafariMobileSupported).count, fixture.paidOnSafariMobileSupported.count)
    XCTAssertEqual(NativeAppleAccessCapabilities.supported(paidMode: true, platform: .mac), Set(fixture.paidOnSafariDesktopSupported))
    XCTAssertEqual(NativeAppleAccessCapabilities.supported(paidMode: true, platform: .mobile), Set(fixture.paidOnSafariMobileSupported))
    for platform in [SafariAccessPlatform.mac, .mobile] {
      XCTAssertEqual(NativeAppleAccessCapabilities.supported(paidMode: false, platform: platform), Set(fixture.paidOffSupported))
    }
    // The compiled platform is the build's own operating system, never a runtime guess.
    #if os(macOS)
    XCTAssertEqual(SafariAccessPlatform.current, .mac)
    #else
    XCTAssertEqual(SafariAccessPlatform.current, .mobile)
    #endif
    XCTAssertEqual(NativeAppleAccessCapabilities.supported(paidMode: true),
                   NativeAppleAccessCapabilities.supported(paidMode: true, platform: .current))
    // The mobile set is the desktop set minus exactly the desktop-layout-only extras.
    XCTAssertEqual(Set(fixture.paidOnSafariDesktopSupported).subtracting(fixture.paidOnSafariMobileSupported),
                   ["youtube.endscreen", "youtube.livechat", "facebook.sponsored"])
  }

  func testEveryProFeatureResolvesUnsupportedFromAPaidOffContext() {
    let pro = PackagedFeatureRegistry.features.filter { $0.tier == "pro" }.map(\.id)
    XCTAssertEqual(pro.count, 12)
    let paidOff = NativeAccessContext(paidMode: false, supported: NativeAppleAccessCapabilities.supported(paidMode: false))
    let snapshot = resolveAccessSnapshot(AccessCacheRecord(), evidence: [], context: paidOff)
    for id in pro { XCTAssertEqual(snapshot.states[id], "unsupported", id) }
    for id in PackagedFeatureRegistry.features.filter({ $0.tier == "free" }).map(\.id) + [PackagedFeatureRegistry.tiktokAlias] {
      XCTAssertEqual(snapshot.states[id], "free", id)
    }
    XCTAssertNil(snapshot.refreshAfterMs)
    XCTAssertEqual(snapshot.independentProtection, [])
  }
}
