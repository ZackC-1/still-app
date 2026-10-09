import Foundation

/// Produced by the app's current verified StoreKit transaction oracle, never decoded from JS.
public struct NativeVerifiedApplePurchase {
  public enum Ownership { case purchased, familyShared }
  public let environment: String
  public let appBundleId: String
  public let productId: String
  public let originalTransactionId: String
  public let ownership: Ownership
  public let isRevoked: Bool
  public init(environment: String, appBundleId: String, productId: String, originalTransactionId: String,
              ownership: Ownership = .purchased, isRevoked: Bool = false) {
    self.environment = environment; self.appBundleId = appBundleId
    self.productId = productId; self.originalTransactionId = originalTransactionId; self.ownership = ownership; self.isRevoked = isRevoked
  }
}

public struct AppleRightBindingClaims: Codable, Equatable {
  public let schema: Int
  public let environment: String
  public let appBundleId: String
  public let productId: String
  public let originalTransactionId: String
  public let right: String
  public let ownershipRevision: Int
  public let verifiedAt: Int
  public let expiresAt: Int
  func canonical() -> String {
    "{\"schema\":\(schema),\"environment\":\"\(environment)\",\"appBundleId\":\"\(appBundleId)\",\"productId\":\"\(productId)\",\"originalTransactionId\":\"\(originalTransactionId)\",\"right\":\"\(right)\",\"ownershipRevision\":\(ownershipRevision),\"verifiedAt\":\(verifiedAt),\"expiresAt\":\(expiresAt)}"
  }
}

public struct VerifiedAppleRightBinding {
  public let claims: AppleRightBindingClaims
  public let envelope: String
  private init(claims: AppleRightBindingClaims, envelope: String) {
    self.claims = claims; self.envelope = envelope
  }
  public static func verify(_ envelope: String, trust: AccessTrust) throws -> VerifiedAppleRightBinding {
    let signed = try verifySignedAccessPayload(envelope, trust: trust, domain: "still-apple-right-binding-v1\n")
    let c = try JSONDecoder().decode(AppleRightBindingClaims.self, from: signed.payload)
    guard let raw = try JSONSerialization.jsonObject(with: signed.payload) as? [String: Any],
      Set(raw.keys) == Set(["schema", "environment", "appBundleId", "productId", "originalTransactionId", "right", "ownershipRevision", "verifiedAt", "expiresAt"]),
      c.schema == 1, c.environment == trust.environment, ["production", "sandbox"].contains(c.environment),
      c.appBundleId.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$", options: .regularExpression) != nil,
      ApplePurchaseCatalog.all.contains(where: { $0.productID == c.productId }),
      c.originalTransactionId.range(of: "^[1-9][0-9]{0,39}$", options: .regularExpression) != nil,
      accessUUID(c.right), [c.ownershipRevision, c.verifiedAt, c.expiresAt].allSatisfy(accessInteger),
      c.expiresAt == c.verifiedAt + paidAccessWindowMilliseconds,
      String(data: signed.payload, encoding: .utf8) == c.canonical()
    else { throw AccessProofFailure.invalid }
    return VerifiedAppleRightBinding(claims: c, envelope: envelope)
  }
  func matches(_ proof: VerifiedAccessProof) -> Bool {
    let p = proof.claims, c = claims
    return p.kind == "paid_apple_local" && p.provenance == "provider_verified" && p.holder == p.right &&
      p.environment == c.environment && p.right == c.right && p.ownership_revision == c.ownershipRevision &&
      p.verified_at == c.verifiedAt && p.expires_at == c.expiresAt
  }
  func matches(_ native: NativeVerifiedApplePurchase) -> Bool {
    claims.environment == native.environment && claims.appBundleId == native.appBundleId &&
      claims.productId == native.productId && claims.originalTransactionId == native.originalTransactionId
  }
}

public struct CachedAppleRightBinding: Codable, Equatable {
  public let envelope: String
  public let localProofIdentity: String
  /// Native verified refund marker. It survives cached proof replay and never applies to protection.
  public var revokedAt: Int? = nil
  /// Absent on older purchased-refund markers means both paid scopes. Family removal is local only.
  public var revokesAccount: Bool? = nil
}

