import XCTest
@testable import StillKit
final class NativeSalesPurchaseBoundaryTests: XCTestCase {
  final class Transport: ProductPolicyTransport, @unchecked Sendable {
    var requests: [URLRequest] = []
    var enabled = false
    func send(_ request: URLRequest, maxBytes: Int) async throws -> (status: Int, body: Data) {
      requests.append(request)
      return (200, Data(("{\"schema\":1,\"environment\":\"sandbox\",\"revision\":1,\"salesEnabled\":\(enabled),\"channels\":{\"apple\":{\"enabled\":true,\"offer\":\"still-pro-v3\"},\"web\":{\"enabled\":true,\"offer\":\"still-pro-v3\"}},\"builds\":[{\"surface\":\"apple_mobile_host\",\"build\":\"3.1.0\"}]}").utf8))
    }
  }
  func testEveryActualChargeRequiresFreshMatchingSalesPolicyAndUnknownHolds() async {
    var charges = 0
    let missing = await NativeSalesPurchaseBoundary.perform(policy: nil, unavailable: "held") { charges += 1; return "charged" }
    XCTAssertEqual(missing, "held")
    XCTAssertEqual(charges, 0)
    let suite = "NativeSalesPurchaseBoundaryTests." + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let t = Transport()
    let runtime = ProductPolicyRuntime(supabaseURL: "https://project.example", context: .init(paidTierEnabled: true, environment: "sandbox", surface: "apple_mobile_host", build: "3.1.0"), routeProfile: .sharedHostedSandbox,
      store: .init(defaults: defaults), transport: t, now: { 1000 }) { namespace, context, response, highest, now in
      ProductPolicy.evaluateSales(context, response, highestSeenRevision: highest, now: now, compiledPaidTierEnabled: true)
    }
    let off = await NativeSalesPurchaseBoundary.perform(policy: runtime, unavailable: "held") { charges += 1; return "charged" }
    XCTAssertEqual(off, "held"); XCTAssertEqual(charges, 0)
    t.enabled = true
    let on = await NativeSalesPurchaseBoundary.perform(policy: runtime, unavailable: "held") { charges += 1; return "charged" }
    XCTAssertEqual(on, "charged"); XCTAssertEqual(charges, 1)
    t.enabled = false
    let disabled = await NativeSalesPurchaseBoundary.perform(policy: runtime, unavailable: "held") { charges += 1; return "charged" }
    XCTAssertEqual(disabled, "held"); XCTAssertEqual(charges, 1)
    XCTAssertEqual(t.requests.count, 3)
    XCTAssertTrue(t.requests.allSatisfy { $0.url?.path == "/functions/v1/qa-sandbox-product-policy" })
  }
}
