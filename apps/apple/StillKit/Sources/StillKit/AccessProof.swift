import Foundation
import CryptoKit

public enum AccessProofFailure: Error { case invalid, unsupported, verificationRequired }
public let paidAccessWindowMilliseconds = 2_592_000_000
public let stillProV3Benefits = [
  "facebook.sponsored", "facebook.stories", "facebook.videos",
  "instagram.explore", "instagram.stories", "instagram.suggested", "instagram.threads",
  "youtube.autoplay", "youtube.comments", "youtube.endscreen", "youtube.livechat", "youtube.related"
]

public struct AccessTrust {
  public struct Key {
    public let kid: String
    public let publicKey: Data
    public let environment: String
    public init(kid: String, publicKey: Data, environment: String) {
      self.kid = kid; self.publicKey = publicKey; self.environment = environment
    }
  }
  public let environment: String
  public let keys: [Key]
  public let protectedProduct: String?
  public let protectedBenefits: [String]
  public init(environment: String, keys: [Key], protectedProduct: String? = nil, protectedBenefits: [String] = []) {
    self.environment = environment; self.keys = keys
    self.protectedProduct = protectedProduct; self.protectedBenefits = protectedBenefits
  }
}

public struct AccessClaims: Codable, Equatable {
  public let schema: Int
  public let issuer: String
  public let environment: String
  public let audience: String
  public let kind: String
  public let provenance: String
  public let right: String
  public let holder: String
  public let product: String
  public let benefits: [String]
  public let ownership_revision: Int
  public let verified_at: Int
  public let expires_at: Int?
  public var isPaid: Bool { kind == "paid_account" || kind == "paid_apple_local" }
  public var isAccount: Bool { kind == "paid_account" || kind == "protected_account" }

  public func canonical() -> String {
    let quotedBenefits = benefits.map { "\"\($0)\"" }.joined(separator: ",")
    let base = "{\"schema\":\(schema),\"issuer\":\"\(issuer)\",\"environment\":\"\(environment)\",\"audience\":\"\(audience)\",\"kind\":\"\(kind)\",\"provenance\":\"\(provenance)\",\"right\":\"\(right)\",\"holder\":\"\(holder)\",\"product\":\"\(product)\",\"benefits\":[\(quotedBenefits)],\"ownership_revision\":\(ownership_revision),\"verified_at\":\(verified_at)"
    return base + (isPaid ? ",\"expires_at\":\(expires_at ?? -1)}" : "}")
  }
}

/// Construction is restricted to the cryptographic verifier; no Boolean/receipt stamp becomes
/// a paid proof. Holder matching additionally requires current account or verified native mapping.
public struct VerifiedAccessProof {
  public let claims: AccessClaims
  public let envelope: String
  public let identity: String
  private init(claims: AccessClaims, envelope: String, identity: String) {
    self.claims = claims; self.envelope = envelope; self.identity = identity
  }

