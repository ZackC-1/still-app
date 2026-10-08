import XCTest
import CryptoKit
@testable import StillKit

final class NativeAccountAccessTests: XCTestCase {
  let f = AppleRightBindingTests()
  func snapshot(_ proofs: [String], removals: [[String: Any]] = [], status: String = "verified", issuer: Int? = nil) throws -> NativeAccountAccessSnapshot {
    let body: [String: Any] = ["access": ["status": status, "environment": "sandbox", "proofs": proofs,
      "revocations": removals, "issuer_time": issuer ?? f.now]]
    return try NativeAccountAccessSnapshot.parse(JSONSerialization.data(withJSONObject: body), trust: f.trust, holder: f.account)
  }
  func testAccountOnlyProofCommitsAndSurvivesSharedStoreReopen() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: dir) }
    let backing = AtomicSettingsBacking(directory: dir, name: "account")
    let store = SharedEntitlementStore(backing: backing, trust: f.trust)
    let session = try f.verifiedSession()
    let generation = try store.prepareAccountAccess(session, expectedGeneration: 0)
    let proof = try f.envelope(f.claims(holder: f.account).canonical())
    let ack = try store.installAccountAccess(snapshot([proof]), session: session, expectedGeneration: generation, wall: f.now)
    XCTAssertEqual(ack.proofIdentities.count, 1)
    let reopened = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: dir, name: "account"), trust: f.trust)
    let record = try reopened.observeAccess(wall: f.now).0
    XCTAssertEqual(record.accountId, f.account); XCTAssertEqual(record.sessionId, f.sessionID)
    XCTAssertEqual(record.rights.count, 1); XCTAssertEqual(record.appleBindings.count, 0)
    XCTAssertEqual(record.rights.first?.clock?.wallAtReceipt, f.now)
  }
  func testGenerationRejectsLogoutAndSameAccountReplacementWithoutWriting() throws {
    let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: f.trust)
    let session = try f.verifiedSession()
    let generation = try store.prepareAccountAccess(session, expectedGeneration: 0)
    let value = try snapshot([f.envelope(f.claims(holder: f.account).canonical())])
    _ = try store.changeAccessSession(accountId: f.account, sessionId: f.right)
    let bytes = backing.read()
    XCTAssertThrowsError(try store.installAccountAccess(value, session: session, expectedGeneration: generation, wall: f.now))
    XCTAssertEqual(backing.read(), bytes)
    _ = try store.changeAccessAccount(nil)
    let out = backing.read()
    XCTAssertThrowsError(try store.prepareAccountAccess(session, expectedGeneration: generation))
    XCTAssertEqual(backing.read(), out)
  }
  func testKnownAccountRemovalPreservesLocalAppleAndRejectsStaleReinstallation() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust)
    let session = try f.verifiedSession()
    let apple = try store.installAppleAccess(f.request(linked: true), nativePurchase: f.native(), session: session, expectedGeneration: 0, wall: f.now)
    let removal: [[String: Any]] = [["right": f.right, "revision": 2]]
    _ = try store.installAccountAccess(snapshot([], removals: removal, status: "none"), session: session, expectedGeneration: apple.generation, wall: f.now)
    XCTAssertEqual(try store.observeAccess(wall: f.now).0.rights.count, 1)
    XCTAssertEqual(try store.observeAppleAccess(wall: f.now).rights.first?.status, "purchased")
    XCTAssertThrowsError(try store.installAccountAccess(snapshot([f.envelope(f.claims(holder: f.account).canonical())]), session: session, expectedGeneration: apple.generation, wall: f.now))
  }
  func testNoListingOrUnknownRemovalDoesNotEraseExistingRights() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust), session = try f.verifiedSession()
    let generation = try store.prepareAccountAccess(session, expectedGeneration: 0)
    _ = try store.installAccountAccess(snapshot([f.envelope(f.claims(holder: f.account).canonical())]), session: session, expectedGeneration: generation, wall: f.now)
    _ = try store.installAccountAccess(snapshot([], removals: [["right": f.account, "revision": 2]], status: "none"), session: session, expectedGeneration: generation, wall: f.now)
    XCTAssertEqual(try store.observeAccess(wall: f.now).0.rights.count, 1)
  }
  func testForgedWrongHolderAndMalformedSnapshotsCannotWrite() throws {
    XCTAssertThrowsError(try snapshot(["unsigned"]))
    XCTAssertThrowsError(try snapshot([f.envelope(f.claims().canonical())]))
    XCTAssertThrowsError(try snapshot([f.envelope(f.claims(holder: f.right).canonical())]))
    XCTAssertThrowsError(try snapshot([], status: "verified"))
    XCTAssertThrowsError(try snapshot([], removals: [["right": f.right, "revision": true]], status: "none"))
    let duplicate = Data("{\"access\":{\"status\":\"none\",\"status\":\"none\",\"environment\":\"sandbox\",\"proofs\":[],\"revocations\":[],\"issuer_time\":1800000000000}}".utf8)
    XCTAssertThrowsError(try NativeAccountAccessSnapshot.parse(duplicate, trust: f.trust, holder: f.account))
  }
  final class Transport: ProductPolicyTransport, @unchecked Sendable {
    var requests: [URLRequest] = []
    let reply: Data
    init(_ reply: Data) { self.reply = reply }
    func send(_ request: URLRequest, maxBytes: Int) async throws -> (status: Int, body: Data) {
      requests.append(request); return (200, reply)
    }
  }
  func testNativeRuntimeUsesOnlyCompiledQARouteAndClosedRequest() async throws {
    let proof = try f.envelope(f.claims(holder: f.account).canonical())
    let reply = try JSONSerialization.data(withJSONObject: ["access": ["status": "verified", "environment": "sandbox", "proofs": [proof], "revocations": [], "issuer_time": f.now]])
    let transport = Transport(reply)
    var info: [String: Any] = ["StillAccessEnvironment": "sandbox", "StillBackendRouteProfile": "shared-hosted-sandbox",
      "StillAccessSupabaseURL": "https://project.example", "StillAccessSupabasePublishableKey": "sb_publishable_synthetic",
      "StillAccessTrustKeys": [["kid": "synthetic-access", "publicKeyHex": f.key.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined(), "environment": "sandbox", "purpose": "access"]]]
    let runtime = try XCTUnwrap(NativeAccountAccessRuntime(info: info, transport: transport))
    let snapshot = try await runtime.fetch(accessToken: f.token(), session: f.verifiedSession())
    XCTAssertEqual(snapshot.proofs.count, 1)
    let request = try XCTUnwrap(transport.requests.first)
    XCTAssertEqual(request.url?.absoluteString, "https://project.example/functions/v1/qa-sandbox-reconcile-entitlement")
    XCTAssertEqual(String(data: request.httpBody!, encoding: .utf8), "{\"access_schema\":1}")
    XCTAssertEqual(request.httpMethod, "POST"); XCTAssertFalse(request.httpShouldHandleCookies)
    info["StillBackendRouteProfile"] = "production"
    XCTAssertNil(NativeAccountAccessRuntime(info: info, transport: transport))
    info.removeValue(forKey: "StillBackendRouteProfile")
    XCTAssertNil(NativeAccountAccessRuntime(info: info, transport: transport))
    XCTAssertEqual(transport.requests.count, 1)
  }
  func testPairedAppleAccountInstallCannotBypassScopedRemoval() throws {
    let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: f.trust)
    let session = try f.verifiedSession()
    let ack = try store.installAppleAccess(f.request(linked: true), nativePurchase: f.native(), session: session, expectedGeneration: 0, wall: f.now)
    _ = try store.installAccountAccess(snapshot([], removals: [["right": f.right, "revision": 2]], status: "none"), session: session, expectedGeneration: ack.generation, wall: f.now)
    let bytes = backing.read()
    XCTAssertThrowsError(try store.installAppleAccess(f.request(linked: true), nativePurchase: f.native(), session: session, expectedGeneration: ack.generation, wall: f.now))
    XCTAssertEqual(backing.read(), bytes)
    XCTAssertEqual(try store.observeAppleAccess(wall: f.now).rights.first?.status, "purchased")
  }
  func testOptionalAccountRevocationGrammarPreservesOldRecordsAndRejectsMalformed() throws {
    let encoder = JSONEncoder(), decoder = JSONDecoder()
    let old = try encoder.encode(AccessCacheRecord())
    XCTAssertEqual(try decoder.decode(AccessCacheRecord.self, from: old).accountRevocations, [])
    let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: old) as? [String: Any])
    for bad: Any in [NSNull(), [["holder": f.account, "right": f.right, "revision": true]], [["holder": f.account, "right": f.right, "revision": 1, "extra": true]], Array(repeating: ["holder": f.account, "right": f.right, "revision": 1] as [String: Any], count: 65)] {
      var record = raw; record["accountRevocations"] = bad
      XCTAssertThrowsError(try decoder.decode(AccessCacheRecord.self, from: JSONSerialization.data(withJSONObject: record)))
    }
  }
  func testSnapshotFailureRollsBackEarlierCanonicalRemoval() throws {
    let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: f.trust), session = try f.verifiedSession()
    let generation = try store.prepareAccountAccess(session, expectedGeneration: 0)
    let good = try f.envelope(f.claims(holder: f.account).canonical())
    let other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    let otherProof = try f.envelope(f.claims(id: other, holder: f.account).canonical())
    _ = try store.installAccountAccess(snapshot([good, otherProof]), session: session, expectedGeneration: generation, wall: f.now)
    let bytes = backing.read()
    // The signed higher revision has an older validation time, so the all-or-nothing upsert fails.
    let backwards = try f.envelope(f.claims(2, at: f.now - 1, holder: f.account).canonical())
    let mutation = try snapshot([backwards], removals: [["right": other, "revision": 2]])
    XCTAssertThrowsError(try store.installAccountAccess(mutation, session: session, expectedGeneration: generation, wall: f.now))
    XCTAssertEqual(backing.read(), bytes)
  }
  func testStaleIssuerAndMixedProofFailuresAreAtomic() throws {
    let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: f.trust), session = try f.verifiedSession()
    let generation = try store.prepareAccountAccess(session, expectedGeneration: 0), bytes = backing.read()
    let proof = try f.envelope(f.claims(holder: f.account).canonical())
    XCTAssertThrowsError(try store.installAccountAccess(snapshot([proof]), session: session, expectedGeneration: generation, wall: f.now + 300001))
    XCTAssertEqual(backing.read(), bytes)
  }
}
