import Foundation
import XCTest
@testable import StillKit

/// Rule-level checks for `ProductPolicy` beyond the shared vectors. Unless a test names the
/// internal compiled-switch seam, everything here runs against the shipped switch.
final class ProductPolicyTests: XCTestCase {
  private let build = "3.0.0"
  private let start = 10
  private var handBuiltOn: ProductPolicy.Context {
    ProductPolicy.Context(paidTierEnabled: true, environment: "sandbox", surface: "chrome_desktop", build: build)
  }
  private var clock: () -> Int { { self.start + 10 } }

  private func salesBody(extra: String = "") -> Data {
    Data(("""
    {"schema":1,"environment":"sandbox","revision":3,"salesEnabled":true,\(extra)
     "channels":{"apple":{"enabled":true,"offer":"still-pro-v3"},"web":{"enabled":true,"offer":"still-pro-v3"}},
     "builds":[{"surface":"chrome_desktop","build":"3.0.0"},{"surface":"apple_mobile_host","build":"3.0.0"}]}
    """).utf8)
  }
  private func ratingBody() -> Data {
    let surfaces = ProductPolicy.surfaces.map { "\"\($0)\":true" }.joined(separator: ",")
    return Data("""
    {"schema":1,"environment":"sandbox","revision":7,"master":true,"surfaces":{\(surfaces)},
     "builds":[{"surface":"chrome_desktop","build":"3.0.0"},{"surface":"edge_desktop","build":"3.0.0"}]}
    """.utf8)
  }
  private func fresh(_ body: Data?) -> ProductPolicy.Response {
    ProductPolicy.Response(body: body, requestStartedAt: start)
  }

  // MARK: Two keys (SEC-1)

  func testShippedSwitchIgnoresAHandBuiltContextClaimingPaidOn() {
    XCTAssertFalse(MonetizationConfig.paidTierEnabled)
    for surface in ProductPolicy.surfaces {
      let context = ProductPolicy.Context(paidTierEnabled: true, environment: "sandbox", surface: surface, build: build)
      XCTAssertEqual(ProductPolicy.evaluateSales(context, fresh(salesBody()), highestSeenRevision: 0, now: clock),
                     ProductPolicy.Verdict(.compiledOff), surface)
    }
  }

  func testShippedSwitchKeepsEverySharedSalesVectorOff() throws {
    let sales = try ProductPolicyVectorTests.fixture().cases.filter { $0.namespace == "sales" }
    XCTAssertGreaterThan(sales.count, 100)
    for vector in sales {
      let context = ProductPolicy.Context(paidTierEnabled: true, environment: vector.context.environment,
                                          surface: vector.context.surface, build: vector.context.build)
      let verdict = ProductPolicy.evaluateSales(context, try vector.policyResponse(),
                                                highestSeenRevision: vector.highestSeenRevision, now: { vector.now })
      XCTAssertFalse(verdict.allowed, vector.label)
      XCTAssertTrue([.compiledOff, .context].contains(verdict.reason), vector.label)
    }
  }

  func testSeamStillRequiresTheContextKey() {
    let off = ProductPolicy.Context(paidTierEnabled: false, environment: "sandbox", surface: "chrome_desktop", build: build)
    XCTAssertEqual(ProductPolicy.evaluateSales(off, fresh(salesBody()), highestSeenRevision: 0, now: clock, compiledPaidTierEnabled: true).reason, .compiledOff)
    XCTAssertEqual(ProductPolicy.evaluateSales(handBuiltOn, fresh(salesBody()), highestSeenRevision: 0, now: clock, compiledPaidTierEnabled: true).reason, .on)
  }

  func testPublicContextAlwaysUsesTheCompiledSwitch() {
    let packaged = ProductPolicy.Context(environment: "sandbox", surface: "apple_mobile_host", build: build)
    XCTAssertEqual(packaged.paidTierEnabled, MonetizationConfig.paidTierEnabled)
    XCTAssertEqual(ProductPolicy.evaluateSales(packaged, fresh(salesBody()), highestSeenRevision: 0, now: clock).reason, .compiledOff)
    // Access mode stays compiled: evaluating policy has no path into NativeAccessContext.
    XCTAssertEqual(NativeAccessContext().paidMode, MonetizationConfig.paidTierEnabled)
  }