  @available(macOS 10.15, *)
  public static func verify(_ text: String, trust: AccessTrust) throws -> VerifiedAccessProof {
    guard text.utf8.count <= 6_144, !text.contains("\\"), let bytes = text.data(using: .utf8),
      let raw = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      Set(raw.keys) == Set(["payload", "kid", "alg", "signature"]),
      let payloadText = raw["payload"] as? String, let kid = raw["kid"] as? String,
      raw["alg"] as? String == "ed25519", let signatureText = raw["signature"] as? String,
      matches(kid, "^[a-z0-9][a-z0-9._-]{0,95}$") else { throw AccessProofFailure.invalid }
    // JSONSerialization otherwise loses duplicate members. Closed envelope values are ASCII
    // strings without escapes; enumerate original members and require each allowed key once.
    let regex = try NSRegularExpression(pattern: #""([A-Za-z_]+)"\s*:\s*"([A-Za-z0-9_.-]+)""#)
    let members = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
    let keys = members.compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } }
    guard members.count == 4, Set(keys).count == 4, Set(keys) == Set(raw.keys),
      let payload = decodeBase64(payloadText, maximum: 4_096),
      let signature = decodeBase64(signatureText, maximum: 64), signature.count == 64,
      let key = trust.keys.first(where: { $0.kid == kid && $0.environment == trust.environment }), key.publicKey.count == 32,
      let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: key.publicKey),
      let decoded = String(data: payload, encoding: .utf8) else { throw AccessProofFailure.invalid }
    let signingBytes = Data(("still-access-proof-v1\n" + decoded).utf8)
    guard publicKey.isValidSignature(signature, for: signingBytes),
      let dictionary = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else { throw AccessProofFailure.invalid }
    if let schema = dictionary["schema"] as? NSNumber, schema.intValue > 1 { throw AccessProofFailure.unsupported }
    let claims = try JSONDecoder().decode(AccessClaims.self, from: payload)
    let baseKeys = ["schema", "issuer", "environment", "audience", "kind", "provenance", "right", "holder", "product", "benefits", "ownership_revision", "verified_at"]
    let allowedPairs: [String: [String]] = [
      "paid_account": ["provider_verified", "owner_attested_legacy_paid"], "paid_apple_local": ["provider_verified"],
      "protected_local": ["legacy_free_verified"], "protected_account": ["legacy_free_verified", "free_self_declaration"]
    ]
    let allBenefits = Set(stillProV3Benefits + ["youtube.shorts", "instagram.reels", "facebook.reels", "tiktok.all"])
    guard claims.schema == 1, claims.issuer == "still-access", claims.environment == trust.environment,
      ["production", "sandbox"].contains(claims.environment), claims.audience == "still-app",
      allowedPairs[claims.kind]?.contains(claims.provenance) == true,
      Set(dictionary.keys) == Set(baseKeys + (claims.isPaid ? ["expires_at"] : [])),
      accessUUID(claims.right), accessUUID(claims.holder), accessInteger(claims.ownership_revision), accessInteger(claims.verified_at),
      matches(claims.product, "^[a-z0-9][a-z0-9._-]{0,95}$"), !claims.benefits.isEmpty, claims.benefits.count <= 32,
      claims.benefits == claims.benefits.sorted(), Set(claims.benefits).count == claims.benefits.count,
      claims.benefits.allSatisfy({ allBenefits.contains($0) }), claims.canonical() == decoded else { throw AccessProofFailure.invalid }
    if claims.isPaid {
      guard let expiry = claims.expires_at, accessInteger(expiry), expiry == claims.verified_at + paidAccessWindowMilliseconds,
        claims.product == "still-pro-v3", claims.benefits.allSatisfy({ stillProV3Benefits.contains($0) }) else { throw AccessProofFailure.invalid }
    } else {
      guard let product = trust.protectedProduct else { throw AccessProofFailure.verificationRequired }
      guard claims.product == product, claims.benefits.allSatisfy({ trust.protectedBenefits.contains($0) }) else { throw AccessProofFailure.invalid }
    }
    let identity = kid + ":" + signature.map { String(format: "%02x", $0) }.joined()
    return VerifiedAccessProof(claims: claims, envelope: text, identity: identity)
  }

  public func matchesHolder(accountId: String?, localRights: Set<String>) -> Bool {
    claims.isAccount ? accountId == claims.holder : claims.holder == claims.right && localRights.contains(claims.right)
  }
}

private func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
func accessInteger(_ value: Int) -> Bool { value >= 0 && value <= 9_007_199_254_740_991 }
func accessUUID(_ value: String) -> Bool { matches(value, "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$") }
private func decodeBase64(_ text: String, maximum: Int) -> Data? {
  guard text.utf8.count <= (maximum * 4 + 2) / 3, matches(text, "^[A-Za-z0-9_-]+$"), text.count % 4 != 1 else { return nil }
  let padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - text.count % 4) % 4)
  guard let data = Data(base64Encoded: padded), data.count <= maximum,
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == text else { return nil }
  return data
}

public struct PaidAccessClock: Codable, Equatable {
  public let proofIdentity: String
  public let verifiedAt: Int
  public let expiresAt: Int
  public let issuerTimeAtReceipt: Int
  public let wallAtReceipt: Int
  public var highWater: Int
  public var lastWall: Int
  public var expired: Bool
  public var revoked: Bool
  public var paused: Bool

  public static func install(_ proof: VerifiedAccessProof, issuerNow: Int, wall: Int) throws -> PaidAccessClock {
    guard proof.claims.isPaid, accessInteger(issuerNow), accessInteger(wall), issuerNow >= proof.claims.verified_at,
      let expiry = proof.claims.expires_at else { throw AccessProofFailure.invalid }
    return PaidAccessClock(proofIdentity: proof.identity, verifiedAt: proof.claims.verified_at, expiresAt: expiry,
      issuerTimeAtReceipt: issuerNow, wallAtReceipt: wall, highWater: issuerNow, lastWall: wall,
      expired: issuerNow >= expiry, revoked: false, paused: false)
  }

