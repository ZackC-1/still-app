import Foundation

/// Produced only by native's compiled authenticated endpoint, never a JS-supplied snapshot.
public struct NativeAccountAccessSnapshot {
  let holder: String
  let accountStatus: String
  let issuerTime: Int
  let proofs: [VerifiedAccessProof]
  let revocations: [AccessRevocation]

  static func parse(_ data: Data, trust: AccessTrust, holder: String) throws -> Self {
    guard data.count <= 131_072, accessUUID(holder), !trust.keys.isEmpty, try uniqueAccountJSONMembers(data),
      let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      !AtomicSettingsRecord.keyCollision(body),
      Set(body.keys).isSubset(of: ["access", ApplePurchaseCatalog.historicalStillSync.entitlementID]),
      let access = body["access"] as? [String: Any],
      Set(access.keys) == ["status", "environment", "proofs", "revocations", "issuer_time"],
      let status = access["status"] as? String, ["verified", "none", "conflict", "unavailable"].contains(status),
      access["environment"] as? String == trust.environment,
      let issuer = accountInteger(access["issuer_time"]),
      let envelopes = access["proofs"] as? [String], envelopes.count <= 16,
      let removals = access["revocations"] as? [[String: Any]], removals.count <= 64
    else { throw AccessProofFailure.verificationRequired }
    if let value = body[ApplePurchaseCatalog.historicalStillSync.entitlementID] {
      guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw AccessProofFailure.invalid }
    }
    guard (status == "verified" && !envelopes.isEmpty) || status == "conflict" || (["none", "unavailable"].contains(status) && envelopes.isEmpty) else { throw AccessProofFailure.invalid }
    let proofs = try envelopes.map { try VerifiedAccessProof.verify($0, trust: trust) }
    guard Set(proofs.map { $0.claims.right }).count == proofs.count,
      proofs.allSatisfy({ $0.claims.kind == "paid_account" && $0.claims.holder == holder &&
        $0.claims.verified_at <= issuer && ($0.claims.expires_at ?? 0) > issuer })
    else { throw AccessProofFailure.invalid }
    let revocations = try removals.map { value -> AccessRevocation in
      guard Set(value.keys) == ["right", "revision"], let right = value["right"] as? String,
        accessUUID(right), let revision = accountInteger(value["revision"])
      else { throw AccessProofFailure.invalid }
      return AccessRevocation(right: right, revision: revision)
    }
    guard Set(revocations.map { $0.right }).count == revocations.count,
      !proofs.contains(where: { proof in revocations.contains { $0.right == proof.claims.right && $0.revision >= proof.claims.ownership_revision } })
    else { throw AccessProofFailure.invalid }
    return Self(holder: holder, accountStatus: status, issuerTime: issuer, proofs: proofs, revocations: revocations)
  }
}

public struct NativeAccountAccessCommit: Codable {
  public let schema = 1
  public let status = "committed"
  /// Durable removals can commit even when the account's current authority is unavailable.
  public let accountStatus: String
  public let generation: Int
  public let accountId: String
  public let sessionId: String
  public let issuerTime: Int
  public let proofIdentities: [String]
}

/// Only complete code-signed trust/Auth/profile configuration creates a network consumer.
public final class NativeAccountAccessRuntime {
  private let endpoint: URL
  private let publicKey: String
  private let trust: AccessTrust
  private let transport: ProductPolicyTransport
  public init?(info: [String: Any] = Bundle.main.infoDictionary ?? [:], transport: ProductPolicyTransport = URLSessionPolicyTransport()) {
    let trust = NativeAccessConfiguration.trust(info: info)
    guard let profile = NativeAccessConfiguration.backendRouteProfile(info: info), !trust.keys.isEmpty,
      NativeAccessConfiguration.sessionVerifier(info: info) != nil,
      let text = info["StillAccessSupabaseURL"] as? String, let origin = URL(string: text),
      let publicKey = info["StillAccessSupabasePublishableKey"] as? String
    else { return nil }
    endpoint = origin.appendingPathComponent(profile == .production ? "functions/v1/reconcile-entitlement" : "functions/v1/qa-sandbox-reconcile-entitlement")
    self.publicKey = publicKey; self.trust = trust; self.transport = transport
  }
  public func fetch(accessToken: String, session: VerifiedNativeAccessSession) async throws -> NativeAccountAccessSnapshot {
    guard !accessToken.isEmpty, accessToken.utf8.count <= 16_384 else { throw AccessProofFailure.invalid }
    var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 5)
    request.httpMethod = "POST"; request.httpShouldHandleCookies = false
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer " + accessToken, forHTTPHeaderField: "Authorization")
    request.setValue(publicKey, forHTTPHeaderField: "apikey")
    request.httpBody = Data("{\"access_schema\":1}".utf8)
    let reply = try await transport.send(request, maxBytes: 131_072)
    guard reply.status == 200 else { throw AccessProofFailure.verificationRequired }
    return try NativeAccountAccessSnapshot.parse(reply.body, trust: trust, holder: session.accountId)
  }
}

private func accountInteger(_ raw: Any?) -> Int? {
  guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
    let integer = Int(exactly: value), accessInteger(integer) else { return nil }
  return integer
}

/// Foundation discards duplicate object members. Scan validated JSON tokens, including escaped
/// strings, and reject duplicate decoded member names before any unsigned canonical removal.
private func uniqueAccountJSONMembers(_ data: Data) throws -> Bool {
  guard let text = String(data: data, encoding: .utf8) else { return false }
  let pattern = try NSRegularExpression(pattern: #""(?:[^"\\]|\\.)*"|[{}\[\]:,]"#)
  let matches = pattern.matches(in: text, range: NSRange(text.startIndex..., in: text))
  var objects: [Set<String>?] = []
  for (index, match) in matches.enumerated() {
    guard let range = Range(match.range, in: text) else { return false }
    let token = String(text[range])
    if token == "{" { guard objects.count < 5 else { return false }; objects.append([]) }
    else if token == "[" { guard objects.count < 5 else { return false }; objects.append(nil) }
    else if token == "}" || token == "]" { guard !objects.isEmpty else { return false }; objects.removeLast() }
    else if token.hasPrefix("\""), index + 1 < matches.count,
      let next = Range(matches[index + 1].range, in: text), text[next] == ":" {
      guard !objects.isEmpty, var keys = objects.last!,
        let values = try JSONSerialization.jsonObject(with: Data(("[" + token + "]").utf8)) as? [String], let key = values.first,
        keys.insert(key).inserted else { return false }
      objects[objects.count - 1] = keys
    }
  }
  return objects.isEmpty
}

