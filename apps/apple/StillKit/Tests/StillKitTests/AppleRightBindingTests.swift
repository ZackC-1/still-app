import XCTest
import CryptoKit
@testable import StillKit

final class AppleRightBindingTests: XCTestCase {
  let now = 1_800_000_000_000
  let right = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  let account = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  let sessionID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  let original = "18446744073709551615"
  var key: Curve25519.Signing.PrivateKey { try! .init(rawRepresentation: Data(repeating: 7, count: 32)) }
  var trust: AccessTrust { .init(environment: "sandbox", keys: [.init(kid: "synthetic-access", publicKey: key.publicKey.rawRepresentation, environment: "sandbox")]) }
  func b64(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
  func envelope(_ payload: String, domain: String = "still-access-proof-v1\n") throws -> String {
    let signature = try key.signature(for: Data((domain + payload).utf8))
    return String(data: try JSONSerialization.data(withJSONObject: ["payload": b64(Data(payload.utf8)), "kid": "synthetic-access", "alg": "ed25519", "signature": b64(signature)], options: .sortedKeys), encoding: .utf8)!
  }
  func claims(_ revision: Int = 1, at: Int? = nil, id: String? = nil, holder: String? = nil) -> AccessClaims {
    let time = at ?? now, r = id ?? right
    return .init(schema: 1, issuer: "still-access", environment: "sandbox", audience: "still-app", kind: holder == nil ? "paid_apple_local" : "paid_account", provenance: "provider_verified", right: r, holder: holder ?? r, product: "still-pro-v3", benefits: stillProV3Benefits, ownership_revision: revision, verified_at: time, expires_at: time + paidAccessWindowMilliseconds)
  }
  func binding(_ revision: Int = 1, at: Int? = nil, id: String? = nil) -> AppleRightBindingClaims {
    let time = at ?? now
    return .init(schema: 1, environment: "sandbox", appBundleId: "org.example.Still", productId: "still_pro_v3", originalTransactionId: original, right: id ?? right, ownershipRevision: revision, verifiedAt: time, expiresAt: time + paidAccessWindowMilliseconds)
  }
  func native(environment: String = "sandbox", bundle: String = "org.example.Still", product: String = "still_pro_v3", transaction: String? = nil, ownership: NativeVerifiedApplePurchase.Ownership = .purchased, isRevoked: Bool = false) -> NativeVerifiedApplePurchase {
    .init(environment: environment, appBundleId: bundle, productId: product, originalTransactionId: transaction ?? original, ownership: ownership, isRevoked: isRevoked)
  }
  func token(sub: String? = nil) throws -> String {
    "e30." + b64(try JSONSerialization.data(withJSONObject: ["sub": sub ?? account, "session_id": sessionID])) + ".provider-accepted"
  }
  func verifiedSession(_ holder: String? = nil) throws -> VerifiedNativeAccessSession {
    try XCTUnwrap(VerifiedNativeAccessSession.validated(userReply: JSONSerialization.data(withJSONObject: ["id": holder ?? account, "email_confirmed_at": "confirmed"]), acceptedToken: token(sub: holder)))
  }
  func request(linked: Bool = false, revision: Int = 1, at: Int? = nil, id: String? = nil) throws -> AppleAccessInstallRequest {
    var body: [String: Any] = ["kind": "installAppleAccess", "nativeBinding": try envelope(binding(revision, at: at, id: id).canonical(), domain: "still-apple-right-binding-v1\n"), "localProof": try envelope(claims(revision, at: at, id: id).canonical()), "issuerTime": at ?? now]
    if linked { body["accountProof"] = try envelope(claims(revision, at: at, id: id, holder: account).canonical()); body["accessToken"] = try token() }
    return try XCTUnwrap(AppleAccessInstallRequest.parse(body))
  }
  func testCanonicalBindingDistinctDomainForgedSignaturesAndClosedSchema() throws {
    let payload = binding().canonical(), good = try envelope(payload, domain: "still-apple-right-binding-v1\n")
    let parsed = try VerifiedAppleRightBinding.verify(good, trust: trust)
    XCTAssertEqual(parsed.claims.originalTransactionId, original)
    XCTAssertTrue(parsed.matches(native()))
    XCTAssertTrue(parsed.matches(try VerifiedAccessProof.verify(envelope(claims().canonical()), trust: trust)))
    for bad in [try envelope(payload), try envelope(payload + " ", domain: "still-apple-right-binding-v1\n"), try envelope(payload.replacingOccurrences(of: "\"schema\":1", with: "\"schema\":1,\"schema\":1"), domain: "still-apple-right-binding-v1\n"), try envelope(payload.replacingOccurrences(of: "\"schema\":1", with: "\"schema\":1,\"extra\":true"), domain: "still-apple-right-binding-v1\n"), "{\"entitled\":true}"] {
      XCTAssertThrowsError(try VerifiedAppleRightBinding.verify(bad, trust: trust))
    }
    XCTAssertThrowsError(try VerifiedAppleRightBinding.verify(good, trust: .init(environment: "production", keys: trust.keys)))
    XCTAssertThrowsError(try VerifiedAppleRightBinding.verify(good, trust: .init(environment: "sandbox", keys: [])))
    var forged = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(good.utf8)) as? [String: String])
    forged["signature"] = b64(Data(repeating: 0, count: 64))
    XCTAssertThrowsError(try VerifiedAppleRightBinding.verify(String(data: JSONSerialization.data(withJSONObject: forged), encoding: .utf8)!, trust: trust))
  }
  func testNativeIdentityAndSignedClockMismatchCannotCommit() throws {
    for identity in [native(environment: "production"), native(bundle: "org.other.Still"), native(product: "still_sync"), native(transaction: "18446744073709551614")] {
      let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: trust)
      XCTAssertThrowsError(try store.installAppleAccess(request(), nativePurchase: identity, wall: now))
      XCTAssertNil(backing.read())
    }
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust)
    XCTAssertThrowsError(try store.installAppleAccess(request(at: now - 300_001), nativePurchase: native(), wall: now))
    var dto: [String: Any] = ["kind": "installAppleAccess", "nativeBinding": "signed", "localProof": "signed", "issuerTime": true]
    XCTAssertNil(AppleAccessInstallRequest.parse(dto))
    dto["issuerTime"] = now; dto["localRight"] = right
    XCTAssertNil(AppleAccessInstallRequest.parse(dto))
    dto.removeValue(forKey: "localRight"); dto["accountProof"] = "signed"
    XCTAssertNil(AppleAccessInstallRequest.parse(dto))
    let r = try request()
    XCTAssertThrowsError(try store.installAppleAccess(.init(nativeBinding: r.nativeBinding, localProof: r.localProof, issuerTime: now + 1, accountProof: nil, accessToken: nil), nativePurchase: native(), wall: now))
  }
  func testBindingAndBothProofClocksMustMatchAndInitialSkewHasABoundedNativePolicy() throws {
    for offset in [-300_000, 300_000] {
      let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust)
      let signedAt = now + offset
      let ack = try store.installAppleAccess(request(at: signedAt), nativePurchase: native(), wall: now)
      XCTAssertEqual(ack.verifiedAt, signedAt)
      let clock = try XCTUnwrap(store.observeAccess(wall: now).0.rights.first?.clock)
      XCTAssertEqual(clock.wallAtReceipt, now); XCTAssertEqual(clock.issuerTimeAtReceipt, signedAt)
    }
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust)
    XCTAssertThrowsError(try store.installAppleAccess(request(at: now + 300_001), nativePurchase: native(), wall: now))
    let r = try request(linked: true)
    for altered in [claims(2), claims(at: now + 1), claims(id: account)] {
      let mismatched = AppleAccessInstallRequest(nativeBinding: r.nativeBinding, localProof: try envelope(altered.canonical()), issuerTime: now, accountProof: nil, accessToken: nil)
      XCTAssertThrowsError(try store.installAppleAccess(mismatched, nativePurchase: native(), wall: now))
    }
    for altered in [claims(2, holder: account), claims(at: now + 1, holder: account)] {
      let mismatched = AppleAccessInstallRequest(nativeBinding: r.nativeBinding, localProof: r.localProof, issuerTime: now, accountProof: try envelope(altered.canonical()), accessToken: r.accessToken)
      XCTAssertThrowsError(try store.installAppleAccess(mismatched, nativePurchase: native(), session: verifiedSession(), expectedGeneration: 0, wall: now))
    }
  }

  func testAtomicBothScopesSignedOutLocalMappingAndReadonlyBridge() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "access"), trust: trust)
    let ack = try store.installAppleAccess(request(linked: true), nativePurchase: native(), session: verifiedSession(), expectedGeneration: 0, wall: now)
    XCTAssertEqual(ack.localRight, right); XCTAssertNotNil(ack.accountProofIdentity)
    XCTAssertEqual(try store.observeAccess(wall: now).0.rights.count, 2)
    _ = try store.changeAccessSession(accountId: nil, sessionId: nil)
    store.save(.init(entitled: false, updatedAt: now + 1, source: .receipt))
    let reopened = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "access"), trust: trust)
    XCTAssertEqual(try reopened.observeAppleAccess(wall: now + 1).rights.first?.status, "purchased")
    XCTAssertEqual(try reopened.observeAccess(wall: now + 1).0.rights.count, 1)
    let context = NativeAccessContext(paidMode: true, supported: ["youtube.comments"], sessionKnown: true)
    XCTAssertEqual(try reopened.observeBenefits(wall: now + 1, context: context).1.states["youtube.comments"], "purchased")
    let readonly = EntitlementBridge(store: reopened, now: { self.now + 1 }, readOnly: true, accessContext: { context })
    XCTAssertNotNil(readonly.handle(rawBody: ["kind": "observeAppleAccess"]))
    XCTAssertThrowsError(try readonly.prepareAppleAccessInstall())
    XCTAssertThrowsError(try readonly.installAppleAccess(request(), nativePurchase: native()))
  }
  func testGenerationAndVerifiedAccountFenceRollBackWholeInstall() throws {
    let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: trust)
    _ = try store.changeAccessSession(accountId: account, sessionId: sessionID)
    let before = backing.read()
    XCTAssertThrowsError(try store.installAppleAccess(request(linked: true), nativePurchase: native(), session: verifiedSession(), expectedGeneration: 0, wall: now))
    XCTAssertEqual(backing.read(), before)
    XCTAssertThrowsError(try store.installAppleAccess(request(linked: true), nativePurchase: native(), session: verifiedSession("dddddddd-dddd-4ddd-8ddd-dddddddddddd"), expectedGeneration: 1, wall: now))
    XCTAssertEqual(backing.read(), before)
  }
  func testReplayPreservesBaselineAndExpiryRollbackLatches() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust), r = try request()
    _ = try store.installAppleAccess(r, nativePurchase: native(), wall: now)
    _ = try store.installAppleAccess(r, nativePurchase: native(), wall: now + 100)
    let clock = try XCTUnwrap(store.observeAccess(wall: now + 100).0.rights.first?.clock)
    XCTAssertEqual(clock.wallAtReceipt, now); XCTAssertEqual(clock.expiresAt, now + paidAccessWindowMilliseconds)
    XCTAssertEqual(try store.observeAppleAccess(wall: now + paidAccessWindowMilliseconds).rights.first?.status, "verification_required")
    XCTAssertThrowsError(try store.installAppleAccess(r, nativePurchase: native(), wall: now + 200))
    XCTAssertEqual(try store.observeAppleAccess(wall: now + 200).rights.first?.status, "verification_required")
    XCTAssertThrowsError(try store.installAppleAccess(request(revision: 0), nativePurchase: native(), wall: now))
    XCTAssertThrowsError(try store.installAppleAccess(request(id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"), nativePurchase: native(), wall: now))
  }
  func testLostAcknowledgementRetryAfterFreshnessWindowDoesNotRenewBaseline() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust), r = try request()
    let first = try store.installAppleAccess(r, nativePurchase: native(), wall: now)
    let retried = try store.installAppleAccess(r, nativePurchase: native(), wall: now + 360_000)
    let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
    XCTAssertEqual(try encoder.encode(first), try encoder.encode(retried))
    let clock = try XCTUnwrap(store.observeAccess(wall: now + 360_000).0.rights.first?.clock)
    XCTAssertEqual(clock.wallAtReceipt, now)
    XCTAssertEqual(clock.issuerTimeAtReceipt, now)
    XCTAssertEqual(clock.expiresAt, now + paidAccessWindowMilliseconds)
    let freshDevice = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust)
    XCTAssertThrowsError(try freshDevice.installAppleAccess(r, nativePurchase: native(), wall: now + 360_000))
    _ = try store.revokeAppleAccess(.init(identity: native(), revokedAt: now + 360_001), wall: now + 360_001)
    XCTAssertThrowsError(try store.installAppleAccess(r, nativePurchase: native(), wall: now + 360_002))
  }
  func testRefundedHistoricalBindingDoesNotHideNewOriginalPurchase() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust)
    _ = try store.installAppleAccess(request(), nativePurchase: native(), wall: now)
    _ = try store.revokeAppleAccess(.init(identity: native(), revokedAt: now + 1), wall: now + 1)
    let nextOriginal = "18446744073709551614", nextRight = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    let body: [String: Any] = ["kind": "installAppleAccess", "issuerTime": now + 2,
      "nativeBinding": try envelope(binding(at: now + 2, id: nextRight).canonical().replacingOccurrences(of: original, with: nextOriginal), domain: "still-apple-right-binding-v1\n"),
      "localProof": try envelope(claims(at: now + 2, id: nextRight).canonical())]
    _ = try store.installAppleAccess(XCTUnwrap(AppleAccessInstallRequest.parse(body)), nativePurchase: native(transaction: nextOriginal), wall: now + 2)
    let observation = try store.observeAppleAccess(wall: now + 3)
    XCTAssertEqual(observation.rights.count, 1)
    XCTAssertEqual(observation.rights.first?.localRight, nextRight)
    XCTAssertEqual(observation.rights.first?.status, "purchased")
    XCTAssertEqual(try store.observeAccess(wall: now + 3).0.appleBindings.count, 2)
  }
  func testLinkEligibilityRequiresExactCurrentPurchasedSignedLocalBinding() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust)
    XCTAssertTrue(try store.observeAppleLinkAccess(nativePurchase: native(), wall: now).rights.isEmpty)
    _ = try store.installAppleAccess(request(), nativePurchase: native(), wall: now)
    XCTAssertEqual(try store.observeAppleLinkAccess(nativePurchase: native(), wall: now).rights.first?.localRight, right)
    XCTAssertTrue(try store.observeAppleLinkAccess(nativePurchase: native(transaction: "different-original"), wall: now).rights.isEmpty)
    XCTAssertThrowsError(try store.observeAppleLinkAccess(nativePurchase: native(ownership: .familyShared), wall: now))
    XCTAssertThrowsError(try store.observeAppleLinkAccess(nativePurchase: native(isRevoked: true), wall: now))
    _ = try store.changeAccessSession(accountId: account, sessionId: sessionID)
    _ = try store.changeAccessSession(accountId: nil, sessionId: nil)
    XCTAssertEqual(try store.observeAppleLinkAccess(nativePurchase: native(), wall: now).rights.count, 1)
    _ = try store.revokeAppleAccess(.init(identity: native(), revokedAt: now + 1), wall: now + 1)
    XCTAssertTrue(try store.observeAppleLinkAccess(nativePurchase: native(), wall: now + 2).rights.isEmpty)
    let expired = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust)
    _ = try expired.installAppleAccess(request(), nativePurchase: native(), wall: now)
    XCTAssertTrue(try expired.observeAppleLinkAccess(nativePurchase: native(), wall: now + paidAccessWindowMilliseconds).rights.isEmpty)
  }
  func testFailedDurableReplacementCannotAcknowledgeAnyScope() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let good = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "access"), trust: trust)
    _ = try good.changeAccessSession(accountId: account, sessionId: sessionID)
    let file = directory.appendingPathComponent("access.json"), before = try Data(contentsOf: file)
    let broken = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "access", beforeReplace: { throw AccessProofFailure.invalid }), trust: trust)
    XCTAssertThrowsError(try broken.installAppleAccess(request(linked: true), nativePurchase: native(), session: verifiedSession(), expectedGeneration: 1, wall: now))
    XCTAssertEqual(try Data(contentsOf: file), before)
  }
  func testRevocationAndCorruptedMappingCannotGrant() throws {
    let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: trust)
    _ = try store.installAppleAccess(request(), nativePurchase: native(), wall: now)
    _ = try store.revokeAccess(right: right, revision: 1, generation: 0)
    XCTAssertThrowsError(try store.installAppleAccess(request(), nativePurchase: native(), wall: now))
    XCTAssertTrue(try store.observeAppleAccess(wall: now).rights.isEmpty)
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(backing.read())) as? [String: Any])
    var access = try XCTUnwrap(object["access"] as? [String: Any])
    access["appleBindings"] = [["envelope": "forged", "localProofIdentity": "synthetic-access:" + String(repeating: "0", count: 128)]]
    object["access"] = access; backing.write(try JSONSerialization.data(withJSONObject: object))
    XCTAssertTrue(try store.observeAppleAccess(wall: now).rights.isEmpty)
  }
  func testNativeAbsenceAllowsOfferUnknownAndReceiptOnlyDoNotGrantAndUnknownHistoryHoldsCachedRight() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust)
    for benefit in NativeAppleAccessCapabilities.safariPro {
      XCTAssertEqual(try store.observeAppleBenefits(wall: now, ownership: .noPurchases, paidMode: true).states[benefit], "locked")
      XCTAssertEqual(try store.observeAppleBenefits(wall: now, ownership: .unknown, paidMode: true).states[benefit], "verification_required")
    }
    XCTAssertEqual(try store.observeAppleBenefits(wall: now, ownership: .noPurchases, paidMode: true).states["youtube.endscreen"], "unsupported")
    XCTAssertEqual(try store.observeAppleBenefits(wall: now, ownership: .noPurchases, paidMode: true).states["facebook.sponsored"], "unsupported")
    store.save(.init(entitled: true, updatedAt: now, source: .receipt))
    XCTAssertEqual(try store.observeAppleBenefits(wall: now, ownership: .purchaseHistory, paidMode: true).states["instagram.explore"], "verification_required")
    _ = try store.installAppleAccess(request(), nativePurchase: native(), wall: now)
    // History without independently verified revocation does not erase the cached signed right.
    XCTAssertEqual(try store.observeAppleBenefits(wall: now + 1, ownership: .purchaseHistory, paidMode: true).states["instagram.explore"], "purchased")
    XCTAssertEqual(try store.observeAppleBenefits(wall: now + paidAccessWindowMilliseconds, ownership: .noPurchases, paidMode: true).states["instagram.explore"], "verification_required")
  }

  func testObservedSafariYouTubeCapabilitiesRequireNativeScopedProofAndStayDormantWhenPaidOff() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust)
    let supported = ["youtube.related", "youtube.comments"]
    let unsupported = ["youtube.endscreen", "youtube.livechat", "youtube.autoplay", "facebook.sponsored"]
    for benefit in supported {
      XCTAssertEqual(try store.observeAppleBenefits(wall: now, ownership: .unknown, paidMode: true).states[benefit], "verification_required", benefit)
      XCTAssertEqual(try store.observeAppleBenefits(wall: now, ownership: .noPurchases, paidMode: true).states[benefit], "locked", benefit)
    }
    _ = try store.installAppleAccess(request(), nativePurchase: native(), wall: now)
    for benefit in supported {
      XCTAssertEqual(try store.observeAppleBenefits(wall: now, ownership: .purchaseHistory, paidMode: true).states[benefit], "purchased", benefit)
      XCTAssertEqual(try store.observeAppleBenefits(wall: now, ownership: .purchaseHistory, paidMode: false).states[benefit], "unsupported", benefit)
    }
    for benefit in unsupported {
      XCTAssertEqual(try store.observeAppleBenefits(wall: now, ownership: .purchaseHistory, paidMode: true).states[benefit], "unsupported", benefit)
    }
    let revoked = try store.observeAppleBenefits(wall: now + 1,
      ownership: .verifiedRevocations([.init(identity: native(), revokedAt: now + 1)]), paidMode: true)
    for benefit in supported { XCTAssertEqual(revoked.states[benefit], "verification_required", benefit) }
    XCTAssertEqual(revoked.states["youtube.shorts"], "free")
    XCTAssertEqual(revoked.states["tiktok.all"], "free")
  }

  func testVerifiedNativeRefundImmediatelyRevokesBothScopesAndPersistsAcrossColdReadsAndReplay() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "access"), trust: trust)
    _ = try store.installAppleAccess(request(linked: true), nativePurchase: native(), session: verifiedSession(), expectedGeneration: 0, wall: now)
    XCTAssertEqual(try store.observeAppleBenefits(wall: now, ownership: .purchaseHistory, paidMode: true).states["instagram.explore"], "purchased")
    let refund = NativeVerifiedAppleRevocation(identity: native(), revokedAt: now + 1)
    let snapshot = try store.observeAppleBenefits(wall: now + 2, ownership: .verifiedRevocations([refund]), paidMode: true)
    XCTAssertNotEqual(snapshot.states["instagram.explore"], "purchased")
    let revoked = try store.observeAccess(wall: now + 2)
    XCTAssertEqual(revoked.1.filter { $0.revoked }.count, 2)
    let reopened = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "access"), trust: trust)
    XCTAssertTrue(try reopened.observeAppleAccess(wall: now + 3).rights.isEmpty)
    XCTAssertNotEqual(try reopened.observeAppleBenefits(wall: now + 3, ownership: .noPurchases, paidMode: true).states["instagram.explore"], "purchased")
    XCTAssertThrowsError(try reopened.installAppleAccess(request(), nativePurchase: native(), wall: now + 3))
  }

  func testRefundIdentityMismatchAndUnknownObservationsNeverRevokeACachedRight() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust)
    _ = try store.installAppleAccess(request(), nativePurchase: native(), wall: now)
    for identity in [native(environment: "production"), native(bundle: "org.other.Still"), native(product: "still_sync"), native(transaction: "18446744073709551614")] {
      let snapshot = try store.observeAppleBenefits(wall: now + 1, ownership: .verifiedRevocations([.init(identity: identity, revokedAt: now)]), paidMode: true)
      XCTAssertEqual(snapshot.states["instagram.explore"], "purchased")
      XCTAssertNil(try store.observeAccess(wall: now + 1).0.appleBindings.first?.revokedAt)
    }
    for observation in [NativeAppleOwnershipObservation.unknown, .purchaseHistory] {
      XCTAssertEqual(try store.observeAppleBenefits(wall: now + 2, ownership: observation, paidMode: true).states["instagram.explore"], "purchased")
    }
    XCTAssertThrowsError(try store.revokeAppleAccess(.init(identity: native(), revokedAt: -1), wall: now + 2))
    XCTAssertNil(try store.observeAccess(wall: now + 2).0.appleBindings.first?.revokedAt)
  }

  func testNativeRefundPreservesUnrelatedAccountAndSameUUIDPermanentProtection() throws {
    let extendedTrust = AccessTrust(environment: trust.environment, keys: trust.keys,
      protectedProduct: "synthetic-free-snapshot", protectedBenefits: ["instagram.explore"])
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: extendedTrust)
    let ack = try store.installAppleAccess(request(linked: true), nativePurchase: native(), session: verifiedSession(), expectedGeneration: 0, wall: now)
    let unrelatedID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    let unrelated = try VerifiedAccessProof.verify(envelope(claims(id: unrelatedID, holder: account).canonical()), trust: extendedTrust)
    _ = try store.installAccess(unrelated, generation: ack.generation, issuerNow: now, wall: now, localRights: [])
    let protectedClaims = AccessClaims(schema: 1, issuer: "still-access", environment: "sandbox", audience: "still-app",
      kind: "protected_local", provenance: "legacy_free_verified", right: right, holder: right,
      product: "synthetic-free-snapshot", benefits: ["instagram.explore"], ownership_revision: 1, verified_at: now, expires_at: nil)
    let protected = try VerifiedAccessProof.verify(envelope(protectedClaims.canonical()), trust: extendedTrust)
    _ = try store.installAccess(protected, generation: ack.generation, issuerNow: now, wall: now, localRights: [right])
    XCTAssertTrue(try store.revokeAppleAccess(.init(identity: native(), revokedAt: now + 1), wall: now + 1))
    let observed = try store.observeAccess(wall: now + 1)
    XCTAssertEqual(observed.0.rights.count, 4)
    XCTAssertTrue(observed.1.filter { $0.proof.claims.right == right && $0.proof.claims.isPaid }.allSatisfy { $0.revoked && !$0.validPaid })
    XCTAssertTrue(observed.1.first { $0.proof.claims.right == unrelatedID }?.validPaid == true)
    XCTAssertFalse(try XCTUnwrap(observed.1.first { $0.proof.claims.kind == "protected_local" }).revoked)
    XCTAssertTrue(observed.0.revocations.isEmpty, "Native Apple revocation must not become a global protected-right revocation")
    XCTAssertThrowsError(try store.installAppleAccess(request(revision: 2, at: now + 2), nativePurchase: native(), wall: now + 2))
    // A generic newer account proof cannot bypass the persisted native binding revocation marker.
    let fresh = try VerifiedAccessProof.verify(envelope(claims(2, at: now + 2, holder: account).canonical()), trust: extendedTrust)
    _ = try store.installAccess(fresh, generation: ack.generation, issuerNow: now + 2, wall: now + 2, localRights: [])
    XCTAssertFalse(try store.observeAccess(wall: now + 2).1.first { $0.proof.identity == fresh.identity }?.validPaid == true)
  }

  func testFailedRefundCommitPreservesBytesAndReadOnlySafariCannotPublishRevocation() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let good = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "access"), trust: trust)
    _ = try good.installAppleAccess(request(), nativePurchase: native(), wall: now)
    let file = directory.appendingPathComponent("access.json"), before = try Data(contentsOf: file)
    let broken = SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "access", beforeReplace: { throw AccessProofFailure.invalid }), trust: trust)
    let refund = NativeVerifiedAppleRevocation(identity: native(), revokedAt: now + 1)
    XCTAssertThrowsError(try broken.revokeAppleAccess(refund, wall: now + 1))
    XCTAssertEqual(try Data(contentsOf: file), before)
    let readonly = EntitlementBridge(store: good, now: { self.now + 1 }, readOnly: true)
    XCTAssertThrowsError(try readonly.revokeAppleAccess(refund))
    XCTAssertEqual(try Data(contentsOf: file), before)
    XCTAssertTrue(try good.revokeAppleAccess(refund, wall: now + 1))
    XCTAssertTrue(try good.observeAppleAccess(wall: now + 1).rights.isEmpty)
  }

  func testSignedFamilyLocalInstallationWorksButAccountProofAndJSOwnershipNeverQualify() throws {
    let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: trust)
    let family = native(ownership: .familyShared)
    let ack = try store.installAppleAccess(request(), nativePurchase: family, wall: now)
    XCTAssertNil(ack.accountProofIdentity)
    XCTAssertEqual(try store.observeAppleAccess(wall: now).rights.first?.status, "purchased")
    let before = backing.read()
    XCTAssertThrowsError(try store.installAppleAccess(request(linked: true), nativePurchase: family,
      session: verifiedSession(), expectedGeneration: 0, wall: now))
    XCTAssertEqual(backing.read(), before)
    let dto: [String: Any] = ["kind": "installAppleAccess", "nativeBinding": try request().nativeBinding,
      "localProof": try request().localProof, "issuerTime": now, "ownership": "purchased"]
    XCTAssertNil(AppleAccessInstallRequest.parse(dto))
  }

  func testVerifiedFamilyRemovalLatchesLocalReplayButPreservesOriginalPurchaserAccountRight() throws {
    let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: trust)
    let scope = try store.changeAccessSession(accountId: account, sessionId: sessionID)
    let accountProof = try VerifiedAccessProof.verify(envelope(claims(holder: account).canonical()), trust: trust)
    _ = try store.installAccess(accountProof, generation: scope.generation, issuerNow: now, wall: now, localRights: [])
    _ = try store.installAppleAccess(request(), nativePurchase: native(ownership: .familyShared), wall: now)
    let removal = NativeVerifiedAppleRevocation(identity: native(ownership: .familyShared), revokedAt: now + 1)
    XCTAssertTrue(try store.revokeAppleAccess(removal, wall: now + 1))
    let reopened = SharedEntitlementStore(backing: backing, trust: trust)
    let evidence = try reopened.observeAccess(wall: now + 1)
    XCTAssertTrue(evidence.1.first { $0.proof.claims.kind == "paid_apple_local" }?.revoked == true)
    XCTAssertTrue(evidence.1.first { $0.proof.claims.kind == "paid_account" }?.validPaid == true)
    XCTAssertFalse(try XCTUnwrap(evidence.1.first { $0.proof.claims.kind == "paid_account" }).revoked)
    XCTAssertEqual(evidence.0.appleBindings.first?.revokesAccount, false)
    XCTAssertTrue(try reopened.observeAppleAccess(wall: now + 1).rights.isEmpty)
    XCTAssertThrowsError(try reopened.installAppleAccess(request(), nativePurchase: native(ownership: .familyShared), wall: now + 1))
    XCTAssertThrowsError(try reopened.installAppleAccess(request(revision: 2, at: now + 2), nativePurchase: native(ownership: .familyShared, isRevoked: true), wall: now + 2))
  }

  func testFamilyRejoinRequiresANewerSignedProofAndCurrentNonrevokedNativeFamilyTransaction() throws {
    let store = SharedEntitlementStore(backing: InMemoryBacking(), trust: trust)
    let scope = try store.changeAccessSession(accountId: account, sessionId: sessionID)
    let accountProof = try VerifiedAccessProof.verify(envelope(claims(holder: account).canonical()), trust: trust)
    _ = try store.installAccess(accountProof, generation: scope.generation, issuerNow: now, wall: now, localRights: [])
    let family = native(ownership: .familyShared)
    let first = try store.installAppleAccess(request(), nativePurchase: family, wall: now)
    _ = try store.revokeAppleAccess(.init(identity: native(ownership: .familyShared, isRevoked: true), revokedAt: now + 1), wall: now + 1)
    _ = try store.observeAppleBenefits(wall: now + 2, ownership: .unknown, paidMode: true)
    XCTAssertTrue(try store.observeAppleAccess(wall: now + 2).rights.isEmpty)
    XCTAssertThrowsError(try store.installAppleAccess(request(), nativePurchase: family, wall: now + 2))
    XCTAssertThrowsError(try store.installAppleAccess(request(at: now + 1), nativePurchase: family, wall: now + 2))
    XCTAssertThrowsError(try store.installAppleAccess(request(at: now + 3), nativePurchase: native(ownership: .familyShared, isRevoked: true), wall: now + 3))
    let restored = try store.installAppleAccess(request(at: now + 3), nativePurchase: family, wall: now + 3)
    XCTAssertNotEqual(restored.localProofIdentity, first.localProofIdentity)
    XCTAssertNil(restored.accountProofIdentity)
    let observed = try store.observeAccess(wall: now + 3)
    XCTAssertEqual(observed.0.generation, scope.generation)
    XCTAssertEqual(observed.0.rights.count, 2)
    XCTAssertTrue(observed.1.first { $0.proof.claims.kind == "paid_apple_local" }?.validPaid == true)
    let unchangedAccount = try XCTUnwrap(observed.0.rights.first { $0.envelope == accountProof.envelope })
    XCTAssertEqual(unchangedAccount.clock?.wallAtReceipt, now)
    XCTAssertEqual(unchangedAccount.clock?.issuerTimeAtReceipt, now)
    XCTAssertTrue(observed.1.first { $0.proof.identity == accountProof.identity }?.validPaid == true)
    XCTAssertNil(observed.0.appleBindings.first?.revokedAt)
    XCTAssertEqual(try store.observeAppleAccess(wall: now + 3).rights.first?.status, "purchased")
    XCTAssertThrowsError(try store.installAppleAccess(request(), nativePurchase: family, wall: now + 3))
  }

  func testPurchasedRefundCannotBeDowngradedByLaterFamilyRemovalAndOldMarkersKeepBothScopes() throws {
    let backing = InMemoryBacking(), store = SharedEntitlementStore(backing: backing, trust: trust)
    _ = try store.installAppleAccess(request(linked: true), nativePurchase: native(), session: verifiedSession(), expectedGeneration: 0, wall: now)
    _ = try store.revokeAppleAccess(.init(identity: native(), revokedAt: now + 1), wall: now + 1)
    _ = try store.revokeAppleAccess(.init(identity: native(ownership: .familyShared), revokedAt: now + 2), wall: now + 2)
    XCTAssertEqual(try store.observeAccess(wall: now + 2).0.appleBindings.first?.revokesAccount, true)
    XCTAssertThrowsError(try store.installAppleAccess(request(at: now + 3), nativePurchase: native(ownership: .familyShared), wall: now + 3))
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(backing.read())) as? [String: Any])
    var access = try XCTUnwrap(object["access"] as? [String: Any])
    var bindings = try XCTUnwrap(access["appleBindings"] as? [[String: Any]])
    bindings[0].removeValue(forKey: "revokesAccount") // Upgrade from the purchased-only refund packet.
    access["appleBindings"] = bindings; object["access"] = access
    backing.write(try JSONSerialization.data(withJSONObject: object))
    let reopened = SharedEntitlementStore(backing: backing, trust: trust)
    XCTAssertEqual(try reopened.observeAccess(wall: now + 2).1.filter { $0.revoked }.count, 2)
  }

  func testConfigurationDefaultsClosedAndBindsEnvironmentAndPublicEndpoint() throws {
    XCTAssertTrue(NativeAccessConfiguration.trust(info: [:]).keys.isEmpty)
    XCTAssertEqual(NativeAccessConfiguration.trust(info: ["StillAccessEnvironment": "sandbox"]).environment, "sandbox")
    let hex = key.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()
    let row = ["kid": "synthetic-access", "publicKeyHex": hex, "environment": "sandbox", "purpose": "access"]
    XCTAssertEqual(NativeAccessConfiguration.trust(info: ["StillAccessEnvironment": "sandbox", "StillAccessTrustKeys": [row]]).keys.count, 1)
    XCTAssertTrue(NativeAccessConfiguration.trust(info: ["StillAccessEnvironment": "production", "StillAccessTrustKeys": [row]]).keys.isEmpty)
    XCTAssertTrue(NativeAccessConfiguration.trust(info: ["StillAccessEnvironment": "sandbox", "StillAccessTrustKeys": [row, row]]).keys.isEmpty)
    XCTAssertNil(NativeAccessConfiguration.sessionVerifier(info: [:]))
    for endpoint in ["http://auth.example", "https://evil@auth.example", "https://auth.example/path", "https://auth.example?x=1"] {
      XCTAssertNil(NativeAccessConfiguration.sessionVerifier(info: ["StillAccessSupabaseURL": endpoint, "StillAccessSupabasePublishableKey": "sb_publishable_public"]))
    }
    XCTAssertNil(NativeAccessConfiguration.sessionVerifier(info: ["StillAccessSupabaseURL": "https://auth.example", "StillAccessSupabasePublishableKey": "sb_secret_no"]))
    XCTAssertNotNil(NativeAccessConfiguration.sessionVerifier(info: ["StillAccessSupabaseURL": "https://auth.example", "StillAccessSupabasePublishableKey": "sb_publishable_public"]))
  }
  func testAcceptedTokenRequiresExactConfirmedAccountAndSession() throws {
    XCTAssertEqual(try verifiedSession().sessionId, sessionID)
    for user in [["id": account], ["id": account, "email_confirmed_at": ""], ["id": right, "email_confirmed_at": "confirmed"]] {
      XCTAssertNil(VerifiedNativeAccessSession.validated(userReply: try JSONSerialization.data(withJSONObject: user), acceptedToken: try token()))
    }
    XCTAssertNil(VerifiedNativeAccessSession.validated(userReply: try JSONSerialization.data(withJSONObject: ["id": account, "email_confirmed_at": "confirmed"]), acceptedToken: "{\"accountId\":true}"))
  }
}