  public mutating func observe(_ proof: VerifiedAccessProof, wall: Int, runningEstimate: Int? = nil) -> Bool {
    guard [verifiedAt, expiresAt, issuerTimeAtReceipt, wallAtReceipt, highWater, lastWall].allSatisfy(accessInteger),
      proofIdentity == proof.identity, verifiedAt == proof.claims.verified_at, expiresAt == proof.claims.expires_at,
      expiresAt - verifiedAt == paidAccessWindowMilliseconds,
      issuerTimeAtReceipt >= verifiedAt, highWater >= issuerTimeAtReceipt, lastWall >= wallAtReceipt,
      !expired, !revoked, !paused else { return false }
    guard accessInteger(wall), wall >= lastWall, runningEstimate.map(accessInteger) ?? true else { paused = true; return false }
    // All operands are safe JS integers; their sum remains within Int64. Reject an unsafe result.
    let effective = max(highWater, issuerTimeAtReceipt + wall - wallAtReceipt, runningEstimate ?? 0)
    guard accessInteger(effective), effective >= verifiedAt else { paused = true; return false }
    highWater = effective; lastWall = wall; expired = effective >= expiresAt
    return !expired
  }
}

public struct CachedAccessRight: Codable, Equatable {
  public let envelope: String
  public var clock: PaidAccessClock?
  public let accountGeneration: Int?
  private enum CodingKeys: String, CodingKey { case envelope, clock, accountGeneration }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(envelope, forKey: .envelope)
    // The shared TS record grammar requires an explicit null for permanent rights. Synthesized
    // encodeIfPresent would omit these members and turn a valid native read into recovery.
    try c.encode(clock, forKey: .clock)
    try c.encode(accountGeneration, forKey: .accountGeneration)
  }
}
public struct AccessRevocation: Codable, Equatable { public let right: String; public let revision: Int }
public struct AccessCacheRecord: Codable, Equatable {
  public var schema = 1
  public var accountId: String?
  public var generation = 0
  public var sessionId: String?
  public var localProtectionUnavailable = false
  public var rights: [CachedAccessRight] = []
  public var revocations: [AccessRevocation] = []
  public var localProtection: LocalProtectionRecord?
  public init() {}
  private enum CodingKeys: String, CodingKey { case schema, accountId, generation, sessionId, rights, revocations, localProtection }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    schema = try c.decode(Int.self, forKey: .schema)
    accountId = try c.decodeIfPresent(String.self, forKey: .accountId)
    generation = try c.decode(Int.self, forKey: .generation)
    sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
    rights = try c.decode([CachedAccessRight].self, forKey: .rights)
    revocations = try c.decode([AccessRevocation].self, forKey: .revocations)
    if c.contains(.localProtection), !(try c.decodeNil(forKey: .localProtection)) {
      localProtection = try? c.decode(LocalProtectionRecord.self, forKey: .localProtection)
      localProtectionUnavailable = !(localProtection?.valid ?? false)
      if localProtectionUnavailable { localProtection = nil }
    }
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(schema, forKey: .schema); try c.encode(accountId, forKey: .accountId)
    try c.encode(generation, forKey: .generation); try c.encodeIfPresent(sessionId, forKey: .sessionId)
    try c.encode(rights, forKey: .rights)
    try c.encode(revocations, forKey: .revocations)
    try c.encodeIfPresent(localProtection, forKey: .localProtection)
  }
}

public enum BenefitAccess: String { case free, purchased, protected, checking, verification_required, locked, unsupported }
public struct ScopedAccessEvidence { public let proof: VerifiedAccessProof; public let validPaid: Bool; public let revoked: Bool }
public func resolveBenefitAccess(_ benefit: String, evidence: [ScopedAccessEvidence], paidMode: Bool,
  supported: Bool, free: Bool, accountId: String?, localRights: Set<String>, evidenceStatus: String, localProtection: LocalProtectionRecord? = nil) -> BenefitAccess {
  if !supported { return .unsupported }
  if !paidMode || free { return .free }
  var unresolved = false; var protectedRight = false
  for item in evidence where item.proof.matchesHolder(accountId: accountId, localRights: localRights) && !item.revoked && item.proof.claims.benefits.contains(benefit) {
    if item.proof.claims.isPaid { if item.validPaid { return .purchased }; unresolved = true }
    else { protectedRight = true }
  }
  if let local = localProtection {
    if !local.valid { unresolved = true }
    else if local.grant?.benefits.contains(benefit) == true { protectedRight = true }
    else if local.grant == nil { unresolved = true }
  }
  if protectedRight { return .protected }
  if unresolved || evidenceStatus == "unknown" { return .verification_required }
  return evidenceStatus == "checking" ? .checking : .locked
}

