import XCTest
@testable import StillKit

/// The Safari extension's read-only benefit lane (`EntitlementBridge.safariExtension`): what the
/// app records decides Safari's Still Pro rows, and nothing Safari can do grants or keeps a right.
final class SafariAccessLaneTests: XCTestCase {
  let f = AppleRightBindingTests()
  let other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  let otherSession = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  var pro: Set<String> { Set(NativeAppleAccessCapabilities.pro(for: .mac)) }

  func snapshot(_ proofs: [String], removals: [[String: Any]] = [], status: String = "verified", issuer: Int? = nil) throws -> NativeAccountAccessSnapshot {
    let body: [String: Any] = ["access": ["status": status, "environment": "sandbox", "proofs": proofs,
      "revocations": removals, "issuer_time": issuer ?? f.now]]
    return try NativeAccountAccessSnapshot.parse(JSONSerialization.data(withJSONObject: body), trust: f.trust, holder: f.account)
  }
  func states(_ store: SharedEntitlementStore, at wall: Int? = nil, paid: Bool = true, platform: SafariAccessPlatform = .mac,
              displayed: AccountSyncStatusStore.DisplayedAccount = .signedOut) throws -> [String: String] {
    let at = wall ?? f.now + 1
    let reply = EntitlementBridge.safariExtension(store: store, paidMode: paid, platform: platform, now: { at },
      displayedAccount: { displayed }).handle(.getBenefitAccess)
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any], reply)
    XCTAssertEqual(body["ok"] as? Bool, true, reply)
    return try XCTUnwrap((body["snapshot"] as? [String: Any])?["states"] as? [String: String])
  }
  func proRows(_ states: [String: String]) -> Set<String> { Set(states.filter { pro.contains($0.key) }.values) }
  /// A signed-in store holding one current account right for `f.account`.
  func signedInWithRight() throws -> (SharedEntitlementStore, InMemoryBacking, Int) {
    let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: f.trust)
    let session = try f.verifiedSession()
    let generation = try store.prepareAccountAccess(session, expectedGeneration: 0)
    _ = try store.installAccountAccess(snapshot([f.envelope(f.claims(holder: f.account).canonical())]),
      session: session, expectedGeneration: generation, wall: f.now)
    XCTAssertEqual(proRows(try states(store)), ["purchased"])
    return (store, backing, generation)
  }

  // MARK: Rights that must not (or no longer) unlock Safari

  func testAnotherAccountBoundLaterDoesNotInheritTheRight() throws {
    let (store, _, _) = try signedInWithRight()
    _ = try store.changeAccessSession(accountId: other, sessionId: otherSession)
    XCTAssertFalse(proRows(try states(store)).contains("purchased"))
  }
  func testExpiredPaidClockStopsUnlocking() throws {
    let (store, _, _) = try signedInWithRight()
    let rows = proRows(try states(store, at: f.now + paidAccessWindowMilliseconds + 1))
    XCTAssertEqual(rows, ["verification_required"])
  }
  func testServerRefundRevocationInASuccessfulReconcileReachesSafari() throws {
    let (store, _, generation) = try signedInWithRight()
    _ = try store.installAccountAccess(snapshot([], removals: [["right": f.right, "revision": 2]], status: "none"),
      session: try f.verifiedSession(), expectedGeneration: generation, wall: f.now + 1)
    XCTAssertEqual(try store.observeAccess(wall: f.now + 1).0.rights.count, 0)
    XCTAssertFalse(proRows(try states(store, at: f.now + 2)).contains("purchased"))
  }
  func testAppleRefundThatRevokesTheAccountRightReachesSafari() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust)
    _ = try store.installAppleAccess(f.request(linked: true), nativePurchase: f.native(), session: try f.verifiedSession(),
      expectedGeneration: 0, wall: f.now)
    XCTAssertEqual(proRows(try states(store)), ["purchased"])
    XCTAssertTrue(try store.revokeAppleAccess(NativeVerifiedAppleRevocation(identity: f.native(), revokedAt: f.now + 1), wall: f.now + 1))
    XCTAssertFalse(proRows(try states(store, at: f.now + 2)).contains("purchased"))
  }
  func testProofsFromAnotherEnvironmentNeverUnlock() throws {
    let (_, backing, _) = try signedInWithRight()
    let production = AccessTrust(environment: "production", keys: [.init(kid: "synthetic-access",
      publicKey: f.key.publicKey.rawRepresentation, environment: "production")])
    let rows = proRows(try states(SharedEntitlementStore(backing: backing, trust: production)))
    XCTAssertFalse(rows.contains("purchased"))
  }
  func testDefinitiveAuthRefusalClearIsVisibleToSafari() throws {
    let (store, _, _) = try signedInWithRight()
    try EntitlementBridge(store: store, now: { self.f.now + 1 }).clearAccessAccount()
    XCTAssertFalse(proRows(try states(store, at: f.now + 2)).contains("purchased"))
  }
  func testPaidOffIsTheFreeSnapshot() throws {
    let (store, _, _) = try signedInWithRight()
    let free = try states(store, paid: false)
    for feature in PackagedFeatureRegistry.features {
      XCTAssertEqual(free[feature.id], feature.tier == "free" ? "free" : "unsupported", feature.id)
    }
    XCTAssertEqual(free[PackagedFeatureRegistry.tiktokAlias], "free")
  }

  // MARK: Locked versus verification required (recorded ownership answers)

  func testSignedOutWithAFreshAppleNoneIsLocked() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust)
    XCTAssertEqual(proRows(try states(store)), ["verification_required"])
    _ = try store.observeAppleBenefits(wall: f.now, ownership: .noPurchases, paidMode: true, platform: .mac)
    XCTAssertEqual(proRows(try states(store)), ["locked"])
    let phone = try states(store, platform: .mobile)
    XCTAssertEqual(Set(NativeAppleAccessCapabilities.safariPro.map { phone[$0] ?? "" }), ["locked"])
    for desktopOnly in NativeAppleAccessCapabilities.safariDesktopLayoutPro { XCTAssertEqual(phone[desktopOnly], "unsupported") }
  }
  func testAppleNoneAgesOutAndIgnoresClockRollback() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust)
    _ = try store.observeAppleBenefits(wall: f.now, ownership: .noPurchases, paidMode: true, platform: .mac)
    XCTAssertEqual(proRows(try states(store, at: f.now + ownershipAbsenceWindowMilliseconds - 1)), ["locked"])
    XCTAssertEqual(proRows(try states(store, at: f.now + ownershipAbsenceWindowMilliseconds)), ["verification_required"])
    XCTAssertEqual(proRows(try states(store, at: f.now - 1)), ["verification_required"])
  }
  func testAnInconclusiveAppleAnswerReplacesAnOlderNone() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust)
    _ = try store.observeAppleBenefits(wall: f.now, ownership: .noPurchases, paidMode: true, platform: .mac)
    _ = try store.observeAppleBenefits(wall: f.now + 1, ownership: .unknown, paidMode: true, platform: .mac)
    XCTAssertEqual(proRows(try states(store, at: f.now + 2)), ["locked"], "unknown keeps the last answer")
    _ = try store.observeAppleBenefits(wall: f.now + 3, ownership: .purchaseHistory, paidMode: true, platform: .mac)
    XCTAssertEqual(proRows(try states(store, at: f.now + 4)), ["verification_required"])
  }
  func testSignedInNeedsTheAccountsOwnNoneForThisSession() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust)
    _ = try store.observeAppleBenefits(wall: f.now, ownership: .noPurchases, paidMode: true, platform: .mac)
    let session = try f.verifiedSession()
    let generation = try store.prepareAccountAccess(session, expectedGeneration: 0)
    let shown = AccountSyncStatusStore.DisplayedAccount.account(f.account)
    XCTAssertEqual(proRows(try states(store, displayed: shown)), ["verification_required"], "no server answer for this account yet")
    _ = try store.installAccountAccess(snapshot([], status: "unavailable"), session: session, expectedGeneration: generation, wall: f.now)
    XCTAssertEqual(proRows(try states(store, displayed: shown)), ["verification_required"], "unavailable is not none")
    _ = try store.installAccountAccess(snapshot([], status: "none"), session: session, expectedGeneration: generation, wall: f.now)
    XCTAssertEqual(proRows(try states(store, displayed: shown)), ["locked"])
    // The app showing another account, no account, or an unreadable status is not this answer.
    for other in [AccountSyncStatusStore.DisplayedAccount.account(other), .signedOut, .unreadable] {
      XCTAssertEqual(proRows(try states(store, displayed: other)), ["verification_required"])
    }
    // A new session (another sign-in) needs its own answer; the old one names an older generation.
    _ = try store.changeAccessSession(accountId: f.account, sessionId: otherSession)
    XCTAssertEqual(proRows(try states(store, displayed: shown)), ["verification_required"])
    // Signing out leaves only the Apple answer, which is still a fresh none.
    _ = try store.changeAccessAccount(nil)
    XCTAssertEqual(proRows(try states(store)), ["locked"])
  }
  func testSignedInBeforeTheFirstSuccessfulCheckIsNotLocked() throws {
    // The app published account A (which clears the bound account) but its first check failed.
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: f.trust)
    _ = try store.observeAppleBenefits(wall: f.now, ownership: .noPurchases, paidMode: true, platform: .mac)
    try EntitlementBridge(store: store, now: { self.f.now }).clearAccessAccount()
    XCTAssertNil(try store.observeAccess(wall: f.now).0.accountId)
    XCTAssertEqual(proRows(try states(store, displayed: .account(f.account))), ["verification_required"])
    XCTAssertEqual(proRows(try states(store, displayed: .unreadable)), ["verification_required"])
    XCTAssertEqual(proRows(try states(store, displayed: .signedOut)), ["locked"])
  }
  func testClearedOnRefusalWhileTheAppStillShowsTheAccountIsNotLocked() throws {
    let (store, _, _) = try signedInWithRight()
    _ = try store.observeAppleBenefits(wall: f.now, ownership: .noPurchases, paidMode: true, platform: .mac)
    try EntitlementBridge(store: store, now: { self.f.now + 1 }).clearAccessAccount()
    let rows = proRows(try states(store, at: f.now + 2, displayed: .account(f.account)))
    XCTAssertEqual(rows, ["verification_required"])
  }
  func testAnUnverifiedRightIsNeverHiddenAsLocked() throws {
    let (store, _, _) = try signedInWithRight()
    _ = try store.observeAppleBenefits(wall: f.now, ownership: .noPurchases, paidMode: true, platform: .mac)
    XCTAssertEqual(proRows(try states(store, at: f.now + paidAccessWindowMilliseconds + 1)), ["verification_required"])
  }

  // MARK: Durable record grammar

  func testEvidenceIsOptionalAndMalformedEvidenceIsOnlyUnknown() throws {
    let encoder = JSONEncoder(), decoder = JSONDecoder()
    let plain = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(AccessCacheRecord())) as? [String: Any])
    XCTAssertNil(plain["appleEvidence"]); XCTAssertNil(plain["accountEvidence"])
    for bad: Any in [true, ["none": true], ["none": true, "observedAt": -1, "holder": NSNull(), "generation": NSNull()],
                     ["none": true, "observedAt": 1, "holder": f.account, "generation": NSNull()]] {
      var record = plain; record["appleEvidence"] = bad; record["accountEvidence"] = bad
      let decoded = try decoder.decode(AccessCacheRecord.self, from: JSONSerialization.data(withJSONObject: record))
      XCTAssertNil(decoded.appleEvidence); XCTAssertNil(decoded.accountEvidence)
    }
    var good = plain
    good["accountEvidence"] = ["none": true, "observedAt": 1, "holder": f.account, "generation": 2]
    XCTAssertEqual(try decoder.decode(AccessCacheRecord.self, from: JSONSerialization.data(withJSONObject: good)).accountEvidence,
      OwnershipEvidence(none: true, observedAt: 1, holder: f.account, generation: 2))
  }
  func testPaidOffReadsWriteNoEvidence() throws {
    let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: f.trust)
    _ = try store.observeAppleBenefits(wall: f.now, ownership: .noPurchases, paidMode: false, platform: .mac)
    _ = try states(store, paid: false)
    XCTAssertNil(backing.read())
  }

  // MARK: Hosted Auth refusal classification

  func testOnlyDocumentedAuthRefusalsAreDefinitive() {
    func body(_ code: String) -> Data { Data("{\"code\":403,\"error_code\":\"\(code)\",\"msg\":\"synthetic\"}".utf8) }
    for code in ["user_not_found", "session_not_found", "user_banned"] {
      for status in [401, 403, 404] { XCTAssertTrue(NativeAccessSessionCheck.isDefinitiveRejection(status: status, body: body(code)), "\(status) \(code)") }
      for status in [400, 429, 500, 502, 503] { XCTAssertFalse(NativeAccessSessionCheck.isDefinitiveRejection(status: status, body: body(code)), "\(status) \(code)") }
    }
    // The 2024-01-01 API format names the code in a string `code`; a numeric legacy `code` is not one.
    for code in ["user_not_found", "session_not_found", "user_banned"] {
      XCTAssertTrue(NativeAccessSessionCheck.isDefinitiveRejection(status: 403,
        body: Data("{\"code\":\"\(code)\",\"message\":\"synthetic\"}".utf8)), code)
    }
    XCTAssertFalse(NativeAccessSessionCheck.isDefinitiveRejection(status: 403, body: Data("{\"code\":\"bad_jwt\",\"message\":\"expired\"}".utf8)))
    XCTAssertFalse(NativeAccessSessionCheck.isDefinitiveRejection(status: 403, body: Data("{\"code\":403,\"msg\":\"synthetic\"}".utf8)))
    for code in ["bad_jwt", "session_expired", "no_authorization", "unexpected_failure", ""] {
      XCTAssertFalse(NativeAccessSessionCheck.isDefinitiveRejection(status: 403, body: body(code)), code)
    }
    for raw in ["", "not json", "[]", "{\"msg\":\"User from sub claim in JWT does not exist\"}", "{\"error_code\":7}"] {
      XCTAssertFalse(NativeAccessSessionCheck.isDefinitiveRejection(status: 403, body: Data(raw.utf8)), raw)
    }
    XCTAssertFalse(NativeAccessSessionCheck.isDefinitiveRejection(status: 403, body: Data(repeating: 32, count: 65_537)))
  }
}
