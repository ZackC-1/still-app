import Foundation

private struct ProtectionKey: CodingKey {
  var stringValue: String
  var intValue: Int? { nil }
  init?(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { return nil }
}
private func protectionKeys(_ decoder: Decoder, _ expected: [String]) throws {
  let keys = try decoder.container(keyedBy: ProtectionKey.self).allKeys.map(\.stringValue)
  guard Set(keys) == Set(expected) else { throw AccessProofFailure.invalid }
}
private func protectionVersion(_ value: String) -> Bool {
  value.range(of: #"^\d{1,9}(?:\.\d{1,9}){0,3}$"#, options: .regularExpression) != nil
}
private func protectionSnapshot(_ product: String, _ benefits: [String]) -> Bool {
  let known = Set(PackagedFeatureRegistry.featureIDs + [PackagedFeatureRegistry.tiktokAlias])
  return product != "still-pro-v3" && product.range(of: "^[a-z0-9][a-z0-9._-]{0,95}$", options: .regularExpression) != nil &&
    !benefits.isEmpty && benefits.count <= 32 && benefits == benefits.sorted() && Set(benefits).count == benefits.count && benefits.allSatisfy(known.contains)
}

/// Construct only from packaged/authenticated CP109 functional policy. Not Codable, and never
/// accepted from a caller's runtime message. No production cutoff is configured by this slice.
public struct LocalProtectionCutoff {
  public let product: String
  public let benefits: [String]
  public let activatedAt: Int
  public init(product: String, benefits: [String], activatedAt: Int) throws {
    guard activatedAt > 0, accessInteger(activatedAt), protectionSnapshot(product, benefits) else { throw AccessProofFailure.invalid }
    self.product = product; self.benefits = benefits; self.activatedAt = activatedAt
  }
}
public struct LocalProtectionOriginal: Codable, Equatable, Sendable {
  public let firstRecordedAt: Int
  public let firstRecordedAppVersion: String
  private enum CodingKeys: String, CodingKey { case firstRecordedAt, firstRecordedAppVersion }
  init(firstRecordedAt: Int, firstRecordedAppVersion: String) {
    self.firstRecordedAt = firstRecordedAt; self.firstRecordedAppVersion = firstRecordedAppVersion
  }
  public init(from decoder: Decoder) throws {
    try protectionKeys(decoder, ["firstRecordedAt", "firstRecordedAppVersion"])
    let c = try decoder.container(keyedBy: CodingKeys.self)
    firstRecordedAt = try c.decode(Int.self, forKey: .firstRecordedAt)
    firstRecordedAppVersion = try c.decode(String.self, forKey: .firstRecordedAppVersion)
    guard valid else { throw AccessProofFailure.invalid }
  }
  var valid: Bool { firstRecordedAt > 0 && accessInteger(firstRecordedAt) && protectionVersion(firstRecordedAppVersion) }
}
public enum OriginalProtectionEvidence: Equatable {
  case absent, unreadable, unsupported
  case legacy(LocalProtectionOriginal)
}

private struct OriginalProtectionPayload: Decodable {
  let schemaVersion: Int?
  let firstRecordedAt: Date
  let firstRecordedAppVersion: String
}
/// Foundation's retained Date is seconds from 2001, unlike the browser's UTC milliseconds.
/// Normalize only this assessment projection; never rewrite the source data or use optional
/// cached Apple version/date fields as independently verified store evidence.
public func assessOriginalProtection(_ data: Data?) -> OriginalProtectionEvidence {
  guard let data = data else { return .absent }
  do {
    let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    guard let raw = raw else { return .unreadable }
    if let schema = raw["schemaVersion"] {
      guard !(schema is NSNull), let number = schema as? NSNumber,
        String(cString: number.objCType) != "c", number.doubleValue.rounded(.towardZero) == number.doubleValue,
        number.doubleValue >= 1, number.doubleValue <= 9_007_199_254_740_991 else { return .unreadable }
      if number.intValue != 1 { return .unsupported }
    }
    let payload = try JSONDecoder().decode(OriginalProtectionPayload.self, from: data)
    let milliseconds = payload.firstRecordedAt.timeIntervalSince1970 * 1000
    guard milliseconds.isFinite, milliseconds > 0, milliseconds <= 9_007_199_254_740_991 else { return .unreadable }
    let original = LocalProtectionOriginal(firstRecordedAt: Int(milliseconds.rounded(.down)), firstRecordedAppVersion: payload.firstRecordedAppVersion)
    return original.valid ? .legacy(original) : .unreadable
  } catch { return .unreadable }
}

public struct LocalProtectionGrant: Codable, Equatable, Sendable {
  public let product: String
  public let benefits: [String]
  public let activatedAt: Int
  private enum CodingKeys: String, CodingKey { case product, benefits, activatedAt }
  init(_ cutoff: LocalProtectionCutoff) {
    product = cutoff.product; benefits = cutoff.benefits; activatedAt = cutoff.activatedAt
  }
  public init(from decoder: Decoder) throws {
    try protectionKeys(decoder, ["product", "benefits", "activatedAt"])
    let c = try decoder.container(keyedBy: CodingKeys.self)
    product = try c.decode(String.self, forKey: .product); benefits = try c.decode([String].self, forKey: .benefits)
    activatedAt = try c.decode(Int.self, forKey: .activatedAt)
    guard valid else { throw AccessProofFailure.invalid }
  }
  var valid: Bool { activatedAt > 0 && accessInteger(activatedAt) && protectionSnapshot(product, benefits) }
}
/// Honest unsigned nonexclusive protection; no account/email/device identity, paid proof or TTL.
public struct LocalProtectionRecord: Codable, Equatable, Sendable {
  public let schema: Int
  public let provenance: String
  public let original: LocalProtectionOriginal?
  public let grant: LocalProtectionGrant?
  private enum CodingKeys: String, CodingKey { case schema, provenance, original, grant }
  init(provenance: String, original: LocalProtectionOriginal?, grant: LocalProtectionGrant?) {
    schema = 1; self.provenance = provenance; self.original = original; self.grant = grant
  }
  public init(from decoder: Decoder) throws {
    try protectionKeys(decoder, ["schema", "provenance", "original", "grant"])
    let c = try decoder.container(keyedBy: CodingKeys.self)
    schema = try c.decode(Int.self, forKey: .schema); provenance = try c.decode(String.self, forKey: .provenance)
    original = try c.decodeIfPresent(LocalProtectionOriginal.self, forKey: .original)
    grant = try c.decodeIfPresent(LocalProtectionGrant.self, forKey: .grant)
    guard valid else { throw AccessProofFailure.invalid }
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(schema, forKey: .schema); try c.encode(provenance, forKey: .provenance)
    try c.encode(original, forKey: .original); try c.encode(grant, forKey: .grant)
  }
  var valid: Bool {
    guard schema == 1, (grant?.valid ?? true) else { return false }
    if provenance == "free_self_declaration" { return original == nil }
    return provenance == "accepted_legacy_local" && original?.valid == true && (grant.map { original!.firstRecordedAt < $0.activatedAt } ?? true)
  }
}
public enum LocalProtectionMutation {
  case assessOriginal(OriginalProtectionEvidence, cutoff: LocalProtectionCutoff?)
  case declare(confirmed: Bool, priorEvidence: String, cutoff: LocalProtectionCutoff?)
  case applyCutoff(LocalProtectionCutoff)
}
public func mutateLocalProtection(_ current: LocalProtectionRecord?, mutation: LocalProtectionMutation) throws -> LocalProtectionRecord? {
  guard current?.valid ?? true else { throw AccessProofFailure.invalid }
  var next = current
  let cutoff: LocalProtectionCutoff?
  switch mutation {
  case .assessOriginal(let evidence, let supplied):
    cutoff = supplied
    if next == nil, case .legacy(let original) = evidence {
      guard original.valid else { throw AccessProofFailure.invalid }
      next = LocalProtectionRecord(provenance: "accepted_legacy_local", original: original, grant: nil)
    }
  case .declare(let confirmed, let prior, let supplied):
    guard confirmed && prior == "absent" else { throw AccessProofFailure.invalid }
    cutoff = supplied
    if current?.grant == nil { next = LocalProtectionRecord(provenance: "free_self_declaration", original: nil, grant: nil) }
  case .applyCutoff(let supplied): cutoff = supplied
  }
  if current?.grant != nil { return current }
  guard let next = next, let cutoff = cutoff else { return next }
  if next.provenance == "accepted_legacy_local", next.original!.firstRecordedAt >= cutoff.activatedAt { return next }
  return LocalProtectionRecord(provenance: next.provenance, original: next.original, grant: LocalProtectionGrant(cutoff))
}
