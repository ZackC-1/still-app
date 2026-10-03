import XCTest
@testable import StillKit

@available(macOS 10.15, *)
final class AccessProofTests: XCTestCase {
  private struct Fixtures: Decodable {
    struct Vector: Decodable { let name: String; let envelope: String; let status: String }
    let publicKeyHex: String; let account: String; let localRight: String
    let verifiedAt: Int; let expiresAt: Int; let protectedProduct: String; let protectedBenefits: [String]
    let vectors: [Vector]
  }
  private func fixtures() throws -> Fixtures {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    return try JSONDecoder().decode(Fixtures.self, from: Data(contentsOf: root.appendingPathComponent("tests/access-proof/vectors.json")))
  }
  private func trust(_ f: Fixtures) -> AccessTrust {
    let bytes = stride(from: 0, to: f.publicKeyHex.count, by: 2).map { offset -> UInt8 in
      let start = f.publicKeyHex.index(f.publicKeyHex.startIndex, offsetBy: offset)
      return UInt8(f.publicKeyHex[start..<f.publicKeyHex.index(start, offsetBy: 2)], radix: 16)!
    }
    return AccessTrust(environment: "sandbox", keys: [.init(kid: "synthetic-access", publicKey: Data(bytes), environment: "sandbox")],
      protectedProduct: f.protectedProduct, protectedBenefits: f.protectedBenefits)
  }
  private func proof(_ f: Fixtures, _ name: String = "paid-account") throws -> VerifiedAccessProof {
    try VerifiedAccessProof.verify(XCTUnwrap(f.vectors.first { $0.name == name }).envelope, trust: trust(f))
  }
  func testAllSharedCanonicalCryptographicVectors() throws {
    let f = try fixtures()
    XCTAssertEqual(f.vectors.count, 32)
    for vector in f.vectors {
      var status = "verified"
      do { _ = try VerifiedAccessProof.verify(vector.envelope, trust: trust(f)) }
      catch AccessProofFailure.unsupported { status = "unsupported" }
      catch AccessProofFailure.verificationRequired { status = "verification_required" }
      catch { status = "invalid" }
      XCTAssertEqual(status, vector.status, vector.name)
    }
  }
  func testDeadlineBoundaryAndPersistedClockRollback() throws {
    let f = try fixtures(), p = try proof(f)
    let baseline = try PaidAccessClock.install(p, issuerNow: f.verifiedAt, wall: 1000)
    for delta in [-1, 0, 1] {
      var clock = baseline
      XCTAssertEqual(clock.observe(p, wall: 1000 + f.expiresAt - f.verifiedAt + delta), delta < 0)
      XCTAssertEqual(clock.expired, delta >= 0)
    }
    var rollback = baseline
    XCTAssertTrue(rollback.observe(p, wall: 2000))
    XCTAssertFalse(rollback.observe(p, wall: 1500))
    XCTAssertTrue(rollback.paused)
    XCTAssertFalse(rollback.observe(p, wall: 3000))
    var expired = baseline
    XCTAssertFalse(expired.observe(p, wall: 1000 + f.expiresAt - f.verifiedAt))
    XCTAssertFalse(expired.observe(p, wall: 1000))
    XCTAssertTrue(expired.expired)
    var unsafe = baseline
    XCTAssertFalse(unsafe.observe(p, wall: 9_007_199_254_740_991))
    XCTAssertTrue(unsafe.paused)
    XCTAssertFalse(unsafe.observe(p, wall: 1001))
  }
  func testOrdinaryRestartSleepAndSameRuntimeLowerBound() throws {
    let f = try fixtures(), p = try proof(f)
    let first = try PaidAccessClock.install(p, issuerNow: f.verifiedAt, wall: 1000)
    var restarted = try JSONDecoder().decode(PaidAccessClock.self, from: JSONEncoder().encode(first))
    XCTAssertTrue(restarted.observe(p, wall: 11_000, runningEstimate: f.verifiedAt))
    XCTAssertEqual(restarted.highWater, f.verifiedAt + 10_000)
    XCTAssertTrue(restarted.observe(p, wall: 21_000))
    XCTAssertEqual(restarted.wallAtReceipt, 1000)
    XCTAssertEqual(restarted.expiresAt, f.expiresAt)
    var continuous = first
    XCTAssertTrue(continuous.observe(p, wall: 1000, runningEstimate: f.verifiedAt + 2000))
    XCTAssertEqual(continuous.highWater, f.verifiedAt + 2000)
  }
  func testRealAtomicStorePreservesBoundsRevocationAndLegacyReceiptStamp() throws {
    let f = try fixtures(), p = try proof(f)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let a = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "entitlement"), trust: trust(f))
    let b = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "entitlement"), trust: trust(f))
    let scope = try a.changeAccessAccount(f.account)
    _ = try a.installAccess(p, generation: scope.generation, issuerNow: f.verifiedAt, wall: 1000, localRights: [])
    _ = try b.observeAccess(wall: 4000)
    _ = try a.revokeAccess(right: p.claims.right, revision: 1, generation: scope.generation)
    b.save(EntitlementRecord(entitled: true, updatedAt: 5000, source: .receipt))
    let result = try a.observeAccess(wall: 4000)
    XCTAssertEqual(result.0.rights.first?.clock?.highWater, f.verifiedAt + 3000)
    XCTAssertEqual(result.0.revocations.count, 1)
    XCTAssertTrue(result.1.first?.revoked == true)
    XCTAssertEqual(a.peek()?.source, .receipt)
    XCTAssertThrowsError(try b.installAccess(p, generation: scope.generation, issuerNow: f.verifiedAt, wall: 10_000, localRights: []))
  }
  func testSameProofRetryDoesNotRenewOrRemoveExpiry() throws {
    let f = try fixtures(), p = try proof(f)
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust(f))
    let scope = try store.changeAccessAccount(f.account)
    _ = try store.installAccess(p, generation: scope.generation, issuerNow: f.verifiedAt, wall: 1000, localRights: [])
    let expired = try store.observeAccess(wall: 1000 + f.expiresAt - f.verifiedAt).0
    let retried = try store.installAccess(p, generation: scope.generation, issuerNow: f.verifiedAt + 10, wall: 9000, localRights: [])
    XCTAssertEqual(retried.rights.first?.clock, expired.rights.first?.clock)
  }
  func testAuthoritativeReplacementRepairsForwardJumpWithoutAcceptingOldProof() throws {
    let f = try fixtures(), old = try proof(f), fresh = try proof(f, "paid-new-validation")
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust(f))
    let scope = try store.changeAccessAccount(f.account)
    _ = try store.installAccess(old, generation: scope.generation, issuerNow: f.verifiedAt, wall: 1000, localRights: [])
    _ = try store.observeAccess(wall: 1000 + f.expiresAt - f.verifiedAt)
    _ = try store.installAccess(fresh, generation: scope.generation, issuerNow: f.verifiedAt + 1000, wall: 9000, localRights: [])
    XCTAssertTrue(try store.observeAccess(wall: 9001).1.first?.validPaid == true)
    XCTAssertThrowsError(try store.installAccess(old, generation: scope.generation, issuerNow: f.verifiedAt, wall: 1000, localRights: []))
  }
  func testAccountLifecycleFencesDelayedAProofAndPreservesIndependentLocalRight() throws {
    let f = try fixtures(), p = try proof(f), local = try proof(f, "protected-local")
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust(f))
    let original = try store.changeAccessAccount(f.account)
    _ = try store.installAccess(local, generation: original.generation, issuerNow: f.verifiedAt, wall: 1000, localRights: [f.localRight])
    for account in [nil, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", nil, f.account] { _ = try store.changeAccessAccount(account) }
    XCTAssertThrowsError(try store.installAccess(p, generation: original.generation, issuerNow: f.verifiedAt, wall: 1000, localRights: []))
    let observed = try store.observeAccess(wall: 1000)
    XCTAssertEqual(observed.0.rights.count, 1)
    XCTAssertEqual(resolveBenefitAccess("youtube.comments", evidence: observed.1, paidMode: true, supported: true,
      free: false, accountId: f.account, localRights: [f.localRight], evidenceStatus: "unknown"), .protected)
  }
  func testIndependentProtectionSurvivesInvalidOtherRightAndMissingCoordinationHolds() throws {
    let f = try fixtures(), local = try proof(f, "protected-local")
    let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: trust(f))
    _ = try store.installAccess(local, generation: 0, issuerNow: f.verifiedAt, wall: 1000, localRights: [f.localRight])
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(backing.read())) as? [String: Any])
    var access = try XCTUnwrap(object["access"] as? [String: Any]); var rights = try XCTUnwrap(access["rights"] as? [[String: Any]])
    rights.append(["envelope": "unreadable", "clock": NSNull()]); access["rights"] = rights; object["access"] = access
    backing.write(try JSONSerialization.data(withJSONObject: object))
    let observed = try store.observeAccess(wall: 1000)
    XCTAssertEqual(observed.0.rights.count, 2)
    XCTAssertEqual(resolveBenefitAccess("youtube.comments", evidence: observed.1, paidMode: true, supported: true,
      free: false, accountId: nil, localRights: [f.localRight], evidenceStatus: "unknown"), .protected)
    let unavailable = SharedEntitlementStore(backing: InMemoryBacking(), coordinationAvailable: false, trust: trust(f))
    XCTAssertThrowsError(try unavailable.installAccess(local, generation: 0, issuerNow: f.verifiedAt, wall: 1000, localRights: [f.localRight]))
  }
  func testFailedAtomicReplacementPreservesEntireOldRecord() throws {
    let f = try fixtures(), p = try proof(f)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let good = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "entitlement"), trust: trust(f))
    let scope = try good.changeAccessAccount(f.account)
    let before = try Data(contentsOf: directory.appendingPathComponent("entitlement.json"))
    let broken = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "entitlement", beforeReplace: { throw AccessProofFailure.invalid }), trust: trust(f))
    XCTAssertThrowsError(try broken.installAccess(p, generation: scope.generation, issuerNow: f.verifiedAt, wall: 1000, localRights: []))
    XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("entitlement.json")), before)
  }
  func testActualBridgeReadAndSignOutFencePreserveLocalProtection() throws {
    let f = try fixtures(), paid = try proof(f), local = try proof(f, "protected-local")
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust(f))
    let scope = try store.changeAccessAccount(f.account)
    _ = try store.installAccess(paid, generation: scope.generation, issuerNow: f.verifiedAt, wall: 1000, localRights: [])
    _ = try store.installAccess(local, generation: scope.generation, issuerNow: f.verifiedAt, wall: 1000, localRights: [f.localRight])
    let bridge = EntitlementBridge(store: store, now: { 4000 })
    let raw = try XCTUnwrap(bridge.handle(rawBody: ["kind": "getAccess"])?.data(using: .utf8))
    let reply = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
    XCTAssertEqual(reply["ok"] as? Bool, true)
    let record = try XCTUnwrap(reply["record"] as? [String: Any])
    let rights = try XCTUnwrap(record["rights"] as? [[String: Any]])
    XCTAssertTrue(rights.last?["clock"] is NSNull, "Permanent rights must emit an explicit null clock for the TS decoder")
    XCTAssertTrue(rights.last?["accountGeneration"] is NSNull)
    XCTAssertEqual(try store.observeAccess(wall: 4000).0.rights.first?.clock?.highWater, f.verifiedAt + 3000)
    try bridge.clearAccessAccount()
    XCTAssertEqual(try store.observeAccess(wall: 4000).0.rights.count, 1)
    XCTAssertThrowsError(try store.installAccess(paid, generation: scope.generation, issuerNow: f.verifiedAt, wall: 4000, localRights: []))
    let readonly = EntitlementBridge(store: store, readOnly: true)
    XCTAssertThrowsError(try readonly.clearAccessAccount())
    XCTAssertNil(EntitlementRequest.parse(["kind": "getAccess", "wall": 1]))
    XCTAssertNil(EntitlementRequest.parse(["kind": "installAccess", "proof": "anything"]))
  }
}
