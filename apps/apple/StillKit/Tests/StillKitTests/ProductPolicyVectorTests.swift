import Foundation
import XCTest
@testable import StillKit

/// Runs the shared U6 product policy vectors (packages/shared-types/fixtures/
/// product-policy-vectors.json) against StillKit's `ProductPolicy`. The same file drives the core
/// vitest runner; both pin the case count so a runner that silently skips vectors cannot pass.
///
/// The fixture is decoded with typed `JSONDecoder` on purpose: `JSONSerialization` bridges through
/// NSString, which silently drops a leading byte-order mark inside a string value and would make
/// the BOM vector test the harness instead of the evaluator.
final class ProductPolicyVectorTests: XCTestCase {
  private static let expectedCases = 117

  private struct Fixture: Decodable {
    let schema: Int
    let cases: [Vector]
  }
  private struct Vector: Decodable {
    struct Context: Decodable { let paidTierEnabled: Bool; let environment: String; let surface: String; let build: String }
    struct Response: Decodable { let body: String?; let padTo: Int?; let requestStartedAt: Int; let evaluatedAt: Int }
    struct Expect: Decodable { let allowed: Bool; let reason: String; let revision: Int? }
    let name: String
    let namespace: String
    let context: Context
    let highestSeenRevision: Int
    let response: Response?
    let expect: Expect
  }

  private func fixture() throws -> Fixture {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let raw = try Data(contentsOf: root.appendingPathComponent("packages/shared-types/fixtures/product-policy-vectors.json"))
    return try JSONDecoder().decode(Fixture.self, from: raw)
  }

  func testEveryVectorGivesTheSharedVerdict() throws {
    let fixture = try fixture()
    XCTAssertEqual(fixture.schema, 1)
    XCTAssertEqual(fixture.cases.count, Self.expectedCases)
    var names = Set<String>()
    var ran = 0
    for vector in fixture.cases {
      let name = "\(vector.namespace): \(vector.name)"
      XCTAssertTrue(names.insert(name).inserted, "duplicate vector \(name)")
      let context = ProductPolicy.Context(paidTierEnabled: vector.context.paidTierEnabled,
        environment: vector.context.environment, surface: vector.context.surface, build: vector.context.build)

      var response: ProductPolicy.Response?
      if let raw = vector.response {
        var body: Data?
        if let text = raw.body {
          var bytes = Data(text.utf8)
          if let target = raw.padTo {
            XCTAssertLessThanOrEqual(bytes.count, target, name)
            bytes.append(Data(repeating: 0x20, count: max(0, target - bytes.count)))
          }
          body = bytes
        }
        response = ProductPolicy.Response(body: body, requestStartedAt: raw.requestStartedAt, evaluatedAt: raw.evaluatedAt)
      }

      let reason = try XCTUnwrap(ProductPolicy.Reason(rawValue: vector.expect.reason), name)
      let verdict: ProductPolicy.Verdict
      switch vector.namespace {
      case "sales": verdict = ProductPolicy.evaluateSales(context, response, highestSeenRevision: vector.highestSeenRevision)
      case "rating": verdict = ProductPolicy.evaluateRating(context, response, highestSeenRevision: vector.highestSeenRevision)
      default: XCTFail("unknown namespace \(name)"); continue
      }
      XCTAssertEqual(verdict.reason, reason, name)
      XCTAssertEqual(verdict.revision, vector.expect.revision, name)
      XCTAssertEqual(verdict.allowed, vector.expect.allowed, name)
      ran += 1
    }
    XCTAssertEqual(ran, Self.expectedCases)
  }
}
