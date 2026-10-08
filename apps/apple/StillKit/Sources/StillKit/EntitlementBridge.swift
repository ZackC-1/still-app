import Foundation

// The entitlement lane of the App-Group bridge. The paid "Still Pro" surfaces are applied by the
// Safari extension's content scripts, but the entitlement authority lives with the app: the
// WKWebView's SyncService reconciles it against Supabase and mirrors the result here after every
// state change. The Safari extension's background then pulls it ({kind:"getEntitlement"}) into
// browser.storage, where the content scripts' EntitlementCache reads it.
//
// Deliberately a SEPARATE App-Group key from the settings blob: settings sync is last-write-wins
// and client-writable, while the entitlement value is written only through StampPolicy from one
// of the two entitlement authorities — the app's server-reconciled state or the device's StoreKit
// receipt (ADR 0003; monetization-design §6 — never inside StillSettings). The stored `updatedAt`
// is the last time ANY authority confirmed; the extension keeps it and applies its 30-day TTL
// against it, so a device that never re-confirms downgrades to free on schedule.
//
// Wire shape:
//   web/app → native:  { "kind": "setEntitlement", "entitled": Bool }   (server-lane proposal)
//   extension → native: { "kind": "getEntitlement" }                    (read-only lane)
//   native → caller:   "{\"entitled\":Bool|null,\"installId\":String|null,
//                        \"source\":String|null,\"updatedAt\":Int|null}"
//
// The reply is an ENVELOPE with all four keys always present (explicit JSON null when absent) —
// the extension distinguishes "no entitlement record but the app has stamped this install"
// (installId set, entitled null: the post-reinstall state, issue #63) from "nothing at all"
// (old app build / degraded App Group: every field null), and ignores keys it doesn't know
// (`source` is informational on the wire). The legacy "" empty reply is gone; the extension's
// parser treats it, and any malformed reply, as no signal.
//
// Every stamp WRITE routes through StampPolicy (the R13 never-downgrade home): wire `.set`
// proposals carry the bridge's `proposalSource` lane (the webview only ever mirrors server
// state), and the native receipt restamp path enters via `applyReceipt`. A read-only bridge
// (the Safari extension handler's lane) refuses `.set` without writing — the extension process
// has no receipt oracle and must never write the stamp in either direction.

/// Which entitlement authority a stamp (or a stamp proposal) came from. Legacy build-3 records
/// carry no `source` key and decode as `.server` — the pre-migration semantics.
public enum EntitlementSource: String, Codable, Equatable, Sendable {
  case receipt
  case server
}

public struct EntitlementRecord: Codable, Equatable, Sendable {
  public let entitled: Bool
  /// Milliseconds since epoch of the last write by ANY authority (server reconcile or receipt).
  public let updatedAt: Int
  /// The authority that produced this value. Load-bearing in StampPolicy's downgrade lanes.
  public let source: EntitlementSource

  public init(entitled: Bool, updatedAt: Int, source: EntitlementSource = .server) {
    self.entitled = entitled
    self.updatedAt = updatedAt
    self.source = source
  }

  private enum CodingKeys: String, CodingKey { case entitled, updatedAt, source }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    entitled = try container.decode(Bool.self, forKey: .entitled)
    updatedAt = try container.decode(Int.self, forKey: .updatedAt)
    // Absent on build-3 stamps: default to server so pre-migration downgrade semantics hold.
    source = try container.decodeIfPresent(EntitlementSource.self, forKey: .source) ?? .server
  }
}

/// The App-Group-backed entitlement store, mirroring SharedSettingsStore's backing seam so tests
/// run in-memory with `swift test`.
public final class SharedEntitlementStore {
  private let backing: SettingsBacking
  private let coordinationAvailable: Bool
  private let trust: AccessTrust
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(backing: SettingsBacking, coordinationAvailable: Bool = true,
              trust: AccessTrust = .compiled) {
    self.backing = backing
    self.coordinationAvailable = coordinationAvailable
    self.trust = trust
  }

  public func peek() -> EntitlementRecord? {
    guard let data = backing.read(),
          let record = try? decoder.decode(EntitlementRecord.self, from: data)
    else { return nil }
    return record
  }

  public func save(_ record: EntitlementRecord) {
    _ = try? backing.transaction { data in data = try preserving(record, over: data) }
  }

  /// Policy and the record read/write share the actual cross-process lock. A stale host cannot
  /// overwrite another process's independent rights/time/latches while publishing a legacy stamp.
  func apply(_ proposed: EntitlementRecord, receipt: ReceiptStatus) {
    _ = try? backing.transaction { data in
      let current = data.flatMap { try? decoder.decode(EntitlementRecord.self, from: $0) }
      if case .write(let record) = StampPolicy.decide(proposed: proposed, receipt: receipt, current: current) {
        data = try preserving(record, over: data)
      }
    }
  }

  private func preservingObject(_ data: Data?) throws -> [String: Any] {
    guard let data else { return [:] }
    let raw = try JSONSerialization.jsonObject(with: data)
    // Inspect Foundation before Swift String equality can collapse opaque encoded names.
    // Reuse only the raw check, not settings schema, depth or byte limits.
    guard !AtomicSettingsRecord.keyCollision(raw), let object = raw as? [String: Any] else { throw AccessProofFailure.invalid }
    return object
  }

