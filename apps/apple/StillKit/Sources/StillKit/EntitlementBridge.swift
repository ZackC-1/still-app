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
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(backing: SettingsBacking) {
    self.backing = backing
  }

  public func peek() -> EntitlementRecord? {
    guard let data = backing.read(),
          let record = try? decoder.decode(EntitlementRecord.self, from: data)
    else { return nil }
    return record
  }

  public func save(_ record: EntitlementRecord) {
    guard let data = try? encoder.encode(record) else { return }
    backing.write(data)
  }

  /// The production store in the shared App Group container, falling back to in-memory when the
  /// App Group isn't provisioned (same degradation as SharedSettingsStore.appGroup()).
  public static func appGroup(_ identifier: String = StillAppGroup.identifier) -> SharedEntitlementStore {
    SharedEntitlementStore(
      backing: AppGroupBacking(appGroupId: identifier, key: "still:entitlement") ?? InMemoryBacking())
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
  case set(entitled: Bool)

  /// Parse a raw message body into a request; nil means "not an entitlement message" so hosts can
  /// fall through to the settings bridge or reject.
  public static func parse(_ body: Any) -> EntitlementRequest? {
    guard let dict = body as? [String: Any], let kind = dict["kind"] as? String else { return nil }
    switch kind {
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

  private func apply(proposed: EntitlementRecord) {
    switch StampPolicy.decide(proposed: proposed, receipt: receiptStatus(), current: store.peek()) {
    case .write(let record):
      store.save(record)
    case .drop:
      break
    }
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
