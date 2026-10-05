import Foundation
import XCTest
@testable import StillKit

/// Rule-level checks for `ProductPolicy` beyond the shared vectors.
final class ProductPolicyTests: XCTestCase {
  private let build = "3.0.0"
  private var compiledOn: ProductPolicy.Context {
    ProductPolicy.Context(paidTierEnabled: true, environment: "sandbox", surface: "chrome_desktop", build: build)
  }

  private func salesBody(paid: Bool = true, extra: String = "") -> Data {
    Data(("""
    {"schema":1,"environment":"sandbox","revision":3,"paidTierEnabled":\(paid),\(extra)
     "channels":{"apple":{"enabled":true,"offer":"still-pro-v3"},"web":{"enabled":true,"offer":"still-pro-v3"}},
     "builds":[{"surface":"chrome_desktop","build":"3.0.0"},{"surface":"apple_mobile_host","build":"3.0.0"}]}
    """).utf8)
  }
  private func fresh(_ body: Data?) -> ProductPolicy.Response {
    ProductPolicy.Response(body: body, requestStartedAt: 10, evaluatedAt: 20)
  }

  func testCompiledOffKeepsEveryRemoteSalesValueInert() {
    XCTAssertEqual(ProductPolicy.evaluateSales(compiledOn, fresh(salesBody())).reason, .on)
    for surface in ProductPolicy.surfaces {
      let off = ProductPolicy.Context(paidTierEnabled: false, environment: "sandbox", surface: surface, build: build)
      for body in [salesBody(), salesBody(paid: true, extra: "\"paidMode\":true,"), Data("{".utf8), nil] {
        let verdict = ProductPolicy.evaluateSales(off, fresh(body))
        XCTAssertFalse(verdict.allowed)
        XCTAssertEqual(verdict.reason, .compiledOff)
      }
    }
  }

  func testPackagedDefaultIsTheCompiledSwitch() {
    XCTAssertFalse(MonetizationConfig.paidTierEnabled)
    let packaged = ProductPolicy.Context(environment: "sandbox", surface: "apple_mobile_host", build: build)
    XCTAssertEqual(packaged.paidTierEnabled, MonetizationConfig.paidTierEnabled)
    XCTAssertEqual(ProductPolicy.evaluateSales(packaged, fresh(salesBody())).reason, .compiledOff)
    // Access mode stays compiled: evaluating policy has no path into NativeAccessContext.
    XCTAssertEqual(NativeAccessContext().paidMode, MonetizationConfig.paidTierEnabled)
  }

  func testUnknownKeysAreRejectedAtEveryLevel() {
    let bodies = [
      salesBody(extra: "\"note\":1,"),
      Data(String(decoding: salesBody(), as: UTF8.self).replacingOccurrences(of: "\"offer\":\"still-pro-v3\"}", with: "\"offer\":\"still-pro-v3\",\"price\":1}").utf8),
      Data(String(decoding: salesBody(), as: UTF8.self).replacingOccurrences(of: "\"build\":\"3.0.0\"}", with: "\"build\":\"3.0.0\",\"url\":\"x\"}").utf8),
    ]
    for body in bodies {
      XCTAssertThrowsError(try ProductPolicy.parse(.sales, body)) { XCTAssertEqual($0 as? ProductPolicy.GrammarError, .invalid) }
    }
    XCTAssertNoThrow(try ProductPolicy.parse(.sales, salesBody()))
  }

  func testOversizedIsDistinctFromInvalid() {
    XCTAssertThrowsError(try ProductPolicy.parse(.sales, Data(repeating: 0x20, count: ProductPolicy.maxBytes + 1))) {
      XCTAssertEqual($0 as? ProductPolicy.GrammarError, .oversized)
    }
  }

  func testRatingIgnoresTheCompiledPaidFlagAndEdgeIsDeferred() {
    let surfaces = ProductPolicy.surfaces.map { "\"\($0)\":true" }.joined(separator: ",")
    let body = Data("""
    {"schema":1,"environment":"sandbox","revision":7,"master":true,"surfaces":{\(surfaces)},
     "builds":[{"surface":"chrome_desktop","build":"3.0.0"},{"surface":"edge_desktop","build":"3.0.0"}]}
    """.utf8)
    let off = ProductPolicy.Context(paidTierEnabled: false, environment: "sandbox", surface: "chrome_desktop", build: build)
    XCTAssertEqual(ProductPolicy.evaluateRating(off, fresh(body)), ProductPolicy.Verdict(.on, revision: 7))
    let edge = ProductPolicy.Context(paidTierEnabled: true, environment: "sandbox", surface: "edge_desktop", build: build)
    XCTAssertEqual(ProductPolicy.evaluateRating(edge, fresh(body)), ProductPolicy.Verdict(.deferredSurface))
  }

  /// Dormant: nothing in StillKit or the app targets consults this policy yet, so free blocking,
  /// free sync and Restore cannot depend on it.
  func testNoProductionSwiftUsesProductPolicy() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let apple = root.appendingPathComponent("apps/apple")
    let enumerator = try XCTUnwrap(FileManager.default.enumerator(at: apple, includingPropertiesForKeys: nil))
    var users: [String] = []
    for case let url as URL in enumerator where url.pathExtension == "swift" {
      let path = url.path
      if path.contains("/Tests/") || path.contains("/.build/") || url.lastPathComponent == "ProductPolicy.swift" { continue }
      let source = try String(contentsOf: url, encoding: .utf8)
      if source.contains("ProductPolicy") || source.contains("RestrictedJSON") { users.append(url.lastPathComponent) }
    }
    XCTAssertEqual(users, [])
  }
}