  private func preserving(_ record: EntitlementRecord, over data: Data?) throws -> Data {
    var object = try preservingObject(data)
    if let access = object["access"] { _ = try decodeAccess(access) }
    object["entitled"] = record.entitled; object["updatedAt"] = record.updatedAt; object["source"] = record.source.rawValue
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }

  private func decodeAccess(_ object: Any) throws -> AccessCacheRecord {
    let result = try decoder.decode(AccessCacheRecord.self, from: JSONSerialization.data(withJSONObject: object))
    guard result.schema == 1, accessInteger(result.generation), result.accountId.map(accessUUID) ?? true, result.sessionId.map(accessUUID) ?? true,
      result.rights.count <= 32, result.revocations.count <= 64, result.appleBindings.count <= 32,
      result.appleBindings.allSatisfy({ !$0.envelope.isEmpty && $0.envelope.utf8.count <= 6_144 && !$0.localProofIdentity.isEmpty && $0.localProofIdentity.utf8.count <= 256 }),
      result.rights.allSatisfy({ $0.envelope.utf8.count <= 6_144 && ($0.accountGeneration.map(accessInteger) ?? true) }),
      result.revocations.allSatisfy({ accessUUID($0.right) && accessInteger($0.revision) }) else { throw AccessProofFailure.invalid }
    return result
  }

  /// A complete scoped entitlement record commits before the caller can publish modern access.
  /// No separate cache or lock is introduced. Throws preserve the original durable bytes.
  // Clock-producing autoclosures on the public access operations are evaluated inside this
  // transaction, so a queued reader cannot persist an earlier wall after another process.
  private func transactionAccess<T>(_ body: (inout AccessCacheRecord) throws -> T) throws -> T {
    guard coordinationAvailable else { throw AccessProofFailure.verificationRequired }
    return try backing.transaction { data in
      guard data.map({ $0.count <= 131_072 }) ?? true else { throw AccessProofFailure.verificationRequired }
      var object = try preservingObject(data)
      var record = try object["access"].map(decodeAccess) ?? AccessCacheRecord()
      let result = try body(&record)
      let encoded = try JSONSerialization.jsonObject(with: encoder.encode(record)) as? [String: Any] ?? [:]
      var access = object["access"] as? [String: Any] ?? [:]
      for (key, value) in encoded {
        if let values = value as? [[String: Any]], ["rights", "revocations", "appleBindings"].contains(key) {
          var old = access[key] as? [[String: Any]] ?? []
          let identity = key == "revocations" ? "right" : "envelope"
          access[key] = values.map { replacement in
            let index = old.firstIndex { ($0[identity] as? String) == (replacement[identity] as? String) }
            let prior = index.map { old.remove(at: $0) }
            return Self.overlay(replacement, over: prior)
          }
        } else { access[key] = Self.overlay(value, over: access[key]) }
      }
      object["access"] = access
      let complete = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
      guard complete.count <= 131_072 else { throw AccessProofFailure.verificationRequired }
      data = complete
      return result
    }
  }

  // Overlay only fields emitted by the maintained typed record. Unknown nested members and raw
  // envelopes remain associated with the same right; removing a right still removes that row.
  private static func overlay(_ replacement: Any, over old: Any?) -> Any {
    guard let fields = replacement as? [String: Any], var complete = old as? [String: Any] else { return replacement }
    for (key, value) in fields { complete[key] = overlay(value, over: complete[key]) }
    return complete
  }

  /// Internal host action only; no extension bridge route accepts declaration/policy fields.
  public func mutateLocalProtection(_ mutation: LocalProtectionMutation) throws -> AccessCacheRecord {
    try transactionAccess { record in
      guard !record.localProtectionUnavailable else { throw AccessProofFailure.verificationRequired }
      record.localProtection = try StillKit.mutateLocalProtection(record.localProtection, mutation: mutation)
      return record
    }
  }

  public func changeAccessAccount(_ accountId: String?) throws -> AccessCacheRecord {
    guard #available(macOS 10.15, *) else { throw AccessProofFailure.verificationRequired }
    return try transactionAccess { record in
      guard accountId.map(accessUUID) ?? true, record.generation < 9_007_199_254_740_991 else { throw AccessProofFailure.invalid }
      record.accountId = accountId; record.sessionId = nil; record.generation += 1
      record.rights = record.rights.filter {
        guard let proof = try? VerifiedAccessProof.verify($0.envelope, trust: trust) else { return true }
        return !proof.claims.isAccount
      }
      return record
    }
  }

