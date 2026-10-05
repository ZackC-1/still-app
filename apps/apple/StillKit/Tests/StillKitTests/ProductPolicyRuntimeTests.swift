import Foundation
import XCTest
@testable import StillKit

/// The dormant Apple product policy client. Synthetic values only; no network.
final class ProductPolicyRuntimeTests: XCTestCase {
  private let build = "3.0.0"
  private let url = "https://project.example/rest/v1/?apikey=never-sent"
  private var suiteName = ""
  private var defaults: UserDefaults!

  override func setUp() {
    suiteName = "ProductPolicyRuntimeTests.\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suiteName)
  }

  override func tearDown() {
    defaults.removePersistentDomain(forName: suiteName)
  }

  private final class Transport: ProductPolicyTransport, @unchecked Sendable {
    var requests: [URLRequest] = []
    let answer: (URLRequest) throws -> (status: Int, body: Data)
    init(_ answer: @escaping (URLRequest) throws -> (status: Int, body: Data)) { self.answer = answer }
    func send(_ request: URLRequest, maxBytes: Int) async throws -> (status: Int, body: Data) {
      requests.append(request)
      return try answer(request)
    }
  }

  private final class Clock: @unchecked Sendable {
    var value = 1000
    func now() -> Int { value }
  }

  private func ratingBody(revision: Int = 5, master: Bool = true, build: String = "3.0.0", environment: String = "production") -> Data {
    let surfaces = ProductPolicy.surfaces.map { "\"\($0)\":true" }.joined(separator: ",")
    return Data(("{\"schema\":1,\"environment\":\"\(environment)\",\"revision\":\(revision),\"master\":\(master)," +
      "\"surfaces\":{\(surfaces)},\"builds\":[{\"surface\":\"apple_mobile_host\",\"build\":\"\(build)\"}]}").utf8)
  }

  private func salesBody(revision: Int = 5, salesEnabled: Bool = true) -> Data {
    Data(("{\"schema\":1,\"environment\":\"production\",\"revision\":\(revision),\"salesEnabled\":\(salesEnabled)," +
      "\"channels\":{\"apple\":{\"enabled\":true,\"offer\":\"still-pro-v3\"},\"web\":{\"enabled\":true,\"offer\":\"still-pro-v3\"}}," +
      "\"builds\":[{\"surface\":\"apple_mobile_host\",\"build\":\"3.0.0\"}]}").utf8)
  }

  private func runtime(_ transport: Transport, clock: Clock = Clock(), supabaseURL: String? = nil,
                       surface: String = "apple_mobile_host") -> ProductPolicyRuntime {
    ProductPolicyRuntime(supabaseURL: supabaseURL ?? url, environment: "production", surface: surface, build: build,
                         store: ProductPolicyRevisionStore(defaults: defaults), transport: transport, now: clock.now)
  }

  /// The sales path with the compiled switch on, through ProductPolicy's internal test seam.
  private func compiledOnRuntime(_ transport: Transport, clock: Clock = Clock()) -> ProductPolicyRuntime {
    let context = ProductPolicy.Context(paidTierEnabled: true, environment: "production", surface: "apple_mobile_host", build: build)
    return ProductPolicyRuntime(supabaseURL: url, context: context, store: ProductPolicyRevisionStore(defaults: defaults),
                                transport: transport, now: clock.now) { namespace, context, response, highestSeen, now in
      namespace == .sales
        ? ProductPolicy.evaluateSales(context, response, highestSeenRevision: highestSeen, now: now, compiledPaidTierEnabled: true)
        : ProductPolicy.evaluateRating(context, response, highestSeenRevision: highestSeen, now: now)
    }
  }

  private var fence: Any? { defaults.object(forKey: ProductPolicyRevisionStore.key(.rating)) }

  // MARK: The request

  func testRequestIsOnePlainIdentityFreePost() async throws {
    let transport = Transport { _ in (200, self.ratingBody()) }
    _ = await runtime(transport).freshCheck(.rating)
    XCTAssertEqual(transport.requests.count, 1)
    let request = try XCTUnwrap(transport.requests.first)
    XCTAssertEqual(request.url?.absoluteString, "https://project.example/functions/v1/product-policy")
    XCTAssertNil(request.url?.query)
    XCTAssertEqual(request.httpMethod, "POST")
    // Exactly one header. A session token, the anon key or any identifier fails here.
    XCTAssertEqual(request.allHTTPHeaderFields, ["Content-Type": "application/json"])
    XCTAssertEqual(request.httpBody, Data("{\"namespace\":\"rating\",\"environment\":\"production\"}".utf8))
    XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
    XCTAssertEqual(request.timeoutInterval, 5)
    XCTAssertFalse(request.httpShouldHandleCookies)
  }

