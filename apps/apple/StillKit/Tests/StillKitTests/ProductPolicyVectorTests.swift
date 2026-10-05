import Foundation
import XCTest
@testable import StillKit

/// Runs the shared U6 product policy vectors (packages/shared-types/fixtures/
/// product-policy-vectors.json) against StillKit's `ProductPolicy`. The same file drives the core
/// vitest runner; both pin the case count so a runner that silently skips vectors cannot pass.
/// Sales runs through the internal compiled-switch seam (reachable only via `@testable`), so the
/// vectors exercise the whole sales path; `ProductPolicyTests` checks the shipped switch keeps
/// every sales vector Off through the public API.
///
/// The fixture is decoded with typed `JSONDecoder` on purpose: `JSONSerialization` bridges through
/// NSString, which silently drops a leading byte-order mark inside a string value and would make
/// the BOM vector test the harness instead of the evaluator.
final class ProductPolicyVectorTests: XCTestCase {
  static let expectedCases = 136

  struct Fixture: Decodable {
    let schema: Int
    let cases: [Vector]
  }
  struct Vector: Decodable {
    struct Context: Decodable { let paidTierEnabled: Bool; let environment: String; let surface: String; let build: String }
    struct Response: Decodable { let body: String?; let bodyHex: String?; let padTo: Int?; let requestStartedAt: Int }
    struct Expect: Decodable { let allowed: Bool; let reason: String; let revision: Int? }
    let name: String
    let namespace: String
    let context: Context
    let highestSeenRevision: Int
    let now: Int
    let response: Response?
    let expect: Expect

    var label: String { "\(namespace): \(name)" }
    var policyContext: ProductPolicy.Context {
      ProductPolicy.Context(paidTierEnabled: context.paidTierEnabled, environment: context.environment,
                            surface: context.surface, build: context.build)
    }
    func policyResponse() throws -> ProductPolicy.Response? {
      guard let response else { return nil }
      var body: Data?
      if let hex = response.bodyHex {
        guard response.body == nil, hex.count % 2 == 0 else { throw CocoaError(.coderInvalidValue) }
        var bytes = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
          let next = hex.index(index, offsetBy: 2)
          guard let byte = UInt8(hex[index..<next], radix: 16) else { throw CocoaError(.coderInvalidValue) }
          bytes.append(byte)
          index = next
        }
        body = bytes
      } else if let text = response.body {
        body = Data(text.utf8)
      }
      if let target = response.padTo, var bytes = body {
        guard bytes.count <= target else { throw CocoaError(.coderInvalidValue) }
        bytes.append(Data(repeating: 0x20, count: target - bytes.count))
        body = bytes
      }
      return ProductPolicy.Response(body: body, requestStartedAt: response.requestStartedAt)
    }
  }

  static func fixture() throws -> Fixture {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let raw = try Data(contentsOf: root.appendingPathComponent("packages/shared-types/fixtures/product-policy-vectors.json"))
    return try JSONDecoder().decode(Fixture.self, from: raw)
  }

  func testEveryVectorGivesTheSharedVerdict() throws {
    let fixture = try Self.fixture()
    XCTAssertEqual(fixture.schema, 1)
    XCTAssertEqual(fixture.cases.count, Self.expectedCases)
    var names = Set<String>()
    var ran = 0
    for vector in fixture.cases {
      let name = vector.label
      XCTAssertTrue(names.insert(name).inserted, "duplicate vector \(name)")
      let response = try vector.policyResponse()
      let reason = try XCTUnwrap(ProductPolicy.Reason(rawValue: vector.expect.reason), name)
      var clockReads = 0
      let now: () -> Int = { clockReads += 1; return vector.now }
      let verdict: ProductPolicy.Verdict
      switch vector.namespace {
      case "sales":
        verdict = ProductPolicy.evaluateSales(vector.policyContext, response, highestSeenRevision: vector.highestSeenRevision,
                                              now: now, compiledPaidTierEnabled: true)
      case "rating":
        verdict = ProductPolicy.evaluateRating(vector.policyContext, response, highestSeenRevision: vector.highestSeenRevision, now: now)
      default: XCTFail("unknown namespace \(name)"); continue
      }
      XCTAssertEqual(verdict.reason, reason, name)
      XCTAssertEqual(verdict.revision, vector.expect.revision, name)
      XCTAssertEqual(verdict.allowed, vector.expect.allowed, name)
      XCTAssertLessThanOrEqual(clockReads, 1, name)
      ran += 1
    }
    XCTAssertEqual(ran, Self.expectedCases)
  }
}