  /// Internal authoritative online lane only. This is not reachable from a raw extension request.
  public func installAccess(_ proof: VerifiedAccessProof, generation: Int, issuerNow: Int, wall: @autoclosure () -> Int,
                            localRights: Set<String>) throws -> AccessCacheRecord {
    guard #available(macOS 10.15, *) else { throw AccessProofFailure.verificationRequired }
    return try transactionAccess { record in
      let wall = wall()
      let checked = try VerifiedAccessProof.verify(proof.envelope, trust: trust)
      guard generation == record.generation, checked.matchesHolder(accountId: record.accountId, localRights: localRights),
        !record.revocations.contains(where: { $0.right == checked.claims.right && $0.revision >= checked.claims.ownership_revision }),
        !accountRevoked(checked, record: record) else { throw AccessProofFailure.invalid }
      let existing = record.rights.compactMap { cached -> (CachedAccessRight, VerifiedAccessProof)? in
        guard let value = try? VerifiedAccessProof.verify(cached.envelope, trust: trust) else { return nil }
        return (cached, value)
      }
      let prior = existing.first { $0.1.claims.right == checked.claims.right && $0.1.claims.kind == checked.claims.kind }
      if let prior {
        guard checked.claims.ownership_revision >= prior.1.claims.ownership_revision, checked.claims.verified_at >= prior.1.claims.verified_at else { throw AccessProofFailure.invalid }
        if checked.identity == prior.1.identity { return record }
        guard checked.claims.verified_at > prior.1.claims.verified_at else { throw AccessProofFailure.invalid }
      }
      record.rights.removeAll { cached in existing.contains { $0.0 == cached && $0.1.claims.right == checked.claims.right && $0.1.claims.kind == checked.claims.kind } }
      guard record.rights.count < 32 else { throw AccessProofFailure.invalid }
      record.rights.append(CachedAccessRight(envelope: proof.envelope, clock: checked.claims.isPaid ? try PaidAccessClock.install(checked, issuerNow: issuerNow, wall: wall) : nil, accountGeneration: checked.claims.isAccount ? record.generation : nil))
      return record
    }
  }

  public func revokeAccess(right: String, revision: Int, generation: Int) throws -> AccessCacheRecord {
    try transactionAccess { record in
      guard accessUUID(right), accessInteger(revision), generation == record.generation else { throw AccessProofFailure.invalid }
      let old = record.revocations.first { $0.right == right }
      record.revocations.removeAll { $0.right == right }
      guard old != nil || record.revocations.count < 64 else { throw AccessProofFailure.invalid }
      record.revocations.append(AccessRevocation(right: right, revision: max(old?.revision ?? 0, revision)))
      return record
    }
  }

  /// The signed binding and both scopes commit under the existing App Group lock. A readback
  /// exists only after backing.transaction acknowledges the complete durable replacement.
  public func installAppleAccess(_ request: AppleAccessInstallRequest, nativePurchase: NativeVerifiedApplePurchase,
                                 session: VerifiedNativeAccessSession? = nil, expectedGeneration: Int? = nil,
                                 wall: @autoclosure () -> Int) throws -> AppleAccessCommit {
    let binding = try VerifiedAppleRightBinding.verify(request.nativeBinding, trust: trust)
    let local = try VerifiedAccessProof.verify(request.localProof, trust: trust)
    let account = try request.accountProof.map { try VerifiedAccessProof.verify($0, trust: trust) }
    let c = binding.claims
    // Only a freshly issued online proof can create a new receipt baseline. Ordinary cached
    // reads never invoke this path; signed stale blobs cannot start a new thirty-day window.
    guard !nativePurchase.isRevoked, binding.matches(local), binding.matches(nativePurchase), request.issuerTime == c.verifiedAt,
      (account == nil) == (session == nil), (account == nil) == (request.accessToken == nil)
    else { throw AccessProofFailure.invalid }
    if let account, let session {
      let a = account.claims, l = local.claims
      guard nativePurchase.ownership == .purchased, a.kind == "paid_account", a.provenance == "provider_verified", a.holder == session.accountId,
        a.right == l.right, a.product == l.product, a.environment == l.environment, a.benefits == l.benefits,
        a.ownership_revision == l.ownership_revision, a.verified_at == l.verified_at, a.expires_at == l.expires_at
      else { throw AccessProofFailure.invalid }
    }
    return try transactionAccess { record in
      let wall = wall()
      if let session {
        guard expectedGeneration == record.generation else { throw AccessProofFailure.invalid }
        try bindSession(&record, accountId: session.accountId, sessionId: session.sessionId)
      }
      let previous = record.appleBindings.compactMap { cached -> (CachedAppleRightBinding, VerifiedAppleRightBinding)? in
        guard let verified = try? VerifiedAppleRightBinding.verify(cached.envelope, trust: trust) else { return nil }
        return (cached, verified)
      }.first { $0.1.claims.environment == c.environment && $0.1.claims.appBundleId == c.appBundleId &&
        $0.1.claims.productId == c.productId && $0.1.claims.originalTransactionId == c.originalTransactionId }
      if let previous {
        let restoredFamilyLocal = previous.0.revokesAccount == false && account == nil &&
          nativePurchase.ownership == .familyShared && previous.0.revokedAt.map({ c.verifiedAt > $0 }) == true &&
          c.verifiedAt > previous.1.claims.verifiedAt
        guard previous.0.revokedAt == nil || restoredFamilyLocal,
          previous.1.claims.right == c.right,
          previous.1.claims.ownershipRevision <= c.ownershipRevision,
          previous.1.claims.verifiedAt <= c.verifiedAt else { throw AccessProofFailure.invalid }
      }
      // A lost acknowledgement may retry an already committed identity without creating
      // a new receipt baseline. New proofs still require the bounded online freshness check.
      let identicalRetry = previous?.0.envelope == request.nativeBinding &&
        previous?.0.localProofIdentity == local.identity && previous?.0.revokedAt == nil &&
        (account == nil || record.rights.contains { $0.envelope == account?.envelope && $0.accountGeneration == record.generation })
      guard accessInteger(wall), wall < c.expiresAt,
        identicalRetry || abs(wall - c.verifiedAt) <= 300_000 else { throw AccessProofFailure.invalid }
      try upsertAppleProof(local, into: &record, issuerTime: request.issuerTime, wall: wall)
      if let account { try upsertAppleProof(account, into: &record, issuerTime: request.issuerTime, wall: wall) }
      record.appleBindings.removeAll { cached in
        (try? VerifiedAppleRightBinding.verify(cached.envelope, trust: trust))?.claims.right == c.right
      }
      guard record.appleBindings.count < 32 else { throw AccessProofFailure.invalid }
      record.appleBindings.append(CachedAppleRightBinding(envelope: request.nativeBinding, localProofIdentity: local.identity))
      return AppleAccessCommit(generation: record.generation, localRight: c.right, ownershipRevision: c.ownershipRevision,
        verifiedAt: c.verifiedAt, expiresAt: c.expiresAt, localProofIdentity: local.identity,
        accountProofIdentity: account?.identity)
    }
  }