  func testEndpointUsesOnlyTheConfiguredOrigin() {
    XCTAssertEqual(ProductPolicyRuntime.endpoint("https://abc.supabase.co")?.absoluteString, "https://abc.supabase.co/functions/v1/product-policy")
    XCTAssertEqual(ProductPolicyRuntime.endpoint("http://127.0.0.1:54321/x?y=1")?.absoluteString, "http://127.0.0.1:54321/functions/v1/product-policy")
    for bad in [nil, "", "  ", "not a url", "ftp://abc.supabase.co", "https://user:pass@abc.supabase.co"] as [String?] {
      XCTAssertNil(ProductPolicyRuntime.endpoint(bad), String(describing: bad))
    }
  }

  func testUnconfiguredBuildMakesNoRequest() async {
    let transport = Transport { _ in (200, self.ratingBody()) }
    let verdict = await ProductPolicyRuntime(supabaseURL: "", environment: "production", surface: "apple_mobile_host", build: build,
                                             store: ProductPolicyRevisionStore(defaults: defaults), transport: transport).freshCheck(.rating)
    XCTAssertEqual(verdict, ProductPolicy.Verdict(.missing))
    XCTAssertTrue(transport.requests.isEmpty)
  }

  func testProductionTransportKeepsNoCacheCookiesOrCredentials() {
    let configuration = URLSessionPolicyTransport().session.configuration
    XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
    XCTAssertNil(configuration.urlCache)
    XCTAssertNil(configuration.httpCookieStorage)
    XCTAssertFalse(configuration.httpShouldSetCookies)
    XCTAssertNil(configuration.urlCredentialStorage)
    XCTAssertEqual(configuration.timeoutIntervalForRequest, 5)
    XCTAssertEqual(configuration.timeoutIntervalForResource, 5)
  }

  // MARK: Offline or failed is Off

  func testFailuresAreOff() async {
    let answers: [(URLRequest) throws -> (status: Int, body: Data)] = [
      { _ in throw URLError(.notConnectedToInternet) },
      { _ in throw URLError(.timedOut) },
      { _ in (404, Data()) },
      { _ in (503, Data()) },
      { _ in (500, self.ratingBody()) },
      { _ in (200, Data()) },
    ]
    for answer in answers {
      let verdict = await runtime(Transport(answer)).freshCheck(.rating)
      XCTAssertFalse(verdict.allowed)
      XCTAssertNil(fence)
    }
  }

  func testShippedSwitchKeepsSalesOffWithoutARequest() async {
    XCTAssertFalse(MonetizationConfig.paidTierEnabled)
    let transport = Transport { _ in (200, self.salesBody()) }
    do { let verdict = await runtime(transport).freshCheck(.sales); XCTAssertEqual(verdict, ProductPolicy.Verdict(.compiledOff)) }
    XCTAssertTrue(transport.requests.isEmpty)
  }

  func testLateAnswerIsOff() async {
    let clock = Clock()
    let transport = Transport { _ in clock.value += 5000; return (200, self.ratingBody()) }
    do { let verdict = await runtime(transport, clock: clock).freshCheck(.rating); XCTAssertEqual(verdict, ProductPolicy.Verdict(.late)) }
  }

  func testRawBytesAreJudgedExactly() async {
    let bom = Transport { _ in (200, Data([0xef, 0xbb, 0xbf]) + self.ratingBody()) }
    do { let verdict = await runtime(bom).freshCheck(.rating); XCTAssertEqual(verdict.reason, .invalid) }
    let oversized = Transport { _ in (200, self.ratingBody() + Data(repeating: 0x20, count: 9000)) }
    do { let verdict = await runtime(oversized).freshCheck(.rating); XCTAssertEqual(verdict.reason, .oversized) }
  }

  // MARK: Fence