public struct AppleAccessInstallRequest {
  public let nativeBinding: String
  public let localProof: String
  public let issuerTime: Int
  public let accountProof: String?
  public let accessToken: String?
  public static func parse(_ body: Any) -> AppleAccessInstallRequest? {
    guard let d = body as? [String: Any], d["kind"] as? String == "installAppleAccess" else { return nil }
    let linked = d["accountProof"] != nil || d["accessToken"] != nil
    let fields = Set(["kind", "nativeBinding", "localProof", "issuerTime"] + (linked ? ["accountProof", "accessToken"] : []))
    guard Set(d.keys) == fields, let binding = d["nativeBinding"] as? String,
      let local = d["localProof"] as? String, !binding.isEmpty, !local.isEmpty,
      binding.utf8.count <= 6_144, local.utf8.count <= 6_144,
      let n = d["issuerTime"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
      n.doubleValue.rounded(.down) == n.doubleValue, n.doubleValue >= 0, n.doubleValue <= 9_007_199_254_740_991,
      !linked || ((d["accountProof"] as? String).map { !$0.isEmpty && $0.utf8.count <= 6_144 } == true &&
        (d["accessToken"] as? String).map { !$0.isEmpty && $0.utf8.count <= 16_384 } == true)
    else { return nil }
    return AppleAccessInstallRequest(nativeBinding: binding, localProof: local, issuerTime: n.intValue,
      accountProof: d["accountProof"] as? String, accessToken: d["accessToken"] as? String)
  }
}

public struct AppleAccessCommit: Encodable {
  public let schema = 1
  public let status = "committed"
  public let generation: Int
  public let localRight: String
  public let ownershipRevision: Int
  public let verifiedAt: Int
  public let expiresAt: Int
  public let localProofIdentity: String
  public let accountProofIdentity: String?
  private enum CodingKeys: String, CodingKey {
    case schema, status, generation, localRight, ownershipRevision, verifiedAt, expiresAt, localProofIdentity, accountProofIdentity
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(schema, forKey: .schema); try c.encode(status, forKey: .status)
    try c.encode(generation, forKey: .generation); try c.encode(localRight, forKey: .localRight)
    try c.encode(ownershipRevision, forKey: .ownershipRevision); try c.encode(verifiedAt, forKey: .verifiedAt)
    try c.encode(expiresAt, forKey: .expiresAt); try c.encode(localProofIdentity, forKey: .localProofIdentity)
    try c.encode(accountProofIdentity, forKey: .accountProofIdentity)
  }
}

public struct AppleAccessObservation: Encodable {
  public struct Right: Encodable {
    public let localRight: String
    public let ownershipRevision: Int
    public let verifiedAt: Int
    public let expiresAt: Int
    public let localProofIdentity: String
    public let status: String
  }
  public let schema = 1
  public let generation: Int
  public let rights: [Right]
}

/// Native StoreKit observation only; never accepted from a bridge request.
public enum NativeAppleOwnershipObservation {
  case noPurchases, purchaseHistory, unknown
  case verifiedRevocations([NativeVerifiedAppleRevocation])
  var evidenceStatus: String {
    if case .noPurchases = self { return "none" }
    return "unknown"
  }
}

/// Which Safari a build serves. Compile-time and deterministic: never the user agent, the page
/// layout or a screen size. macOS Safari gets the sites' desktop layouts; iPhone and iPad Safari
/// may get phone layouts, so the desktop-layout-only extras are never offered there.
public enum SafariAccessPlatform {
  case mac, mobile
  public static var current: SafariAccessPlatform {
    #if os(macOS)
    return .mac
    #else
    return .mobile
    #endif
  }
}

/// The Safari capability gate, per Apple platform; signed claims may cover more benefits. It must
/// equal packages/core accessCapabilities for host "safari" with platform "desktop" (mac) and
/// "ios" (mobile): packages/shared-types/fixtures/access-capabilities.json.
public enum NativeAppleAccessCapabilities {
  /// Extras with an observed phone-layout structure or no layout dependence (iPhone/iPad Safari).
  public static let safariPro = [
    "instagram.explore", "instagram.stories", "instagram.suggested", "instagram.threads",
    "youtube.related", "youtube.comments", "youtube.autoplay",
    "facebook.stories", "facebook.videos"
  ]
  /// Extras that act only on the desktop layouts macOS Safari loads (access-policy.ts
  /// DESKTOP_LAYOUT_ONLY_PRO): end cards, live chat and the desktop right-column ads.
  public static let safariDesktopLayoutPro = ["youtube.endscreen", "youtube.livechat", "facebook.sponsored"]
  public static func pro(for platform: SafariAccessPlatform) -> [String] {
    platform == .mac ? safariPro + safariDesktopLayoutPro : safariPro
  }
  public static func supported(paidMode: Bool, platform: SafariAccessPlatform = .current) -> Set<String> {
    Set(PackagedFeatureRegistry.features.filter { $0.tier == "free" }.map { $0.id } +
      [PackagedFeatureRegistry.tiktokAlias] + (paidMode ? pro(for: platform) : []))
  }
}

/// Built only from a StoreKit-verified transaction with a real revocation date. No JS DTO
/// can construct this evidence or nominate which server right to revoke.
public struct NativeVerifiedAppleRevocation {
  public let identity: NativeVerifiedApplePurchase
  public let revokedAt: Int
  public init(identity: NativeVerifiedApplePurchase, revokedAt: Int) {
    self.identity = identity; self.revokedAt = revokedAt
  }
}