  private func accountRevoked(_ proof: VerifiedAccessProof, record: AccessCacheRecord) -> Bool {
    proof.claims.kind == "paid_account" && record.accountRevocations.contains {
      $0.holder == proof.claims.holder && $0.right == proof.claims.right && $0.revision >= proof.claims.ownership_revision
    }
  }

  public func prepareAccountAccess(_ session: VerifiedNativeAccessSession, expectedGeneration: Int) throws -> Int {
    try transactionAccess { record in
      guard expectedGeneration == record.generation else { throw AccessProofFailure.invalid }
      try bindSession(&record, accountId: session.accountId, sessionId: session.sessionId)
      return record.generation
    }
  }

  /// All validated proofs and named removals share one existing durable transaction. A removal
  /// only acquires a scoped fence for an independently verified known right of this holder.
  public func installAccountAccess(_ snapshot: NativeAccountAccessSnapshot, session: VerifiedNativeAccessSession,
                                  expectedGeneration: Int, wall: @autoclosure () -> Int) throws -> NativeAccountAccessCommit {
    try transactionAccess { record in
      let wall = wall()
      guard record.generation == expectedGeneration, record.accountId == session.accountId,
        record.sessionId == session.sessionId, snapshot.holder == session.accountId,
        accessInteger(wall), abs(wall - snapshot.issuerTime) <= 300_000 else { throw AccessProofFailure.invalid }
      let known = record.rights.compactMap { try? VerifiedAccessProof.verify($0.envelope, trust: trust) }
      for removal in snapshot.revocations {
        let old = record.accountRevocations.first { $0.holder == session.accountId && $0.right == removal.right }
        guard old != nil || known.contains(where: { $0.claims.kind == "paid_account" &&
          $0.claims.holder == session.accountId && $0.claims.right == removal.right }) else { continue }
        record.accountRevocations.removeAll { $0.holder == session.accountId && $0.right == removal.right }
        guard record.accountRevocations.count < 64 else { throw AccessProofFailure.invalid }
        record.accountRevocations.append(.init(holder: session.accountId, right: removal.right, revision: max(old?.revision ?? 0, removal.revision)))
        let removals = record.accountRevocations
        record.rights.removeAll { cached in
          guard let proof = try? VerifiedAccessProof.verify(cached.envelope, trust: trust), proof.claims.kind == "paid_account" else { return false }
          return removals.contains { $0.holder == proof.claims.holder && $0.right == proof.claims.right && $0.revision >= proof.claims.ownership_revision }
        }
      }
      for supplied in snapshot.proofs {
        let proof = try VerifiedAccessProof.verify(supplied.envelope, trust: trust)
        guard proof.claims.kind == "paid_account", proof.claims.holder == session.accountId,
          proof.claims.verified_at <= snapshot.issuerTime, (proof.claims.expires_at ?? 0) > snapshot.issuerTime else { throw AccessProofFailure.invalid }
        try upsertAppleProof(proof, into: &record, issuerTime: snapshot.issuerTime, wall: wall)
      }
      return NativeAccountAccessCommit(accountStatus: snapshot.accountStatus, generation: record.generation, accountId: session.accountId, sessionId: session.sessionId,
        issuerTime: snapshot.issuerTime, proofIdentities: snapshot.proofs.map { $0.identity })
    }
  }

