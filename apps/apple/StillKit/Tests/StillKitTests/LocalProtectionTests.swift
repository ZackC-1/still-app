import Foundation
import XCTest
@testable import StillKit

final class LocalProtectionTests: XCTestCase {
  private func cutoff() throws -> LocalProtectionCutoff {
    try LocalProtectionCutoff(product: "fixture-released-free-v1", benefits: ["youtube.comments", "youtube.shorts"], activatedAt: 1_700_000_000_000)
  }
  private func declaration() throws -> LocalProtectionRecord {
    try XCTUnwrap(mutateLocalProtection(nil, mutation: .declare(confirmed: true, priorEvidence: "absent", cutoff: cutoff())))
  }
  func testSharedOriginalByteAndCutoffVectors() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let bytes = try Data(contentsOf: root.appendingPathComponent("tests/access-proof/local-protection-vectors.json"))
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    for row in try XCTUnwrap(json["originals"] as? [[String: Any]]) {
      let name = try XCTUnwrap(row["name"] as? String), raw = try XCTUnwrap(row["native"])
      let data = raw is NSNull ? nil : try JSONSerialization.data(withJSONObject: raw)
      let evidence = assessOriginalProtection(data)
      let status: String
      switch evidence { case .absent: status = "absent"; case .unreadable: status = "unreadable"; case .unsupported: status = "unsupported"; case .legacy: status = "legacy" }
      XCTAssertEqual(status, row["assessment"] as? String, name)
      let record = try mutateLocalProtection(nil, mutation: .assessOriginal(evidence, cutoff: cutoff()))
      XCTAssertEqual(record?.grant != nil, row["granted"] as? Bool, name)
      let suite = "still.local-protection.tests.\(name)", defaults = UserDefaults(suiteName: "still.local-protection.tests.\(name)")!
      defaults.removePersistentDomain(forName: suite)
      if let data = data {
        defaults.set(data, forKey: "still:originalInstall")
        _ = OriginalInstall.ensure(firstRecordedAt: Date(timeIntervalSince1970: 1_800_000_000), appVersion: "3.0.0", defaults: defaults)
        XCTAssertEqual(defaults.data(forKey: "still:originalInstall"), data, name)
        XCTAssertEqual(OriginalInstall.protectionEvidence(defaults), evidence, name)
      }
      defaults.removePersistentDomain(forName: suite)
    }
  }
  func testCorruptNonDataOriginalIsNotRecreatedAndVersionNamespaceRemainsIntact() throws {
    let name = "still.local-protection.tests.corrupt", defaults = UserDefaults(suiteName: "still.local-protection.tests.corrupt")!
    defaults.removePersistentDomain(forName: name)
    defer { defaults.removePersistentDomain(forName: name) }
    defaults.set("retained unknown bytes", forKey: "still:originalInstall")
    XCTAssertNil(OriginalInstall.ensure(firstRecordedAt: Date(), appVersion: "3.0", defaults: defaults))
    XCTAssertEqual(defaults.string(forKey: "still:originalInstall"), "retained unknown bytes")
    XCTAssertEqual(OriginalInstall.protectionEvidence(defaults), .unreadable)
    defaults.removeObject(forKey: "still:originalInstall")
    _ = OriginalInstall.ensure(firstRecordedAt: Date(timeIntervalSince1970: 1_600_000_000), appVersion: "2.0", defaults: defaults)
    _ = OriginalInstall.fillVerifiedValues(applicationVersion: "6", kind: .buildNumber, originalPurchaseDate: Date(timeIntervalSince1970: 1_000_000_000), defaults: defaults)
    let bytes = try XCTUnwrap(defaults.data(forKey: "still:originalInstall"))
    guard case .legacy(let original) = OriginalInstall.protectionEvidence(defaults) else { return XCTFail("legacy") }
    XCTAssertEqual(original.firstRecordedAt, 1_600_000_000_000)
    XCTAssertEqual(original.firstRecordedAppVersion, "2.0")
    XCTAssertEqual(OriginalInstall.current(defaults)?.applicationVersionKind, .buildNumber)
    XCTAssertEqual(defaults.data(forKey: "still:originalInstall"), bytes)
  }
  func testMissingCutoffAndDeclarationRemainDistinctWithoutInventingBenefits() throws {
    let original = LocalProtectionOriginal(firstRecordedAt: 1000, firstRecordedAppVersion: "2.0.0")
    let pending = try mutateLocalProtection(nil, mutation: .assessOriginal(.legacy(original), cutoff: nil))
    XCTAssertNil(pending?.grant); XCTAssertEqual(pending?.original, original)
    XCTAssertEqual(resolveBenefitAccess("youtube.comments", evidence: [], paidMode: true, supported: true, free: false,
      accountId: nil, localRights: [], evidenceStatus: "absent", localProtection: pending), .verification_required)
    XCTAssertEqual(try mutateLocalProtection(pending, mutation: .applyCutoff(cutoff()))?.grant?.benefits, ["youtube.comments", "youtube.shorts"])
    let declared = try mutateLocalProtection(nil, mutation: .declare(confirmed: true, priorEvidence: "absent", cutoff: nil))
    XCTAssertEqual(declared?.provenance, "free_self_declaration"); XCTAssertNil(declared?.original); XCTAssertNil(declared?.grant)
    XCTAssertThrowsError(try mutateLocalProtection(nil, mutation: .declare(confirmed: false, priorEvidence: "absent", cutoff: cutoff())))
    for status in ["unavailable", "unreadable", "paid_revoked"] {
      XCTAssertThrowsError(try mutateLocalProtection(nil, mutation: .declare(confirmed: true, priorEvidence: status, cutoff: cutoff())))
    }
  }
  func testPermanentBoundedUnionDoesNotExpandOrRequireAccountOrClock() throws {
    let local = try declaration()
    let other = try LocalProtectionCutoff(product: "fixture-later", benefits: ["youtube.related"], activatedAt: 1_800_000_000_000)
    XCTAssertEqual(try mutateLocalProtection(local, mutation: .applyCutoff(other)), local)
    XCTAssertEqual(try mutateLocalProtection(local, mutation: .assessOriginal(.unreadable, cutoff: nil)), local)
    for account in [nil, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", nil] {
      XCTAssertEqual(resolveBenefitAccess("youtube.comments", evidence: [], paidMode: true, supported: true, free: false,
        accountId: account, localRights: [], evidenceStatus: "unknown", localProtection: local), .protected)
      XCTAssertEqual(resolveBenefitAccess("youtube.related", evidence: [], paidMode: true, supported: true, free: false,
        accountId: account, localRights: [], evidenceStatus: "absent", localProtection: local), .locked)
    }
    XCTAssertEqual(resolveBenefitAccess("youtube.comments", evidence: [], paidMode: true, supported: false, free: false,
      accountId: nil, localRights: [], evidenceStatus: "unknown", localProtection: local), .unsupported)
    XCTAssertEqual(resolveBenefitAccess("youtube.comments", evidence: [], paidMode: false, supported: true, free: false,
      accountId: nil, localRights: [], evidenceStatus: "unknown", localProtection: local), .free)
    let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(local)) as? [String: Any])
    XCTAssertTrue(raw["original"] is NSNull); XCTAssertNil(raw["accountId"]); XCTAssertNil(raw["expiresAt"])
  }
  func testStrictGrantKindAndPolicyBoundsCannotManufacturePaidRights() throws {
    XCTAssertThrowsError(try LocalProtectionCutoff(product: "still-pro-v3", benefits: ["youtube.comments"], activatedAt: 1000))
    XCTAssertThrowsError(try LocalProtectionCutoff(product: "fixture", benefits: ["future.anything"], activatedAt: 1000))
    let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(declaration())) as? [String: Any])
    for invalid in [raw.merging(["accountId": "private"], uniquingKeysWith: { _, next in next }),
      raw.merging(["schema": 2], uniquingKeysWith: { _, next in next }),
      raw.merging(["provenance": "provider_verified"], uniquingKeysWith: { _, next in next })] {
      XCTAssertThrowsError(try JSONDecoder().decode(LocalProtectionRecord.self, from: JSONSerialization.data(withJSONObject: invalid)))
    }
    XCTAssertNil(EntitlementRequest.parse(["kind": "declareFreeProtection", "product": "still-pro-v3"]))
  }
  func testAtomicReplacementPreservesLocalAndOpaqueRecordsOnFailure() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("still-local-protection-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let backing = AtomicSettingsBacking(directory: directory, name: "entitlement"), store = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "entitlement"))
    _ = try store.mutateLocalProtection(.declare(confirmed: true, priorEvidence: "absent", cutoff: cutoff()))
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(backing.read())) as? [String: Any])
    var access = try XCTUnwrap(object["access"] as? [String: Any]); access["future"] = ["retain": true]
    object["access"] = access; object["opaque"] = ["retain": true]
    backing.write(try JSONSerialization.data(withJSONObject: object))
    _ = try store.changeAccessAccount("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    store.save(EntitlementRecord(entitled: false, updatedAt: 1000))
    let record = try store.changeAccessAccount(nil)
    XCTAssertEqual(record.localProtection, try declaration())
    let persisted = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(backing.read())) as? [String: Any])
    XCTAssertEqual((persisted["access"] as? [String: Any])?["future"] as? [String: Bool], ["retain": true])
    XCTAssertEqual(persisted["opaque"] as? [String: Bool], ["retain": true])
    let pendingBacking = AtomicSettingsBacking(directory: directory, name: "pending")
    _ = try SharedEntitlementStore(backing: pendingBacking).mutateLocalProtection(.declare(confirmed: true, priorEvidence: "absent", cutoff: nil))
    let before = try XCTUnwrap(pendingBacking.read())
    let broken = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "pending", beforeReplace: {throw AccessProofFailure.invalid}))
    XCTAssertThrowsError(try broken.mutateLocalProtection(.applyCutoff(cutoff())))
    XCTAssertEqual(pendingBacking.read(), before)
  }
  @available(macOS 10.15, *)
  func testLocalMutationPreservesVerifiedPaidClockRevocationAndSignOut() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("tests/access-proof/vectors.json"))) as? [String: Any])
    let hex = try XCTUnwrap(json["publicKeyHex"] as? String)
    let bytes = stride(from: 0, to: hex.count, by: 2).map { offset -> UInt8 in
      let start = hex.index(hex.startIndex, offsetBy: offset)
      return UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16)!
    }
    let trust = AccessTrust(environment: "sandbox", keys: [.init(kid: "synthetic-access", publicKey: Data(bytes), environment: "sandbox")],
      protectedProduct: try XCTUnwrap(json["protectedProduct"] as? String), protectedBenefits: try XCTUnwrap(json["protectedBenefits"] as? [String]))
    let rows = try XCTUnwrap(json["vectors"] as? [[String: Any]])
    let paid = try VerifiedAccessProof.verify(XCTUnwrap(rows.first { $0["name"] as? String == "paid-account" }?["envelope"] as? String), trust: trust)
    let account = try XCTUnwrap(json["account"] as? String), verifiedAt = try XCTUnwrap(json["verifiedAt"] as? Int)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("still-local-paid-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let a = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "entitlement"), trust: trust)
    let b = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "entitlement"), trust: trust)
    let scope = try a.changeAccessAccount(account)
    _ = try a.installAccess(paid, generation: scope.generation, issuerNow: verifiedAt, wall: 1000, localRights: [])
    _ = try b.mutateLocalProtection(.declare(confirmed: true, priorEvidence: "absent", cutoff: cutoff()))
    _ = try a.observeAccess(wall: 4000)
    _ = try b.revokeAccess(right: paid.claims.right, revision: 1, generation: scope.generation)
    b.save(EntitlementRecord(entitled: true, updatedAt: 4000))
    let observed = try a.observeAccess(wall: 4000)
    XCTAssertEqual(observed.0.rights.first?.clock?.highWater, verifiedAt + 3000)
    XCTAssertEqual(observed.0.revocations.count, 1)
    XCTAssertEqual(observed.1.first?.revoked, true)
    XCTAssertEqual(resolveBenefitAccess("youtube.comments", evidence: observed.1, paidMode: true, supported: true, free: false,
      accountId: account, localRights: [], evidenceStatus: "unknown", localProtection: observed.0.localProtection), .protected)
    XCTAssertEqual(try b.mutateLocalProtection(.applyCutoff(cutoff())), observed.0)
    let signedOut = try a.changeAccessAccount(nil)
    XCTAssertTrue(signedOut.rights.isEmpty)
    XCTAssertEqual(signedOut.localProtection, observed.0.localProtection)
    XCTAssertEqual(signedOut.revocations, observed.0.revocations)
  }
}
