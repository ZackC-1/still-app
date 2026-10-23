import XCTest
@testable import StillKit

/// ISS-0105 follow-up (owner, 22 Oct): the benefit snapshot's `accountHoldsPro` tells the Safari
/// popup and Settings page to read "Still Pro User" instead of "Still Pro on this device". It is
/// display only and must agree exactly with the Apple app's `readAccountHeldPro` (TypeScript): true
/// only for a verified `paid_account` proof held by the record's signed-in account, in its current
/// session generation, not revoked, expired or paused, on neither revocation list, carrying a Still
/// Pro benefit. The shared cases in tests/access-proof/account-holds-pro-vectors.json are read by
/// both languages.
@available(macOS 10.15, *)
final class AccountHoldsProTests: XCTestCase {
  struct Vectors: Decodable {
    struct Case: Decodable { let name: String; let trust: String; let record: AccessCacheRecord; let accountHoldsPro: Bool; let wall: Int? }
    let snapshotKeys: [String]
    let legacySnapshotKeys: [String]
    let wall: Int
    let otherPublicKeyHex: String
    let cases: [Case]
  }
  struct ProofVectors: Decodable { let publicKeyHex: String; let protectedProduct: String; let protectedBenefits: [String] }

  static var root: URL {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    return root
  }
  func vectors() throws -> Vectors {
    try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: Self.root.appendingPathComponent("tests/access-proof/account-holds-pro-vectors.json")))
  }
  func hex(_ text: String) -> Data {
    Data(stride(from: 0, to: text.count, by: 2).map { offset -> UInt8 in
      let start = text.index(text.startIndex, offsetBy: offset)
      return UInt8(text[start..<text.index(start, offsetBy: 2)], radix: 16)!
    })
  }
  func trust(_ name: String, _ v: Vectors) throws -> AccessTrust {
    let proofs = try JSONDecoder().decode(ProofVectors.self, from: Data(contentsOf: Self.root.appendingPathComponent("tests/access-proof/vectors.json")))
    let environment = name == "production" ? "production" : "sandbox"
    let key = name == "other-key" ? hex(v.otherPublicKeyHex) : hex(proofs.publicKeyHex)
    return AccessTrust(environment: environment, keys: [.init(kid: "synthetic-access", publicKey: key, environment: environment)],
      protectedProduct: proofs.protectedProduct, protectedBenefits: proofs.protectedBenefits)
  }
  func store(_ record: AccessCacheRecord, trust: AccessTrust) throws -> SharedEntitlementStore {
    let access = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record))
    return SharedEntitlementStore(backing: InMemoryBacking(try JSONSerialization.data(withJSONObject: ["access": access])), trust: trust)
  }
  let all = Set(PackagedFeatureRegistry.featureIDs + [PackagedFeatureRegistry.tiktokAlias])

  // MARK: Shared vectors (the same cases the TypeScript readAccountHeldPro test reads)

  func testSharedVectorsAgreeWithTheAppsAccountProvenance() throws {
    let v = try vectors()
    XCTAssertGreaterThanOrEqual(v.cases.count, 17)
    XCTAssertTrue(v.cases.contains { $0.accountHoldsPro })
    XCTAssertTrue(v.cases.contains { !$0.accountHoldsPro })
    for c in v.cases {
      let context = NativeAccessContext(paidMode: true, supported: all, accountId: c.record.accountId,
        sessionId: c.record.sessionId, sessionKnown: true)
      let snapshot = try store(c.record, trust: trust(c.trust, v)).observeBenefits(wall: c.wall ?? v.wall, context: context).1
      XCTAssertEqual(snapshot.accountHoldsPro, c.accountHoldsPro, c.name)
      // The answer names its account, and only when it is true.
      XCTAssertEqual(snapshot.accountHoldsProFor, c.accountHoldsPro ? c.record.accountId : nil, c.name)
    }
  }

  func testTheWireSnapshotHasExactlyTheSharedSixKeys() throws {
    let v = try vectors()
    XCTAssertEqual(Set(v.snapshotKeys), Set(v.legacySnapshotKeys + ["accountHoldsPro", "accountHoldsProFor"]))
    let account = try XCTUnwrap(v.cases.first { $0.accountHoldsPro })
    let context = NativeAccessContext(paidMode: true, supported: all, accountId: account.record.accountId,
      sessionId: account.record.sessionId, sessionKnown: true)
    let bridge = EntitlementBridge(store: try store(account.record, trust: trust(account.trust, v)), now: { v.wall }, accessContext: { context })
    let reply = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(bridge.handle(.getBenefitAccess).utf8)) as? [String: Any])
    let snapshot = try XCTUnwrap(reply["snapshot"] as? [String: Any])
    XCTAssertEqual(Set(snapshot.keys), Set(v.snapshotKeys))
    XCTAssertEqual(snapshot["accountHoldsPro"] as? Bool, true)
    XCTAssertEqual(snapshot["accountHoldsProFor"] as? String, account.record.accountId)
    // A JSON Boolean, never 1/0.
    XCTAssertTrue((snapshot["accountHoldsPro"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? false)
    // Paid off: the free snapshot carries the field too, always false. The 3.x line compiles the paid
    // tier on, so the paid-off world is a supplied paid-off context (the default context is paid on,
    // and a paid-on read of a store without coordination fails closed with verificationRequired).
    let paidOff = NativeAccessContext(paidMode: false, supported: NativeAppleAccessCapabilities.supported(paidMode: false))
    let free = try SharedEntitlementStore(backing: InMemoryBacking(), coordinationAvailable: false).observeBenefits(wall: 1, context: paidOff).1
    XCTAssertFalse(free.accountHoldsPro)
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(free)) as? [String: Any])
    XCTAssertEqual(Set(encoded.keys), Set(v.snapshotKeys))
    XCTAssertTrue(encoded["accountHoldsProFor"] is NSNull)
  }

  func testTheProofDeadlineDecidesAtTheReadersWallClock() throws {
    let v = try vectors()
    let before = try XCTUnwrap(v.cases.first { $0.name == "one millisecond before the proof deadline" })
    let at = try XCTUnwrap(v.cases.first { $0.name == "at the proof deadline" })
    for c in [before, at] {
      let right = try XCTUnwrap(c.record.rights.first)
      let clock = try XCTUnwrap(right.clock)
      XCTAssertFalse(clock.expired || clock.revoked || clock.paused)
      XCTAssertEqual((c.wall ?? 0) - clock.expiresAt, c.name == before.name ? -1 : 0)
    }
    XCTAssertTrue(before.accountHoldsPro)
    XCTAssertFalse(at.accountHoldsPro)
  }

  // MARK: Real flows through the Safari extension's read-only lane

  let f = AppleRightBindingTests()
  func safari(_ store: SharedEntitlementStore, displayed: AccountSyncStatusStore.DisplayedAccount, at wall: Int? = nil) throws -> [String: Any] {
    let at = wall ?? f.now + 1
    let reply = EntitlementBridge.safariExtension(store: store, paidMode: true, platform: .mac, now: { at },
      displayedAccount: { displayed }).handle(.getBenefitAccess)
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any], reply)
    XCTAssertEqual(body["ok"] as? Bool, true, reply)
    return try XCTUnwrap(body["snapshot"] as? [String: Any])
  }
  func holds(_ store: SharedEntitlementStore, displayed: AccountSyncStatusStore.DisplayedAccount, at wall: Int? = nil) throws -> Bool {
    let snapshot = try safari(store, displayed: displayed, at: wall)
    let held = try XCTUnwrap(snapshot["accountHoldsPro"] as? Bool)
    // Whenever it is true it names the account the app displays; otherwise it names nobody.
    if held, case .account(let shown) = displayed { XCTAssertEqual(snapshot["accountHoldsProFor"] as? String, shown) }
    else { XCTAssertTrue(snapshot["accountHoldsProFor"] is NSNull) }
    return held
  }
  func linkedStore() throws -> SharedEntitlementStore {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust)
    _ = try store.installAppleAccess(f.request(linked: true), nativePurchase: f.native(), session: try f.verifiedSession(),
      expectedGeneration: 0, wall: f.now)
    return store
  }

  func testAnAppleProLinkedToTheSignedInAccountIsTheAccounts() throws {
    let store = try linkedStore()
    XCTAssertTrue(try holds(store, displayed: .account(f.account)))
    // The app's own read agrees.
    XCTAssertTrue(try store.observeAppleBenefits(wall: f.now + 1, ownership: .unknown, paidMode: true, platform: .mac).accountHoldsPro)
  }

  func testAWebPurchaseOnTheSignedInAccountIsTheAccounts() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust)
    let session = try f.verifiedSession()
    let generation = try store.prepareAccountAccess(session, expectedGeneration: 0)
    let body: [String: Any] = ["access": ["status": "verified", "environment": "sandbox",
      "proofs": [try f.envelope(f.claims(holder: f.account).canonical())], "revocations": [], "issuer_time": f.now]]
    let snapshot = try NativeAccountAccessSnapshot.parse(JSONSerialization.data(withJSONObject: body), trust: f.trust, holder: f.account)
    _ = try store.installAccountAccess(snapshot, session: session, expectedGeneration: generation, wall: f.now)
    XCTAssertTrue(try holds(store, displayed: .account(f.account)))
  }

  func testOnlyTheAccountTheAppShowsCounts() throws {
    let store = try linkedStore()
    XCTAssertFalse(try holds(store, displayed: .signedOut))
    XCTAssertFalse(try holds(store, displayed: .unreadable))
    XCTAssertFalse(try holds(store, displayed: .account("dddddddd-dddd-4ddd-8ddd-dddddddddddd")))
  }

  func testADeviceOnlyPurchaseIsNeverTheAccounts() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust)
    _ = try store.installAppleAccess(f.request(), nativePurchase: f.native(), wall: f.now)
    XCTAssertFalse(try holds(store, displayed: .signedOut))
    // Signed in afterwards: the device's purchase is still not the account's until native links it.
    _ = try store.changeAccessSession(accountId: f.account, sessionId: f.sessionID)
    let snapshot = try safari(store, displayed: .account(f.account))
    XCTAssertEqual((snapshot["states"] as? [String: String])?["youtube.comments"], "purchased")
    XCTAssertEqual(snapshot["accountHoldsPro"] as? Bool, false)
  }

  func testASandboxReviewPurchaseIsNeverTheAccounts() throws {
    let production = AccessTrust(environment: "production", keys: [.init(kid: "synthetic-access", publicKey: f.key.publicKey.rawRepresentation, environment: "production")])
    let payload = f.binding().canonical().replacingOccurrences(of: "\"schema\":1,\"environment\":\"sandbox\"",
      with: "\"schema\":2,\"environment\":\"production\",\"transactionEnvironment\":\"sandbox\"")
    let local = try f.envelope(f.claims().canonical().replacingOccurrences(of: "\"environment\":\"sandbox\"", with: "\"environment\":\"production\""))
    let request = AppleAccessInstallRequest(nativeBinding: try f.envelope(payload, domain: "still-apple-right-binding-v2\n"),
      localProof: local, issuerTime: f.now, accountProof: nil, accessToken: nil)
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: production)
    _ = try store.installAppleAccess(request, nativePurchase: f.native(), wall: f.now)
    _ = try store.changeAccessSession(accountId: f.account, sessionId: f.sessionID)
    let reply = EntitlementBridge.safariExtension(store: store, paidMode: true, platform: .mac, now: { self.f.now + 1 },
      displayedAccount: { .account(self.f.account) }).handle(.getBenefitAccess)
    let snapshot = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any])?["snapshot"] as? [String: Any])
    XCTAssertEqual((snapshot["states"] as? [String: String])?["youtube.comments"], "purchased")
    XCTAssertEqual(snapshot["accountHoldsPro"] as? Bool, false)
  }

  func testANewSessionForTheSameAccountDropsTheOlderSessionsProof() throws {
    let store = try linkedStore()
    _ = try store.changeAccessSession(accountId: f.account, sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
    XCTAssertFalse(try holds(store, displayed: .account(f.account)))
  }

  func testExpiryAndRefundsEndIt() throws {
    XCTAssertFalse(try holds(try linkedStore(), displayed: .account(f.account), at: f.now + paidAccessWindowMilliseconds + 1))
    let refunded = try linkedStore()
    _ = try refunded.revokeAppleAccess(.init(identity: f.native(), revokedAt: f.now + 1), wall: f.now + 1)
    XCTAssertFalse(try holds(refunded, displayed: .account(f.account), at: f.now + 2))
    let revoked = try linkedStore()
    _ = try revoked.revokeAccess(right: f.right, revision: 1, generation: try revoked.observeAccess(wall: f.now).0.generation)
    XCTAssertFalse(try holds(revoked, displayed: .account(f.account)))
  }

  func testAClockRollbackPausesIt() throws {
    let store = try linkedStore()
    XCTAssertTrue(try holds(store, displayed: .account(f.account), at: f.now + 10))
    XCTAssertFalse(try holds(store, displayed: .account(f.account), at: f.now + 5))
  }

  func testPaidOffIsAlwaysFalse() throws {
    let store = try linkedStore()
    let reply = EntitlementBridge.safariExtension(store: store, paidMode: false, platform: .mac, now: { self.f.now + 1 },
      displayedAccount: { .account(self.f.account) }).handle(.getBenefitAccess)
    let snapshot = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any])?["snapshot"] as? [String: Any])
    XCTAssertEqual(snapshot["accountHoldsPro"] as? Bool, false)
  }
}