  private func upsertAppleProof(_ proof: VerifiedAccessProof, into record: inout AccessCacheRecord,
                                issuerTime: Int, wall: Int) throws {
    guard !record.revocations.contains(where: { $0.right == proof.claims.right && $0.revision >= proof.claims.ownership_revision }),
      !accountRevoked(proof, record: record)
    else { throw AccessProofFailure.invalid }
    let prior = record.rights.enumerated().first { cached in
      guard let p = try? VerifiedAccessProof.verify(cached.element.envelope, trust: trust) else { return false }
      return p.claims.right == proof.claims.right && p.claims.kind == proof.claims.kind
    }
    if let prior, let p = try? VerifiedAccessProof.verify(prior.element.envelope, trust: trust) {
      guard p.claims.ownership_revision <= proof.claims.ownership_revision, p.claims.verified_at <= proof.claims.verified_at
      else { throw AccessProofFailure.invalid }
      if p.identity == proof.identity {
        guard record.rights[prior.offset].clock?.observe(proof, wall: wall) == true,
          !proof.claims.isAccount || prior.element.accountGeneration == record.generation
        else { throw AccessProofFailure.invalid }
        return // Same identity preserves the original wall/issuer receipt baseline and latches.
      }
      guard p.claims.verified_at < proof.claims.verified_at else { throw AccessProofFailure.invalid }
      record.rights.remove(at: prior.offset)
    }
    guard record.rights.count < 32 else { throw AccessProofFailure.invalid }
    record.rights.append(CachedAccessRight(envelope: proof.envelope,
      clock: try PaidAccessClock.install(proof, issuerNow: issuerTime, wall: wall),
      accountGeneration: proof.claims.isAccount ? record.generation : nil))
  }

  private func verifiedAppleBindings(_ record: AccessCacheRecord) -> [(CachedAppleRightBinding, VerifiedAppleRightBinding, VerifiedAccessProof)] {
    record.appleBindings.compactMap { cached in
      guard let binding = try? VerifiedAppleRightBinding.verify(cached.envelope, trust: trust),
        let proof = record.rights.compactMap({ try? VerifiedAccessProof.verify($0.envelope, trust: trust) })
          .first(where: { $0.identity == cached.localProofIdentity && binding.matches($0) })
      else { return nil }
      return (cached, binding, proof)
    }
  }

  /// Match independently verified native revocation to the stored signed Apple identity.
  /// A right-scoped global revocation would also revoke a protected scope sharing the UUID;
  /// keep this marker on the Apple binding and latch only its paid proof clocks instead.
  @discardableResult
  public func revokeAppleAccess(_ revocation: NativeVerifiedAppleRevocation, wall: @autoclosure () -> Int) throws -> Bool {
    try transactionAccess { record in
      let wall = wall()
      let matched = try latchAppleRevocation(revocation, into: &record)
      _ = observeRecord(&record, wall: wall)
      return matched
    }
  }

  private func latchAppleRevocation(_ revocation: NativeVerifiedAppleRevocation,
                                    into record: inout AccessCacheRecord) throws -> Bool {
    guard accessInteger(revocation.revokedAt) else { throw AccessProofFailure.invalid }
    var matched = false
    for i in record.appleBindings.indices {
      guard let binding = try? VerifiedAppleRightBinding.verify(record.appleBindings[i].envelope, trust: trust),
        binding.matches(revocation.identity) else { continue }
      let alreadyRevokesAccount = record.appleBindings[i].revokedAt != nil && record.appleBindings[i].revokesAccount != false
      record.appleBindings[i].revokedAt = max(record.appleBindings[i].revokedAt ?? 0, revocation.revokedAt)
      record.appleBindings[i].revokesAccount = alreadyRevokesAccount || revocation.identity.ownership == .purchased
      matched = true
    }
    return matched
  }

  public func observeAppleBenefits(wall: @autoclosure () -> Int, ownership: NativeAppleOwnershipObservation,
                                   paidMode: Bool = MonetizationConfig.paidTierEnabled) throws -> BenefitAccessSnapshot {
    if !paidMode { return try observeBenefits(wall: wall()).1 }
    return try transactionAccess { record in
      let wall = wall()
      if case .verifiedRevocations(let revocations) = ownership {
        for revocation in revocations { _ = try latchAppleRevocation(revocation, into: &record) }
      }
      let evidence = observeRecord(&record, wall: wall)
      let context = NativeAccessContext(paidMode: true,
        supported: NativeAppleAccessCapabilities.supported(paidMode: true),
        accountId: record.accountId, sessionId: record.sessionId, sessionKnown: true,
        localRights: Set(verifiedAppleBindings(record).map { $0.1.claims.right }),
        evidenceStatus: ownership.evidenceStatus)
      return resolveAccessSnapshot(record, evidence: evidence, context: context)
    }
  }

  public func observeAppleAccess(wall: @autoclosure () -> Int) throws -> AppleAccessObservation {
    try observeAppleAccess(wall: wall, matching: nil)
  }

  /// Linking requires a current independently verified purchaser transaction matched to the
  /// stored signed local binding. Generic protection, account access and family sharing cannot
  /// select this route's eligibility; this read never installs or renews a proof baseline.
  public func observeAppleLinkAccess(nativePurchase: NativeVerifiedApplePurchase?,
                                    wall: @autoclosure () -> Int) throws -> AppleAccessObservation {
    guard let nativePurchase else {
      return try transactionAccess { record in
        _ = observeRecord(&record, wall: wall())
        return AppleAccessObservation(generation: record.generation, rights: [])
      }
    }
    guard nativePurchase.ownership == .purchased, !nativePurchase.isRevoked else { throw AccessProofFailure.invalid }
    return try observeAppleAccess(wall: wall, matching: nativePurchase)
  }

