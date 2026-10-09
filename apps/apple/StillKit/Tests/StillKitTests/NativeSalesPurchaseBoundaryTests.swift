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
    let on = await NativeSalesPurchaseBoundary.perform(policy: runtime, unavailable: "held", installEnvironment: { .sandbox }) { charges += 1; return "charged" }
    XCTAssertEqual(on, "charged"); XCTAssertEqual(charges, 1)
    t.enabled = false
    let disabled = await NativeSalesPurchaseBoundary.perform(policy: runtime, unavailable: "held") { charges += 1; return "charged" }
    XCTAssertEqual(disabled, "held"); XCTAssertEqual(charges, 1)
    // The sandbox charge asks the policy again after Apple answers: 1 + 2 + 1.
    XCTAssertEqual(t.requests.count, 4)
    XCTAssertTrue(t.requests.allSatisfy { $0.url?.path == "/functions/v1/qa-sandbox-product-policy" })
  }

  private func runtime(environment: String, route: NativeAccessConfiguration.BackendRouteProfile, transport: Transport, defaults: UserDefaults) -> ProductPolicyRuntime {
    ProductPolicyRuntime(supabaseURL: "https://project.example", context: .init(paidTierEnabled: true, environment: environment, surface: "apple_mobile_host", build: "3.1.0"), routeProfile: route,
      store: .init(defaults: defaults), transport: transport, now: { 1000 }) { _, context, response, highest, now in
      ProductPolicy.evaluateSales(context, response, highestSeenRevision: highest, now: now, compiledPaidTierEnabled: true)
    }
  }

  func testSandboxChargeRequiresVerifiedSandboxOrXcodeInstallationWithNoFallback() async {
    let suite = "NativeSalesPurchaseBoundaryTests." + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let t = Transport(); t.enabled = true
    let sandbox = runtime(environment: "sandbox", route: .sharedHostedSandbox, transport: t, defaults: defaults)
    XCTAssertTrue(sandbox.requiresSandboxInstallation)
    var charges = 0, attestations = 0
    for (environment, expected) in [(AppleInstallEnvironment.sandbox, "charged"), (.xcode, "charged"), (.production, "held"), (.unavailable, "held")] {
      let result = await NativeSalesPurchaseBoundary.perform(policy: sandbox, unavailable: "held", installEnvironment: { attestations += 1; return environment }) {
        charges += 1; return "charged"
      }
      XCTAssertEqual(result, expected, "\(environment)")
    }
    XCTAssertEqual(charges, 2)
    XCTAssertEqual(attestations, 4)
    // A sandbox caller that supplies no attestation is refused, never charged.
    let omitted = await NativeSalesPurchaseBoundary.perform(policy: sandbox, unavailable: "held") { charges += 1; return "charged" }
    XCTAssertEqual(omitted, "held"); XCTAssertEqual(charges, 2)
    // Sales switched Off while Apple was answering holds the charge.
    let switched = await NativeSalesPurchaseBoundary.perform(policy: sandbox, unavailable: "held", installEnvironment: { t.enabled = false; return .sandbox }) {
      charges += 1; return "charged"
    }
    XCTAssertEqual(switched, "held"); XCTAssertEqual(charges, 2)
    // Policy Off holds before Apple is even asked.
    t.enabled = false
    _ = await NativeSalesPurchaseBoundary.perform(policy: sandbox, unavailable: "held", installEnvironment: { attestations += 1; return .sandbox }) { charges += 1; return "charged" }
    XCTAssertEqual(attestations, 4); XCTAssertEqual(charges, 2)
  }

  func testEitherSandboxSignalRequiresSandboxInstallationAndProductionIsUnchanged() {
    let suite = "NativeSalesPurchaseBoundaryTests." + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let t = Transport()
    XCTAssertTrue(runtime(environment: "sandbox", route: .production, transport: t, defaults: defaults).requiresSandboxInstallation)
    XCTAssertTrue(runtime(environment: "production", route: .sharedHostedSandbox, transport: t, defaults: defaults).requiresSandboxInstallation)
    XCTAssertFalse(runtime(environment: "production", route: .production, transport: t, defaults: defaults).requiresSandboxInstallation)
  }

  func testOnlySandboxAndXcodeCannotTakeRealPayment() {
    XCTAssertEqual([AppleInstallEnvironment.production, .sandbox, .xcode, .unavailable].map(\.cannotTakeRealPayment), [false, true, true, false])
  }
}