/// Native host context only. No request body carries account, transaction mapping, time or mode.
/// Missing verified session/local mapping stays unknown; SDK/receipt Booleans cannot fill it.
public struct NativeAccessContext {
  public let paidMode: Bool
  public let supported: Set<String>
  public let accountId: String?
  public let sessionId: String?
  public let sessionKnown: Bool
  public let localRights: Set<String>
  public let evidenceStatus: String
  public init(paidMode: Bool = MonetizationConfig.paidTierEnabled,
              supported: Set<String> = Set(PackagedFeatureRegistry.features.filter { $0.tier == "free" }.map { $0.id } + [PackagedFeatureRegistry.tiktokAlias]),
              accountId: String? = nil, sessionId: String? = nil, sessionKnown: Bool = false,
              localRights: Set<String> = [], evidenceStatus: String = "unknown") {
    self.paidMode = paidMode; self.supported = supported
    self.accountId = accountId; self.sessionId = sessionId; self.sessionKnown = sessionKnown
    self.localRights = localRights; self.evidenceStatus = evidenceStatus
  }
}
public struct BenefitAccessSnapshot: Encodable {
  public let schema = 1
  public let generation: Int
  public let states: [String: String]
  public let refreshAfterMs: Int?
  public let independentProtection: [String]
  private enum CodingKeys: String, CodingKey { case schema, generation, states, refreshAfterMs, independentProtection }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(schema, forKey: .schema); try c.encode(generation, forKey: .generation)
    try c.encode(states, forKey: .states); try c.encode(refreshAfterMs, forKey: .refreshAfterMs)
    try c.encode(independentProtection, forKey: .independentProtection)
  }
}
func resolveAccessSnapshot(_ record: AccessCacheRecord, evidence: [ScopedAccessEvidence], context: NativeAccessContext) -> BenefitAccessSnapshot {
  let matchingSession = context.sessionKnown && context.accountId == record.accountId && context.sessionId == record.sessionId
  let status = record.localProtectionUnavailable || evidence.count != record.rights.count ? "unknown" : context.evidenceStatus
  var states: [String: String] = [:]
  for feature in PackagedFeatureRegistry.features {
    states[feature.id] = resolveBenefitAccess(feature.id, evidence: evidence, paidMode: context.paidMode,
      supported: context.supported.contains(feature.id), free: feature.tier == "free",
      accountId: matchingSession ? context.accountId : nil, localRights: context.localRights,
      evidenceStatus: status, localProtection: record.localProtection).rawValue
  }
  let tiktok = PackagedFeatureRegistry.tiktokAlias
  states[tiktok] = resolveBenefitAccess(tiktok, evidence: evidence, paidMode: context.paidMode,
    supported: context.supported.contains(tiktok), free: true, accountId: nil, localRights: [], evidenceStatus: status).rawValue
  var delay: Int? = context.paidMode ? 60_000 : nil
  if context.paidMode {
    for right in record.rights {
      if let clock = right.clock, !clock.expired && !clock.paused && !clock.revoked,
        accessInteger(clock.highWater), accessInteger(clock.expiresAt) {
        delay = min(delay ?? 60_000, max(1, clock.expiresAt - clock.highWater))
      }
    }
  }
  let local = evidence.filter { $0.proof.claims.kind == "protected_local" }
  let independent = (PackagedFeatureRegistry.featureIDs + [PackagedFeatureRegistry.tiktokAlias]).filter { benefit in
    ["purchased", "protected"].contains(states[benefit] ?? "") && resolveBenefitAccess(benefit, evidence: local,
      paidMode: true, supported: context.supported.contains(benefit), free: false, accountId: nil,
      localRights: context.localRights, evidenceStatus: "unknown", localProtection: record.localProtection) == .protected
  }
  return BenefitAccessSnapshot(generation: record.generation, states: states, refreshAfterMs: delay, independentProtection: independent)
}