  private func observeAppleAccess(wall: () -> Int, matching nativePurchase: NativeVerifiedApplePurchase?) throws -> AppleAccessObservation {
    try transactionAccess { record in
      let wall = wall()
      let evidence = observeRecord(&record, wall: wall)
      let rights = verifiedAppleBindings(record).filter { cached, binding, proof in
        cached.revokedAt == nil && !evidence.contains { $0.proof.identity == proof.identity && $0.revoked } &&
          (nativePurchase.map { purchase in binding.matches(purchase) &&
            evidence.contains { $0.proof.identity == proof.identity && $0.validPaid && !$0.revoked } } ?? true)
      }.map { cached, binding, proof in
        let valid = evidence.contains { $0.proof.identity == proof.identity && $0.validPaid && !$0.revoked }
        return AppleAccessObservation.Right(localRight: binding.claims.right, ownershipRevision: binding.claims.ownershipRevision,
          verifiedAt: binding.claims.verifiedAt, expiresAt: binding.claims.expiresAt,
          localProofIdentity: cached.localProofIdentity, status: valid ? "purchased" : "verification_required")
      }
      return AppleAccessObservation(generation: record.generation, rights: rights)
    }
  }

  public func observeAccess(wall: @autoclosure () -> Int, runningEstimate: Int? = nil) throws -> (AccessCacheRecord, [ScopedAccessEvidence]) {
    guard #available(macOS 10.15, *) else { throw AccessProofFailure.verificationRequired }
    return try transactionAccess { record in
      let wall = wall()
      let evidence = observeRecord(&record, wall: wall, runningEstimate: runningEstimate)
      return (record, evidence)
    }
  }

  @available(macOS 10.15, *)
  private func observeRecord(_ record: inout AccessCacheRecord, wall: Int, runningEstimate: Int? = nil) -> [ScopedAccessEvidence] {
    var evidence: [ScopedAccessEvidence] = []
    var revokedAppleLocalRights: Set<String> = [], revokedAppleAccountRights: Set<String> = []
    for cached in record.appleBindings where cached.revokedAt != nil {
      guard let binding = try? VerifiedAppleRightBinding.verify(cached.envelope, trust: trust) else { continue }
      let identity = binding.claims.environment + "\n" + binding.claims.right
      revokedAppleLocalRights.insert(identity)
      if cached.revokesAccount != false { revokedAppleAccountRights.insert(identity) }
    }
    for i in record.rights.indices {
      guard let proof = try? VerifiedAccessProof.verify(record.rights[i].envelope, trust: trust) else { continue }
      let appleIdentity = proof.claims.environment + "\n" + proof.claims.right
      let nativeRevoked = (proof.claims.kind == "paid_apple_local" && revokedAppleLocalRights.contains(appleIdentity)) ||
        (proof.claims.kind == "paid_account" && revokedAppleAccountRights.contains(appleIdentity))
      let revoked = nativeRevoked || accountRevoked(proof, record: record) || (proof.claims.isAccount && record.rights[i].accountGeneration != record.generation) || record.revocations.contains { $0.right == proof.claims.right && $0.revision >= proof.claims.ownership_revision }
      if revoked { record.rights[i].clock?.revoked = true }
      let valid = record.rights[i].clock?.observe(proof, wall: wall, runningEstimate: runningEstimate) ?? false
      evidence.append(ScopedAccessEvidence(proof: proof, validPaid: valid, revoked: revoked))
    }
    return evidence
  }

  /// Same verified sub/session survives ordinary wakes; a new session even for the same UUID
  /// advances the existing durable generation and excludes delayed account snapshots.
  public func changeAccessSession(accountId: String?, sessionId: String?) throws -> AccessCacheRecord {
    guard #available(macOS 10.15, *) else { throw AccessProofFailure.verificationRequired }
    return try transactionAccess { record in
      try bindSession(&record, accountId: accountId, sessionId: sessionId)
      return record
    }
  }
  @available(macOS 10.15, *)
  private func bindSession(_ record: inout AccessCacheRecord, accountId: String?, sessionId: String?) throws {
    guard (accountId == nil && sessionId == nil) || (accountId.map(accessUUID) == true && sessionId.map(accessUUID) == true) else { throw AccessProofFailure.invalid }
    if record.accountId == accountId && record.sessionId == sessionId { return }
    guard record.generation < 9_007_199_254_740_991 else { throw AccessProofFailure.invalid }
    record.accountId = accountId; record.sessionId = sessionId; record.generation += 1
    record.rights = record.rights.filter {
      guard let proof = try? VerifiedAccessProof.verify($0.envelope, trust: trust) else { return true }
      return !proof.claims.isAccount
    }
  }

  /// Resolve inside the actual transaction, publish only after full durable commit succeeds.
  /// A free-mode read requires neither backing coordination nor account/native verification.
  public func observeBenefits(wall: @autoclosure () -> Int, context: NativeAccessContext = NativeAccessContext()) throws -> (AccessCacheRecord, BenefitAccessSnapshot) {
    if !context.paidMode { return (AccessCacheRecord(), resolveAccessSnapshot(AccessCacheRecord(), evidence: [], context: context)) }
    guard #available(macOS 10.15, *) else { throw AccessProofFailure.verificationRequired }
    return try transactionAccess { record in
      let wall = wall()
      if context.sessionKnown { try bindSession(&record, accountId: context.accountId, sessionId: context.sessionId) }
      let evidence = observeRecord(&record, wall: wall)
      let localRights = context.localRights.union(verifiedAppleBindings(record).map { $0.1.claims.right })
      let verifiedContext = NativeAccessContext(paidMode: context.paidMode, supported: context.supported,
        accountId: context.accountId, sessionId: context.sessionId, sessionKnown: context.sessionKnown,
        localRights: localRights, evidenceStatus: context.evidenceStatus)
      return (record, resolveAccessSnapshot(record, evidence: evidence, context: verifiedContext))
    }
  }

