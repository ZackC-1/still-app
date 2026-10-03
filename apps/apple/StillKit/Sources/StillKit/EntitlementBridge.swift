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
              trust: AccessTrust = AccessTrust(environment: "production", keys: [])) {
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

  private func preserving(_ record: EntitlementRecord, over data: Data?) throws -> Data {
    var object = try data.map { try JSONSerialization.jsonObject(with: $0) as? [String: Any] ?? { throw AccessProofFailure.invalid }() } ?? [:]
    if let access = object["access"] { _ = try decodeAccess(access) }
    object["entitled"] = record.entitled; object["updatedAt"] = record.updatedAt; object["source"] = record.source.rawValue
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }

  private func decodeAccess(_ object: Any) throws -> AccessCacheRecord {
    let result = try decoder.decode(AccessCacheRecord.self, from: JSONSerialization.data(withJSONObject: object))
    guard result.schema == 1, accessInteger(result.generation), result.accountId.map(accessUUID) ?? true,
      result.rights.count <= 32, result.revocations.count <= 64, result.localProtection?.valid ?? true,
      result.rights.allSatisfy({ $0.envelope.utf8.count <= 6_144 && ($0.accountGeneration.map(accessInteger) ?? true) }),
      result.revocations.allSatisfy({ accessUUID($0.right) && accessInteger($0.revision) }) else { throw AccessProofFailure.invalid }
    return result
  }

  /// A complete scoped entitlement record commits before the caller can publish modern access.
  /// No separate cache or lock is introduced. Throws preserve the original durable bytes.
  private func transactionAccess<T>(_ body: (inout AccessCacheRecord) throws -> T) throws -> T {
    guard coordinationAvailable else { throw AccessProofFailure.verificationRequired }
    return try backing.transaction { data in
      var object = try data.map { try JSONSerialization.jsonObject(with: $0) as? [String: Any] ?? { throw AccessProofFailure.invalid }() } ?? [:]
      var record = try object["access"].map(decodeAccess) ?? AccessCacheRecord()
      let result = try body(&record)
      let encoded = try JSONSerialization.jsonObject(with: encoder.encode(record)) as? [String: Any] ?? [:]
      var access = object["access"] as? [String: Any] ?? [:]
      for (key, value) in encoded { access[key] = value }
      object["access"] = access
      data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
      return result
    }
  }

  /// Internal host action only; no extension bridge route accepts declaration/policy fields.
  public func mutateLocalProtection(_ mutation: LocalProtectionMutation) throws -> AccessCacheRecord {
    try transactionAccess { record in
      record.localProtection = try StillKit.mutateLocalProtection(record.localProtection, mutation: mutation)
      return record
    }
  }

  public func changeAccessAccount(_ accountId: String?) throws -> AccessCacheRecord {
    guard #available(macOS 10.15, *) else { throw AccessProofFailure.verificationRequired }
    return try transactionAccess { record in
      guard accountId.map(accessUUID) ?? true, record.generation < 9_007_199_254_740_991 else { throw AccessProofFailure.invalid }
      record.accountId = accountId; record.generation += 1
      record.rights = record.rights.filter {
        guard let proof = try? VerifiedAccessProof.verify($0.envelope, trust: trust) else { return true }
        return !proof.claims.isAccount
      }
      return record
    }
  }

  /// Internal authoritative online lane only. This is not reachable from a raw extension request.
  public func installAccess(_ proof: VerifiedAccessProof, generation: Int, issuerNow: Int, wall: Int,
                            localRights: Set<String>) throws -> AccessCacheRecord {
    guard #available(macOS 10.15, *) else { throw AccessProofFailure.verificationRequired }
    return try transactionAccess { record in
      let checked = try VerifiedAccessProof.verify(proof.envelope, trust: trust)
      guard generation == record.generation, checked.matchesHolder(accountId: record.accountId, localRights: localRights),
        !record.revocations.contains(where: { $0.right == checked.claims.right && $0.revision >= checked.claims.ownership_revision }) else { throw AccessProofFailure.invalid }
      let existing = record.rights.compactMap { cached -> (CachedAccessRight, VerifiedAccessProof)? in
        guard let value = try? VerifiedAccessProof.verify(cached.envelope, trust: trust) else { return nil }
        return (cached, value)
      }
      let prior = existing.first { $0.1.claims.right == checked.claims.right }
      if let prior {
        guard checked.claims.ownership_revision >= prior.1.claims.ownership_revision, checked.claims.verified_at >= prior.1.claims.verified_at else { throw AccessProofFailure.invalid }
        if checked.identity == prior.1.identity { return record }
        guard checked.claims.verified_at > prior.1.claims.verified_at else { throw AccessProofFailure.invalid }
      }
      record.rights.removeAll { cached in existing.contains { $0.0 == cached && $0.1.claims.right == checked.claims.right } }
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

  public func observeAccess(wall: Int, runningEstimate: Int? = nil) throws -> (AccessCacheRecord, [ScopedAccessEvidence]) {
    guard #available(macOS 10.15, *) else { throw AccessProofFailure.verificationRequired }
    return try transactionAccess { record in
      var evidence: [ScopedAccessEvidence] = []
      for i in record.rights.indices {
        guard let proof = try? VerifiedAccessProof.verify(record.rights[i].envelope, trust: trust) else { continue }
        let revoked = (proof.claims.isAccount && record.rights[i].accountGeneration != record.generation) || record.revocations.contains { $0.right == proof.claims.right && $0.revision >= proof.claims.ownership_revision }
        if revoked { record.rights[i].clock?.revoked = true }
        let valid = record.rights[i].clock?.observe(proof, wall: wall, runningEstimate: runningEstimate) ?? false
        evidence.append(ScopedAccessEvidence(proof: proof, validPaid: valid, revoked: revoked))
      }
      return (record, evidence)
    }
  }

  /// The production store in the shared App Group container, falling back to in-memory when the
  /// App Group isn't provisioned (same degradation as SharedSettingsStore.appGroup()).
  public static func appGroup(_ identifier: String = StillAppGroup.identifier) -> SharedEntitlementStore {
    guard let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier),
      let legacy = AppGroupBacking(appGroupId: identifier, key: "still:entitlement") else {
      return SharedEntitlementStore(backing: InMemoryBacking(), coordinationAvailable: false)
    }
    return SharedEntitlementStore(backing: AtomicSettingsBacking(directory: directory, name: "still-entitlement", legacyRead: { legacy.read() }))
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
  case set(entitled: Bool)

  /// Parse a raw message body into a request; nil means "not an entitlement message" so hosts can
  /// fall through to the settings bridge or reject.
  public static func parse(_ body: Any) -> EntitlementRequest? {
    guard let dict = body as? [String: Any], let kind = dict["kind"] as? String else { return nil }
    switch kind {
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

  public init(
    store: SharedEntitlementStore,
    now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
    installId: @escaping () -> String? = { InstallGeneration.current(InstallGeneration.appGroupDefaults()) },
    receiptStatus: @escaping () -> ReceiptStatus = { .noSignal },
    proposalSource: EntitlementSource = .server,
    readOnly: Bool = false
  ) {
    self.store = store
    self.now = now
    self.installId = installId
    self.receiptStatus = receiptStatus
    self.proposalSource = proposalSource
    self.readOnly = readOnly
  }

  public func handle(_ request: EntitlementRequest) -> String {
    switch request {
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