  func testFenceIsRaisedWithMaxOnlyOnAcceptedVerdicts() async {
    var body = ratingBody(revision: 7)
    let transport = Transport { _ in (200, body) }
    let policy = runtime(transport)
    do { let verdict = await policy.freshCheck(.rating); XCTAssertEqual(verdict, ProductPolicy.Verdict(.on, revision: 7)) }
    XCTAssertEqual(fence as? Int, 7)
    body = ratingBody(revision: 6)
    do { let verdict = await policy.freshCheck(.rating); XCTAssertEqual(verdict, ProductPolicy.Verdict(.stale, revision: 6)) }
    XCTAssertEqual(fence as? Int, 7)
    body = Data("{\"schema\":1}".utf8)
    do { let verdict = await policy.freshCheck(.rating); XCTAssertEqual(verdict.reason, .invalid) }
    XCTAssertEqual(fence as? Int, 7)
    body = ratingBody(revision: 12, build: "9.9.9")
    do { let verdict = await policy.freshCheck(.rating); XCTAssertEqual(verdict.reason, .build) }
    XCTAssertEqual(fence as? Int, 12)
    body = ratingBody(revision: 12, master: false)
    do { let verdict = await policy.freshCheck(.rating); XCTAssertEqual(verdict.reason, .off) }
    XCTAssertEqual(fence as? Int, 12)
  }

  func testUnreadableFenceIsOffWithoutARequest() async {
    for bad in ["7", true, 1.5, -1, ["revision": 7]] as [Any] {
      defaults.set(bad, forKey: ProductPolicyRevisionStore.key(.rating))
      let transport = Transport { _ in (200, self.ratingBody()) }
      let verdict = await runtime(transport).freshCheck(.rating)
      XCTAssertFalse(verdict.allowed, String(describing: bad))
      XCTAssertTrue(transport.requests.isEmpty, String(describing: bad))
    }
  }

  // MARK: Nothing from a response is stored, and no cache authorizes

  func testOnlyTheFenceIsStored() async {
    let transport = Transport { _ in (200, self.ratingBody(revision: 8)) }
    _ = await runtime(transport).freshCheck(.rating)
    let stored = defaults.persistentDomain(forName: suiteName) ?? [:]
    XCTAssertEqual(Set(stored.keys), [ProductPolicyRevisionStore.key(.rating)])
    XCTAssertEqual(stored[ProductPolicyRevisionStore.key(.rating)] as? Int, 8)
    XCTAssertFalse(stored.values.contains { $0 is Data || $0 is String })
  }

  func testCompiledOnSalesNeedsAFreshOnAndIgnoresAnyStoredState() async {
    var answer: (URLRequest) throws -> (status: Int, body: Data) = { _ in (200, self.salesBody(revision: 4)) }
    let transport = Transport { try answer($0) }
    let policy = compiledOnRuntime(transport)
    do { let verdict = await policy.freshCheck(.sales); XCTAssertEqual(verdict, ProductPolicy.Verdict(.on, revision: 4)) }
    XCTAssertEqual(defaults.object(forKey: ProductPolicyRevisionStore.key(.sales)) as? Int, 4)
    // The previous On is remembered nowhere that could authorize: offline is Off.
    answer = { _ in throw URLError(.notConnectedToInternet) }
    do { let verdict = await policy.freshCheck(.sales); XCTAssertEqual(verdict, ProductPolicy.Verdict(.missing)) }
    // A replayed older On is stale.
    answer = { _ in (200, self.salesBody(revision: 3)) }
    do { let verdict = await policy.freshCheck(.sales); XCTAssertEqual(verdict, ProductPolicy.Verdict(.stale, revision: 3)) }
    answer = { _ in (200, self.salesBody(revision: 5, salesEnabled: false)) }
    do { let verdict = await policy.freshCheck(.sales); XCTAssertEqual(verdict, ProductPolicy.Verdict(.off, revision: 5)) }
  }

  // MARK: Dormant, unscheduled, never on Restore

  private func source(_ relative: String) throws -> String {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<3 { root.deleteLastPathComponent() }
    return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
  }

  func testRuntimeSchedulesNothingAndReadsNoIdentity() throws {
    let code = try source("Sources/StillKit/ProductPolicyRuntime.swift")
      .split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
    for forbidden in ["Timer", "asyncAfter", "BGTask", "UNUserNotification", "Authorization", "apikey", "InstallGeneration",
                      "AnalyticsIdentity", "accessToken", "session.auth", "Purchases", "EntitlementBridge", "compiledPaidTierEnabled"] {
      XCTAssertFalse(code.contains(forbidden), forbidden)
    }
  }

  func testRestoreNeverConsultsPolicy() throws {
    for file in ["FreePeriodRestore.swift", "PurchaseDecision.swift", "EntitlementBridge.swift", "AccessProof.swift"] {
      XCTAssertFalse(try source("Sources/StillKit/\(file)").contains("ProductPolicy"), file)
    }
  }
}