  /// The production store in the shared App Group container, falling back to in-memory when the
  /// App Group isn't provisioned (same degradation as SharedSettingsStore.appGroup()).
  public static func appGroup(_ identifier: String = StillAppGroup.identifier, trust: AccessTrust = .compiled) -> SharedEntitlementStore {
    guard let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier),
      let legacy = AppGroupBacking(appGroupId: identifier, key: "still:entitlement") else {
      return SharedEntitlementStore(backing: InMemoryBacking(), coordinationAvailable: false, trust: trust)
    }
    return SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "still-entitlement", legacyRead: { legacy.read() }), trust: trust)
  }
}

/// The reply envelope for both entitlement requests. Distinct from the STORED shape
/// (`EntitlementRecord`): all fields are optional, and encoding is hand-written because Swift's
/// synthesized Codable uses `encodeIfPresent` and silently DROPS nil keys — the wire contract
/// requires explicit `null` so decoders can rely on all three keys being present.
public struct EntitlementReplyEnvelope: Equatable, Sendable {
  public let installId: String?
  public let entitled: Bool?
  public let updatedAt: Int?
  public let source: EntitlementSource?

  public init(installId: String?, record: EntitlementRecord?) {
    self.installId = installId
    self.entitled = record?.entitled
    self.updatedAt = record?.updatedAt
    self.source = record?.source
  }
}

extension EntitlementReplyEnvelope: Encodable {
  private enum CodingKeys: String, CodingKey { case installId, entitled, updatedAt, source }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    // `encode` (not `encodeIfPresent`) so nil serializes as an explicit JSON null.
    try container.encode(installId, forKey: .installId)
    try container.encode(entitled, forKey: .entitled)
    try container.encode(updatedAt, forKey: .updatedAt)
    try container.encode(source, forKey: .source)
  }
}

/// A decoded entitlement bridge request.
public enum EntitlementRequest: Equatable, Sendable {
  case get
  case getAccess
  case getBenefitAccess
  case getAppleAccess
  case set(entitled: Bool)

  /// Parse a raw message body into a request; nil means "not an entitlement message" so hosts can
  /// fall through to the settings bridge or reject.
  public static func parse(_ body: Any) -> EntitlementRequest? {
    guard let dict = body as? [String: Any], let kind = dict["kind"] as? String else { return nil }
    switch kind {
    case "observeAppleAccess":
      guard dict.count == 1 else { return nil }
      return .getAppleAccess
    case "getBenefitAccess":
      guard dict.count == 1 else { return nil }
      return .getBenefitAccess
    case "getAccess":
      guard dict.count == 1 else { return nil }
      return .getAccess
    case "getEntitlement":
      return .get
    case "setEntitlement":
      guard let entitled = dict["entitled"] as? Bool else { return nil }
      return .set(entitled: entitled)
    default:
      return nil
    }
  }
}

/// Processes entitlement requests against a SharedEntitlementStore. `set` proposals stamp
/// `updatedAt` with the injected clock and route through StampPolicy (R13) with the injected
/// receipt-status provider — a SYNCHRONOUS closure returning the app target's cached snapshot
/// (StoreKit reads are async; freshness is owned by the app's refresh sites and the blocked-write
/// re-read rule, ADR 0003). Both requests reply with the envelope JSON carrying the
/// install-generation id (issue #63) and the POST-DECISION stored state — a blocked downgrade
/// replies with the surviving record, not the refused proposal. `installId` is injected like
/// `now` so tests stay pure. A `readOnly` bridge (the Safari extension handler's lane) refuses
/// `.set` without writing and replies with current state.
public struct EntitlementBridge {
  private let store: SharedEntitlementStore
  private let now: () -> Int
  private let installId: () -> String?
  private let receiptStatus: () -> ReceiptStatus
  private let proposalSource: EntitlementSource
  private let readOnly: Bool
  private let accessContext: () -> NativeAccessContext

  public init(
    store: SharedEntitlementStore,
    now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
    installId: @escaping () -> String? = { InstallGeneration.current(InstallGeneration.appGroupDefaults()) },
    receiptStatus: @escaping () -> ReceiptStatus = { .noSignal },
    proposalSource: EntitlementSource = .server,
    readOnly: Bool = false,
    accessContext: @escaping () -> NativeAccessContext = { NativeAccessContext() }
  ) {
    self.store = store
    self.now = now
    self.installId = installId
    self.receiptStatus = receiptStatus
    self.proposalSource = proposalSource
    self.readOnly = readOnly
    self.accessContext = accessContext
  }