  func testRemoteSalesMasterIsNamedSalesEnabled() throws {
    XCTAssertEqual(try ProductPolicy.parse(.sales, salesBody()).salesEnabled, true)
    let renamed = Data(String(decoding: salesBody(), as: UTF8.self)
      .replacingOccurrences(of: "\"salesEnabled\":true", with: "\"paidTierEnabled\":true").utf8)
    XCTAssertThrowsError(try ProductPolicy.parse(.sales, renamed))
    XCTAssertThrowsError(try ProductPolicy.parse(.sales, salesBody(extra: "\"paidTierEnabled\":true,")))
  }

  // MARK: Clock (SEC-2)

  func testFreshnessUsesTheInjectedClockOnce() {
    var reads = 0
    let verdict = ProductPolicy.evaluateRating(handBuiltOn, fresh(ratingBody()), highestSeenRevision: 0, now: { reads += 1; return self.start + 4999 })
    XCTAssertEqual(verdict.reason, .on)
    XCTAssertEqual(reads, 1)
    for at in [start + 5000, start - 1, -1, start + 3_600_000] {
      XCTAssertEqual(ProductPolicy.evaluateRating(handBuiltOn, fresh(ratingBody()), highestSeenRevision: 0, now: { at }).reason, .late, "\(at)")
    }
  }

  // MARK: Revision fence (SEC-3)

  func testRevisionFenceRejectsOlderRevisions() {
    XCTAssertEqual(ProductPolicy.evaluateRating(handBuiltOn, fresh(ratingBody()), highestSeenRevision: 8, now: clock),
                   ProductPolicy.Verdict(.stale, revision: 7))
    XCTAssertEqual(ProductPolicy.evaluateRating(handBuiltOn, fresh(ratingBody()), highestSeenRevision: 7, now: clock).reason, .on)
    XCTAssertEqual(ProductPolicy.evaluateRating(handBuiltOn, fresh(ratingBody()), highestSeenRevision: -1, now: clock).reason, .context)
  }

  // MARK: Bytes (SEC-4)

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

  func testByteOrderMarkInvalidUTF8AndLatin1AreInvalid() {
    let json = ratingBody()
    XCTAssertEqual(ProductPolicy.evaluateRating(handBuiltOn, fresh(json), highestSeenRevision: 0, now: clock).reason, .on)
    let marker = Data("\"build\":\"3.0.0".utf8)
    let splice: ([UInt8]) -> Data = { bytes in
      var data = json
      let range = data.range(of: marker)!
      data.insert(contentsOf: bytes, at: range.upperBound)
      return data
    }
    for body in [Data([0xEF, 0xBB, 0xBF]) + json, Data([0xFE, 0xFF]) + json, splice([0xFF]), splice([0xC0, 0xAF]), splice([0xE9]), splice([0xC3, 0xA9])] {
      XCTAssertEqual(ProductPolicy.evaluateRating(handBuiltOn, fresh(body), highestSeenRevision: 0, now: clock).reason, .invalid)
    }
  }

  func testOversizedIsCheckedOnRawBytes() {
    for byte: UInt8 in [0x20, 0xE9] {
      XCTAssertThrowsError(try ProductPolicy.parse(.sales, Data(repeating: byte, count: ProductPolicy.maxBytes + 1))) {
        XCTAssertEqual($0 as? ProductPolicy.GrammarError, .oversized)
      }
    }
  }