  public func handle(_ request: EntitlementRequest) -> String {
    switch request {
    case .getAppleAccess:
      do {
        let observation = try store.observeAppleAccess(wall: now())
        return String(data: try JSONEncoder().encode(observation), encoding: .utf8) ?? "{\"ok\":false}"
      } catch { return "{\"ok\":false}" }
    case .getBenefitAccess:
      do {
        let snapshot = try store.observeBenefits(wall: now(), context: accessContext()).1
        let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot))
        let data = try JSONSerialization.data(withJSONObject: ["ok": true, "snapshot": value], options: [.sortedKeys])
        return String(data: data, encoding: .utf8) ?? "{\"ok\":false}"
      } catch { return "{\"ok\":false}" }
    case .getAccess:
      do {
        let record = try store.observeAccess(wall: now()).0
        let access = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record))
        let data = try JSONSerialization.data(withJSONObject: ["ok": true, "record": access], options: [.sortedKeys])
        return String(data: data, encoding: .utf8) ?? "{\"ok\":false}"
      } catch { return "{\"ok\":false}" }
    case .get:
      return Self.encode(EntitlementReplyEnvelope(installId: installId(), record: store.peek()))
    case .set(let entitled):
      guard !readOnly else {
        // The extension process must never write the stamp (no receipt oracle there, and a
        // writable lane would be an entitlement-forgery surface). Reply with current state.
        return Self.encode(EntitlementReplyEnvelope(installId: installId(), record: store.peek()))
      }
      let proposed = EntitlementRecord(entitled: entitled, updatedAt: now(), source: proposalSource)
      apply(proposed: proposed)
      return Self.encode(EntitlementReplyEnvelope(installId: installId(), record: store.peek()))
    }
  }

  /// The native receipt lane's entry (launch / foreground / post-purchase / post-restore
  /// restamps): converts a receipt status into a receipt-lane proposal and routes it through the
  /// same policy. `noSignal` proposes nothing. Returns the stored record after the decision.
  @discardableResult
  public func applyReceipt(_ status: ReceiptStatus) -> EntitlementRecord? {
    guard !readOnly else { return store.peek() }
    switch status {
    case .entitled:
      apply(proposed: EntitlementRecord(entitled: true, updatedAt: now(), source: .receipt))
    case .verifiedNotEntitled:
      apply(proposed: EntitlementRecord(entitled: false, updatedAt: now(), source: .receipt))
    case .noSignal:
      break // absence is never a signal
    }
    return store.peek()
  }

  /// Actual account teardown calls this before yielding to provider identity cleanup. Local
  /// protection/Apple rights remain; old account responses cannot reinstall under this generation.
  public func clearAccessAccount() throws {
    guard !readOnly else { throw AccessProofFailure.verificationRequired }
    _ = try store.changeAccessAccount(nil)
  }

  @discardableResult
  public func revokeAppleAccess(_ revocation: NativeVerifiedAppleRevocation) throws -> Bool {
    guard !readOnly else { throw AccessProofFailure.invalid }
    return try store.revokeAppleAccess(revocation, wall: now())
  }

  public func observeAppleBenefits(_ ownership: NativeAppleOwnershipObservation) throws -> BenefitAccessSnapshot {
    try store.observeAppleBenefits(wall: now(), ownership: ownership)
  }

  public func observeAppleLinkAccess(nativePurchase: NativeVerifiedApplePurchase?) throws -> AppleAccessObservation {
    guard !readOnly else { throw AccessProofFailure.verificationRequired }
    return try store.observeAppleLinkAccess(nativePurchase: nativePurchase, wall: now())
  }

  public func prepareAppleAccessInstall() throws -> Int {
    guard !readOnly else { throw AccessProofFailure.verificationRequired }
    return try store.observeAccess(wall: now()).0.generation
  }

  public func installAppleAccess(_ request: AppleAccessInstallRequest, nativePurchase: NativeVerifiedApplePurchase,
                                 session: VerifiedNativeAccessSession? = nil, expectedGeneration: Int? = nil) throws -> AppleAccessCommit {
    guard !readOnly else { throw AccessProofFailure.verificationRequired }
    return try store.installAppleAccess(request, nativePurchase: nativePurchase, session: session,
      expectedGeneration: expectedGeneration, wall: now())
  }

  public func prepareAccountAccess(_ session: VerifiedNativeAccessSession, expectedGeneration: Int) throws -> Int {
    guard !readOnly else { throw AccessProofFailure.verificationRequired }
    return try store.prepareAccountAccess(session, expectedGeneration: expectedGeneration)
  }

  public func installAccountAccess(_ snapshot: NativeAccountAccessSnapshot, session: VerifiedNativeAccessSession,
                                  expectedGeneration: Int) throws -> NativeAccountAccessCommit {
    guard !readOnly else { throw AccessProofFailure.verificationRequired }
    return try store.installAccountAccess(snapshot, session: session, expectedGeneration: expectedGeneration, wall: now())
  }

  private func apply(proposed: EntitlementRecord) {
    store.apply(proposed, receipt: receiptStatus())
  }

  /// Parse + handle in one call; nil when the body isn't an entitlement request.
  public func handle(rawBody body: Any) -> String? {
    guard let request = EntitlementRequest.parse(body) else { return nil }
    return handle(request)
  }

  static func encode(_ envelope: EntitlementReplyEnvelope) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys // deterministic wire output for tests and diffing
    guard let data = try? encoder.encode(envelope),
          let string = String(data: data, encoding: .utf8)
    else { return "" }
    return string
  }
}