  func testRatingIgnoresThePaidFlagAndEdgeIsDeferred() {
    let off = ProductPolicy.Context(paidTierEnabled: false, environment: "sandbox", surface: "chrome_desktop", build: build)
    XCTAssertEqual(ProductPolicy.evaluateRating(off, fresh(ratingBody()), highestSeenRevision: 0, now: clock), ProductPolicy.Verdict(.on, revision: 7))
    let edge = ProductPolicy.Context(paidTierEnabled: true, environment: "sandbox", surface: "edge_desktop", build: build)
    XCTAssertEqual(ProductPolicy.evaluateRating(edge, fresh(ratingBody()), highestSeenRevision: 0, now: clock), ProductPolicy.Verdict(.deferredSurface))
  }

  /// Free blocking, free sync and Restore never consult this policy, and no production source
  /// reaches the evaluator seam. The runtime uses public evaluators; approved rating and sales
  /// consumers may ask fresh questions but cannot parse/evaluate policies or override flags.
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
      if url.lastPathComponent == "ProductPolicyRuntime.swift" && path.contains("/StillKit/Sources/StillKit/") {
        if source.contains("RestrictedJSON") || source.contains("compiledPaidTierEnabled") { users.append(url.lastPathComponent) }
        continue
      }
      // U13-P3: the rating path is the one consumer of the runtime. StillKit's coordinator only
      // reads a fresh `.rating` verdict; the app presenter may do exactly three things: construct
      // the runtime, open the App Group revision store, and ask `freshCheck(.rating)`. Neither may
      // evaluate a policy itself, build a response, reach the parser or the compiled switch, or
      // touch sales.
      let forbidden = ["RestrictedJSON", "compiledPaidTierEnabled", ".sales", "evaluateRating", "evaluateSales",
                       "ProductPolicy.Response", "ProductPolicy.parse", "ProductPolicy.Context"]
      if url.lastPathComponent == "RatingPrompt.swift" && path.contains("/StillKit/Sources/StillKit/") {
        if forbidden.contains(where: source.contains) { users.append(url.lastPathComponent) }
        continue
      }
      if url.lastPathComponent == "RatingPromptPresenter.swift" && path.contains("/Still/Shared (App)/") {
        var rest = source
        for allowed in ["ProductPolicyRuntime(", "ProductPolicyRevisionStore.appGroup()", "freshCheck(.rating)"] {
          rest = rest.replacingOccurrences(of: allowed, with: "")
        }
        if rest.contains("ProductPolicy") || rest.contains("freshCheck(") || forbidden.contains(where: source.contains) {
          users.append(url.lastPathComponent)
        }
        continue
      }
      // V3's native charge boundary asks a fresh sales question. The executor only creates
      // the compiled runtime; neither consumer may parse/evaluate a remote policy or override flags.
      let consumerAllowlist: [String: [String]] = [
        "PurchaseManager.swift": ["ProductPolicyRuntime", "ProductPolicyRevisionStore.appGroup()"],
        "NativeSalesPurchaseBoundary.swift": ["ProductPolicyRuntime", "freshCheck(.sales)"],
        "NativeAccountAccess.swift": ["ProductPolicyTransport", "URLSessionPolicyTransport"],
      ]
      if let allowed = consumerAllowlist[url.lastPathComponent] {
        var rest = source
        for token in allowed.sorted(by: { $0.count > $1.count }) { rest = rest.replacingOccurrences(of: token, with: "") }
        if rest.contains("ProductPolicy") || rest.contains("freshCheck(") || rest.contains(".sales") ||
          rest.contains("compiledPaidTierEnabled") || rest.contains("RestrictedJSON") { users.append(url.lastPathComponent) }
        continue
      }
      if source.contains("ProductPolicy") || source.contains("RestrictedJSON") || source.contains("compiledPaidTierEnabled") {
        users.append(url.lastPathComponent)
      }
    }
    XCTAssertEqual(users, [])
    // Inside ProductPolicy.swift the seam is called exactly once, by the public evaluator.
    let own = try String(contentsOf: apple.appendingPathComponent("StillKit/Sources/StillKit/ProductPolicy.swift"), encoding: .utf8)
    XCTAssertEqual(own.components(separatedBy: "compiledPaidTierEnabled: MonetizationConfig.paidTierEnabled").count - 1, 1)
  }
}
