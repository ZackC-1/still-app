import Foundation

/// Complete authoritative record. The legacy projection and opaque supported fields travel with
/// scope, acknowledgement and immutable intent in the one locked replacement, never separate keys.
public enum AtomicSettingsRecord {
  public enum Failure: Error { case unavailable, unreadable, unknownField, invalidIntent, pendingLimit }
  private static let encoder: JSONEncoder = {
    let value = JSONEncoder()
    value.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return value
  }()
  private static func decode(_ data: Data) throws -> [String: SettingsJSONValue] {
    guard data.count <= 131_072, !exceedsDepth(data),
      let tree = try? JSONSerialization.jsonObject(with: data), !keyCollision(tree),
      let root = try JSONDecoder().decode(SettingsJSONValue.self, from: data).object else { throw Failure.unreadable }
    return root
  }
  private static func exceedsDepth(_ data: Data) -> Bool {
    var depth = 0; var quoted = false; var escaped = false
    for byte in data {
      if quoted {
        if escaped { escaped = false }
        else if byte == 92 { escaped = true }
        else if byte == 34 { quoted = false }
      } else if byte == 34 { quoted = true }
      else if byte == 123 || byte == 91 { depth += 1; if depth > 12 { return true } }
      else if byte == 125 || byte == 93 { depth -= 1 }
    }
    return false
  }
  // Schema-independent raw Foundation check, also reused before entitlement conversion.
  static func keyCollision(_ value: Any) -> Bool {
    if let dictionary = value as? NSDictionary {
      var keys = Set<String>()
      for raw in dictionary.allKeys {
        guard let key = raw as? String, keys.insert(key).inserted else { return true }
      }
      return dictionary.allValues.contains { keyCollision($0) }
    }
    if let values = value as? NSArray { return values.contains { keyCollision($0) } }
    return false
  }
  public static func validateRecord(_ data: Data) throws { _ = try decode(data) }
  public static func isModern(_ data: Data) -> Bool {
    guard let root = try? decode(data) else { return false }
    return root["atomic"] != nil || root["settings"]?.object?["schemaVersion"] != nil
  }
  private static func field(_ settings: [String: SettingsJSONValue], _ path: String) -> Bool? {
    let parts = path.split(separator: ".", maxSplits: 1).map(String.init)
    let value = parts.count == 1 ? settings[path] : settings[parts[0]]?.object?[parts[1]]
    if case .bool(let value) = value { return value }
    return nil
  }
  private static func setField(_ settings: inout [String: SettingsJSONValue], _ path: String, _ value: Bool) {
    let parts = path.split(separator: ".", maxSplits: 1).map(String.init)
    if parts.count == 1 { settings[path] = .bool(value) }
    else {
      var values = settings[parts[0]]?.object ?? [:]
      values[parts[1]] = .bool(value)
      settings[parts[0]] = .object(values)
    }
  }
  public static func initialize(_ raw: Data?, ownership: String) throws -> Data {
    guard ["never-linked", "previous-account", "unknown"].contains(ownership), let raw else { throw Failure.unreadable }
    var root = try decode(raw)
    if let state = root["atomic"]?.object {
      // A later wake leaves an initialized record alone. The one exception is the retired
      // pending-limit pause that earlier StillKit builds persisted on unknown local-only records;
      // clearing it keeps every saved value and held choice exactly and only re-admits edits.
      guard var state = recoveredLegacyPendingLimit(state, settings: root["settings"]?.object) else { return raw }
      guard case .number(let sequence) = state["sequence"] else { return raw }
      state["sequence"] = .number(sequence + 1)
      root["atomic"] = .object(state)
      let result = try encoder.encode(root)
      guard result.count <= 131_072 else { return raw }
      return result
    }
    let settings = root["settings"]?.object ?? root
    let original = try encoder.encode(settings)
    // Matches AtomicSettingsWriter.initialize: a readable zero-stamp record (a 2.1.x install that
    // was never edited, possibly with sync metadata) is accepted for any ownership marker.
    let provenance = SettingsV2Provenance(kind: "readable-local", provenInitialization: settings["updatedAt"] == .number(0))
    guard case .ready(let modern, _) = SettingsV2Migration.read(original, provenance: provenance) else { throw Failure.unreadable }
    if root["settings"] == nil { root = ["syncMetadata": .null, "syncEpoch": .number(0)] }
    // The TypeScript writer's legacy projection: retired pauses persist as an empty list.
    var document = modern.document
    document["pauses"] = .array([])
    root["settings"] = .object(document)
    root["atomic"] = .object([
      "format": .number(1), "sequence": .number(0), "ownership": .string(ownership),
      "scope": .object(["accountId": .null, "generation": .number(0)]),
      "anchor": .null, "pending": .array([]), "held": .object([:]), "paused": .null
    ])
    return try encoder.encode(root)
  }

  private static func canonicalUUID(_ value: SettingsJSONValue?) -> Bool {
    guard case .string(let string) = value else { return false }
    return UUID(uuidString: string)?.uuidString.lowercased() == string
  }
  private static func validScope(_ scope: [String: SettingsJSONValue]) -> Bool {
    guard scope["accountId"] == .null || canonicalUUID(scope["accountId"]),
      case .number(let generation) = scope["generation"] else { return false }
    if scope["sessionId"] != nil { guard scope["accountId"] != .null, canonicalUUID(scope["sessionId"]) else { return false } }
    return generation >= 0 && generation <= SettingsV2Migration.maxRevision && generation.rounded(.towardZero) == generation
  }
  private static func receipt(_ value: SettingsJSONValue?) -> [String: SettingsJSONValue]? {
    guard let receipt = value?.object, Set(receipt.keys) == Set(["version", "lineage", "revision", "mac"]),
      receipt["version"] == .number(1), canonicalUUID(receipt["lineage"]),
      case .number(let revision) = receipt["revision"], revision >= 0 && revision <= SettingsV2Migration.maxRevision,
      revision.rounded(.towardZero) == revision,
      case .string(let mac) = receipt["mac"], mac.range(of: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$", options: .regularExpression) != nil
    else { return nil }
    return receipt
  }
  private static func validState(_ state: [String: SettingsJSONValue]) -> Bool {
    guard state["format"] == .number(1), case .number(let sequence) = state["sequence"],
      sequence >= 0, sequence <= SettingsV2Migration.maxRevision, sequence.rounded(.towardZero) == sequence,
      case .string(let owner) = state["ownership"], ["unknown", "never-linked", "previous-account"].contains(owner),
      let scope = state["scope"]?.object, validScope(scope), let held = state["held"]?.object,
      case .array(let pending) = state["pending"], pending.count <= 64,
      state["anchor"] == .null || receipt(state["anchor"]) != nil else { return false }
    if state["paused"] != .null { guard case .string = state["paused"] else { return false } }
    for (key, value) in held {
      guard PackagedFeatureRegistry.settingsFields.contains(key), case .bool = value else { return false }
    }
    var ids = Set<String>()
    for entry in pending {
      guard let item = entry.object, canonicalUUID(item["writeId"]), case .string(let id) = item["writeId"], ids.insert(id).inserted,
        let scope = item["scope"]?.object, validScope(scope), item["receipt"] == .null || receipt(item["receipt"]) != nil,
        case .array(let operations) = item["operations"], operations.count >= 1, operations.count <= 20 else { return false }
      if let original = item["originScope"] { guard let scope = original.object, validScope(scope) else { return false } }
      var fields = Set<String>()
      for operation in operations {
        guard let op = operation.object, Set(op.keys) == Set(["path", "value", "baseRevision", "localStep"]),
          case .string(let path) = op["path"], PackagedFeatureRegistry.settingsFields.contains(path), fields.insert(path).inserted,
          case .bool(let value) = op["value"], let ordered = SettingsOrderedField(value: value, stamp: ["baseRevision": op["baseRevision"] ?? .null, "localStep": op["localStep"] ?? .null]), ordered.localStep > 0 else { return false }
      }
    }
    return true
  }
  private static func ordered(_ settings: [String: SettingsJSONValue], path: String) throws -> SettingsOrderedField {
    guard let value = field(settings, path), let stamp = settings["clocks"]?.object?[path]?.object,
      let result = SettingsOrderedField(value: value, stamp: stamp) else { throw Failure.unreadable }
    return result
  }
  private static func resolvePause(_ state: inout [String: SettingsJSONValue], held: [String: SettingsJSONValue]) {
    guard held.isEmpty, let scope = state["scope"]?.object,
      scope["accountId"] == .null || receipt(state["anchor"]) != nil,
      case .string(let pause) = state["paused"],
      ["awaiting-anchor", "ownership-hold", "pending-limit", "ordering-hold"].contains(pause) else { return }
    state["paused"] = .null
  }
  private static func sameScope(_ a: [String: SettingsJSONValue]?, _ b: [String: SettingsJSONValue]) -> Bool {
    guard let a else { return false }
    return a["accountId"] == b["accountId"] && a["generation"] == b["generation"] && a["sessionId"] == b["sessionId"]
  }
  /// Mirrors TypeScript permitsUnknownLocalEdit: an unknown-ownership record outside any account
  /// edits its own settings directly. Nothing is queued for an account, so no pending limit applies.
  /// `legacyPause` additionally admits the retired pending-limit pause (see the recovery below).
  private static func permitsUnknownLocalEdit(_ state: [String: SettingsJSONValue], settings: [String: SettingsJSONValue]?, legacyPause: Bool = false) -> Bool {
    guard validState(state), state["ownership"] == .string("unknown"), let scope = state["scope"]?.object,
      scope["accountId"] == .null, scope["sessionId"] == nil, state["anchor"] == .null,
      case .number(let sequence) = state["sequence"], sequence < SettingsV2Migration.maxRevision,
      state["paused"] == .null || legacyPause && state["paused"] == .string("pending-limit"),
      case .array(let pending) = state["pending"],
      pending.allSatisfy({ entry in
        guard let item = entry.object else { return false }
        return item["receipt"] == .null && item["originScope"] == nil && sameScope(item["scope"]?.object, scope)
      }),
      let settings, settings["schemaVersion"] == .number(2), let bytes = try? encoder.encode(settings),
      case .ready = SettingsV2Migration.read(bytes, provenance: .init(kind: "readable-local", provenInitialization: settings["updatedAt"] == .number(0)))
    else { return false }
    return true
  }
  /// Earlier StillKit builds queued every unknown local edit and, at 64, persisted `pending-limit`.
  /// Under the local-only rule that queue never reaches an account (any scope change retires it),
  /// so the pause no longer protects anything. Only the pause is cleared: settings, clocks, held
  /// choices and the retained requests stay exactly as saved, and the result is a record the
  /// TypeScript writer itself admits. Returns nil for every other shape, which stays untouched.
  private static func recoveredLegacyPendingLimit(_ state: [String: SettingsJSONValue], settings: [String: SettingsJSONValue]?) -> [String: SettingsJSONValue]? {
    guard state["paused"] == .string("pending-limit"),
      permitsUnknownLocalEdit(state, settings: settings, legacyPause: true) else { return nil }
    var state = state
    state["paused"] = .null
    return state
  }

  /// Internal host commands operate on the same locked complete record. Receipt syntax is not
  /// authentication: the web backend adapter supplies it only after its authenticated own-row read.
  public static func command(_ raw: Data?, command: Data) throws -> Data {
    let action = try decode(command)
    if action["action"] == .string("initialize") {
      guard Set(action.keys) == Set(["action", "ownership"]), case .string(let owner) = action["ownership"] else { throw Failure.invalidIntent }
      return try initialize(raw, ownership: owner)
    }
    guard let raw else { throw Failure.unreadable }
    var root = try decode(raw)
    guard var state = root["atomic"]?.object, validState(state), state["format"] == .number(1),
      let priorScope = state["scope"]?.object, validScope(priorScope),
      case .array(var pending) = state["pending"], pending.count <= 64,
      case .number(let sequence) = state["sequence"], sequence >= 0, sequence <= SettingsV2Migration.maxRevision, sequence.rounded(.towardZero) == sequence,
      state["held"]?.object != nil, state["anchor"] == .null || receipt(state["anchor"]) != nil
    else { throw Failure.unreadable }
    // As in AtomicSettingsWriter, every no-op answer (a never-linked null-to-null teardown, the
    // same verified session, an acknowledgement for another scope) returns the original bytes
    // before any saturation refusal or complete-record replacement.
    if action["action"] == .string("scope") {
      guard Set(action.keys) == Set(["action", "accountId"]) || Set(action.keys) == Set(["action", "accountId", "sessionId"]),
        action["accountId"] == .null || canonicalUUID(action["accountId"]) else { throw Failure.invalidIntent }
      if action["sessionId"] != nil {
        guard action["accountId"] != .null, canonicalUUID(action["sessionId"]) else { throw Failure.invalidIntent }
      }
      // A never-linked null-to-null teardown has no account/session generation to retire.
      if action["accountId"] == .null, priorScope["accountId"] == .null, state["ownership"] == .string("never-linked") { return raw }
      if action["accountId"] != .null, action["accountId"] == priorScope["accountId"] {
        // UUID alone cannot establish continuity after an unsuccessful sign-out and process death.
        guard action["sessionId"] != nil, priorScope["sessionId"] != nil else { throw Failure.unavailable }
        if action["sessionId"] == priorScope["sessionId"] { return raw }
      }
      guard sequence < SettingsV2Migration.maxRevision else { throw Failure.unreadable }
      guard case .number(let generation) = priorScope["generation"], generation < SettingsV2Migration.maxRevision else { throw Failure.invalidIntent }
      var nextScope: [String: SettingsJSONValue] = ["accountId": action["accountId"]!, "generation": .number(generation + 1)]
      if let session = action["sessionId"] { nextScope["sessionId"] = session }
      if state["ownership"] == .string("never-linked"), priorScope["accountId"] == .null, action["accountId"] != .null {
        pending = pending.map { value in
          var entry = value.object ?? [:]
          entry["originScope"] = entry["scope"]
          entry["scope"] = .object(nextScope)
          return .object(entry)
        }
      } else { pending.removeAll() } // Retire obsolete provenance without changing useful local choices.
      state["scope"] = .object(nextScope)
      state["anchor"] = .null
      if action["accountId"] != .null, state["ownership"] != .string("never-linked") {
        state["paused"] = .string("ownership-unconfirmed")
      }
      state["pending"] = .array(pending)
      if priorScope["accountId"] != .null || action["accountId"] != .null { state["ownership"] = .string("previous-account") }
      let oldEpoch: Double
      if case .number(let value) = root["syncEpoch"] { oldEpoch = value } else { oldEpoch = 0 }
      guard oldEpoch < SettingsV2Migration.maxRevision else { throw Failure.invalidIntent }
      root["syncEpoch"] = .number(oldEpoch + 1)
    } else if action["action"] == .string("acknowledge") {
      guard Set(action.keys) == Set(["action", "envelope", "scope"]), let captured = action["scope"]?.object else { throw Failure.invalidIntent }
      // Scope identity is its three members (sameSettingsScope), never whole-object equality.
      if !sameScope(captured, priorScope) { return raw }
      guard sequence < SettingsV2Migration.maxRevision else { throw Failure.unreadable }
      guard let local = root["settings"]?.object, local["schemaVersion"] == .number(2),
        case .ready = SettingsV2Migration.read(try encoder.encode(local), provenance: .init(kind: "readable-local", provenInitialization: local["updatedAt"] == .number(0)))
      else { throw Failure.unreadable }
      guard let envelope = action["envelope"]?.object, envelope["protocol"] == .number(2),
        let anchor = receipt(envelope["receipt"]), anchor["lineage"] == envelope["lineage"], anchor["revision"] == envelope["version"],
        let remote = envelope["settings"]?.object, case .bool(let empty) = envelope["empty"],
        case .number(let revision) = anchor["revision"],
        case .ready(let canonical, _) = SettingsV2Migration.read(try encoder.encode(remote), provenance: .init(kind: "acknowledged-account", revision: revision, provenInitialization: empty)),
        var settings = root["settings"]?.object else { throw Failure.invalidIntent }
      for path in PackagedFeatureRegistry.settingsFields {
        guard try ordered(canonical.document, path: path).baseRevision <= revision else { throw Failure.invalidIntent }
      }
      if let prior = receipt(state["anchor"]) {
        guard prior["lineage"] == anchor["lineage"], case .number(let oldRevision) = prior["revision"], revision >= oldRevision else { throw Failure.invalidIntent }
      }
      let original = settings
      settings.merge(canonical.document) { _, new in new }
      for group in ["services", "sites", "clocks"] {
        settings[group] = .object((original[group]?.object ?? [:]).merging(canonical.document[group]?.object ?? [:]) { _, new in new })
      }
      var clocks = settings["clocks"]!.object!
      for path in PackagedFeatureRegistry.settingsFields {
        clocks[path] = .object((original["clocks"]?.object?[path]?.object ?? [:]).merging(canonical.document["clocks"]!.object![path]!.object!) { _, new in new })
      }
      settings["clocks"] = .object(clocks)
      var retained: [SettingsJSONValue] = []
      for entry in pending {
        guard var operation = entry.object, let scope = operation["scope"]?.object,
          case .array(let ops) = operation["operations"] else { throw Failure.unreadable }
        if !sameScope(scope, captured) { continue }
        var remains = false
        for value in ops {
          guard let op = value.object, case .string(let path) = op["path"],
            PackagedFeatureRegistry.settingsFields.contains(path), case .bool(let on) = op["value"],
            let local = SettingsOrderedField(value: on, stamp: (clocks[path]?.object ?? [:]).merging(["baseRevision": op["baseRevision"] ?? .null, "localStep": op["localStep"] ?? .null]) { _, new in new }) else { throw Failure.unreadable }
          let remote = try ordered(canonical.document, path: path)
          let winner = SettingsFieldOrder.merge(try ordered(settings, path: path), local)
          setField(&settings, path, winner.value)
          clocks[path] = .object(winner.stamp)
          settings["clocks"] = .object(clocks)
          if SettingsFieldOrder.pendingAfterAck(local, canonical: remote) != nil { remains = true }
        }
        if remains {
          if operation["receipt"] == .null, operation["originScope"]?.object?["accountId"] == .null { operation["receipt"] = .object(anchor) }
          retained.append(.object(operation))
        }
      }
      settings["clocks"] = .object(clocks)
      if state["paused"] == .string("ownership-unconfirmed") {
        var held = state["held"]!.object!
        if empty {
          for path in PackagedFeatureRegistry.settingsFields {
            guard let originalValue = field(original, path), let canonicalValue = field(settings, path) else { throw Failure.unreadable }
            let local = held[path] ?? .bool(originalValue)
            if local != .bool(canonicalValue) { held[path] = local }
            else { held.removeValue(forKey: path) }
          }
        } else { held.removeAll() }
        state["held"] = .object(held)
        state["paused"] = held.isEmpty ? .null : .string("ownership-hold")
      } else if case .string(let pause) = state["paused"], ["awaiting-anchor", "pending-limit", "ownership-hold", "ordering-hold"].contains(pause) {
        var held = state["held"]!.object!
        for path in PackagedFeatureRegistry.settingsFields {
          if let value = field(settings, path), held[path] == .bool(value) { held.removeValue(forKey: path) }
        }
        state["held"] = .object(held)
      }
      state["pending"] = .array(retained)
      state["anchor"] = .object(anchor)
      resolvePause(&state, held: state["held"]!.object!)
      settings["pauses"] = .array([]) // The TypeScript writer's legacy projection on every write.
      root["settings"] = .object(settings)
      if envelope["serverUpdatedAt"] == .null { root["syncMetadata"] = .null }
      else {
        guard case .string(let time) = envelope["serverUpdatedAt"] else { throw Failure.invalidIntent }
        root["syncMetadata"] = .object(["version": .number(revision), "serverUpdatedAt": .string(time), "lastWriteId": envelope["lastWriteId"] ?? .null])
      }
    } else { throw Failure.invalidIntent }
    state["sequence"] = .number(sequence + 1)
    root["atomic"] = .object(state)
    let result = try encoder.encode(root)
    guard result.count <= 131_072 else { throw Failure.unreadable }
    return result
  }

  /// Volatile fallback keeps an actual requested choice without issuing any new ordering stamp.
  public static func hold(_ raw: Data, path: String, value: Bool) throws -> (data: Data, changed: Bool) {
    guard PackagedFeatureRegistry.settingsFields.contains(path) else { throw Failure.unknownField }
    var root = try decode(raw)
    guard var state = root["atomic"]?.object, validState(state), var held = state["held"]?.object,
      case .number(let sequence) = state["sequence"], sequence < SettingsV2Migration.maxRevision else { throw Failure.unreadable }
    held[path] = .bool(value)
    state["held"] = .object(held)
    state["paused"] = .string("coordination-unavailable")
    state["sequence"] = .number(sequence + 1)
    root["atomic"] = .object(state)
    return (try encoder.encode(root), true)
  }

  /// Mirrors TypeScript compactNeverLinkedPending. Only an initial, wholly unsubmitted local
  /// journal may discard superseded requests: whole winning requests (multi-field bodies and exact
  /// rank ties included) are kept unchanged, and every other shape keeps its journal immutable.
  private static func compactNeverLinkedPending(_ root: [String: SettingsJSONValue], state: [String: SettingsJSONValue]) -> [SettingsJSONValue] {
    guard case .array(let pending) = state["pending"] else { return [] }
    guard state["ownership"] == .string("never-linked"), let scope = state["scope"]?.object,
      scope["accountId"] == .null, scope["generation"] == .number(0), scope["sessionId"] == nil,
      root["syncEpoch"] == .number(0), root["syncMetadata"] == .null, state["anchor"] == .null, validState(state),
      pending.allSatisfy({ entry in
        guard let item = entry.object else { return false }
        return item["receipt"] == .null && item["originScope"] == nil && sameScope(item["scope"]?.object, scope)
      }) else { return pending }
    func ranks(_ entry: SettingsJSONValue) -> [(path: String, base: Double, step: Double)] {
      guard case .array(let operations) = entry.object?["operations"] else { return [] }
      return operations.compactMap { operation in
        guard let op = operation.object, case .string(let path) = op["path"],
          case .number(let base) = op["baseRevision"], case .number(let step) = op["localStep"] else { return nil }
        return (path, base, step)
      }
    }
    var latest: [String: (base: Double, step: Double)] = [:]
    for entry in pending {
      for op in ranks(entry) {
        if let prior = latest[op.path], !(op.base > prior.base || op.base == prior.base && op.step > prior.step) { continue }
        latest[op.path] = (op.base, op.step)
      }
    }
    return pending.filter { entry in
      ranks(entry).contains { op in latest[op.path].map { $0.base == op.base && $0.step == op.step } ?? false }
    }
  }

  /// AtomicSettingsWriter.commit's view of an absent record: defaults, no sync metadata, never
  /// repointed. It is what a no-op answer reports, never something saved on its own.
  public static func absentRecord() throws -> Data {
    try encoder.encode(absentRoot())
  }
  private static func absentRoot() throws -> [String: SettingsJSONValue] {
    ["settings": try JSONDecoder().decode(SettingsJSONValue.self, from: encoder.encode(StillSettings.default)),
      "syncMetadata": .null, "syncEpoch": .number(0)]
  }

  /// `data` is the record the locked backing must hold afterwards. It is nil only when the record
  /// was absent and the intent changed nothing: as in the TypeScript writer, a no-op never turns
  /// startup defaults into a saved record.
  public static func commit(_ raw: Data?, path: String, value: Bool, updatedAt: Int) throws -> (data: Data?, changed: Bool) {
    try commit(raw, path: path, value: value, updatedAt: updatedAt, writeId: { UUID().uuidString.lowercased() })
  }

  /// Internal so only shared parity vectors (via @testable) can replay the reference writer's
  /// request identities. Every identity must still be a canonical lowercase UUID.
  static func commit(_ raw: Data?, path: String, value: Bool, updatedAt: Int,
    writeId: () -> String) throws -> (data: Data?, changed: Bool) {
    guard PackagedFeatureRegistry.settingsFields.contains(path) else { throw Failure.unknownField }
    guard updatedAt > 0, Double(updatedAt) <= SettingsV2Migration.maxRevision else { throw Failure.invalidIntent }
    var root: [String: SettingsJSONValue]
    if let raw { root = try decode(raw) }
    else { root = try absentRoot() }
    var settings = root["settings"]?.object ?? root
    guard let priorValue = field(settings, path) else { throw Failure.unreadable }
    if var atomic = root["atomic"]?.object {
      guard validState(atomic), atomic["format"] == .number(1), case .number(let sequence) = atomic["sequence"], sequence >= 0, sequence < SettingsV2Migration.maxRevision, sequence.rounded(.towardZero) == sequence, let scope = atomic["scope"]?.object,
        case .array(var pending) = atomic["pending"], var held = atomic["held"]?.object,
        let clocks = settings["clocks"]?.object, let stamp = clocks[path]?.object,
        let prior = SettingsOrderedField(value: priorValue, stamp: stamp),
        case .ready = SettingsV2Migration.read(try encoder.encode(settings), provenance: .init(kind: "readable-local", provenInitialization: settings["updatedAt"] == .number(0)))
      else { throw Failure.unreadable }
      if atomic["ownership"] == .string("unknown"), scope["accountId"] == .null {
        // Retained unknown local-only authority, exactly as AtomicSettingsWriter.commit: the choice
        // is saved in place with a local stamp, the existing requests stay untouched and nothing new
        // is queued, so there is no pending limit. Any other unknown null-scope shape is refused.
        guard permitsUnknownLocalEdit(atomic, settings: root["settings"]?.object, legacyPause: true) else { throw Failure.unavailable }
        // A matching overlay alone is not a saved field; persist the person's deliberate choice.
        if priorValue == value && held[path] == nil { return (raw, false) }
        held.removeValue(forKey: path)
        switch SettingsFieldOrder.edit(prior, acknowledgedRevision: 0, requestedValue: value) {
        case .edited(let next):
          setField(&settings, path, value)
          var nextClocks = clocks
          nextClocks[path] = .object(next.stamp)
          settings["clocks"] = .object(nextClocks)
          settings["updatedAt"] = .number(Double(updatedAt))
        case .unchanged: break
        case .hold, .recovery: throw Failure.unavailable
        }
        settings["pauses"] = .array([]) // Same legacy projection as the TypeScript writer.
        atomic["paused"] = .null // Only null or the retired pending-limit pause reaches here.
        atomic["held"] = .object(held)
        atomic["sequence"] = .number(sequence + 1)
        root["atomic"] = .object(atomic)
        root["settings"] = .object(settings)
        let result = try encoder.encode(root)
        guard result.count <= 131_072 else { throw Failure.unreadable }
        return (result, true)
      }
      let effective = held[path] ?? .bool(priorValue)
      if effective == .bool(value) { return (raw, false) }
      pending = compactNeverLinkedPending(root, state: atomic).filter { sameScope($0.object?["scope"]?.object, scope) }
      let anchor = atomic["anchor"]?.object
      let revision: Double
      if case .number(let n) = anchor?["revision"] { revision = n }
      else { revision = 0 }
      let edit = SettingsFieldOrder.edit(prior, acknowledgedRevision: revision, requestedValue: value)
      if case .edited(let next) = edit, pending.count < 64, (scope["accountId"] == .null || anchor != nil) {
        setField(&settings, path, value)
        var nextClocks = clocks
        nextClocks[path] = .object(next.stamp)
        settings["clocks"] = .object(nextClocks)
        // Only an allocated edit restamps the projection; holds and unchanged answers keep it.
        settings["updatedAt"] = .number(Double(updatedAt))
        held.removeValue(forKey: path)
        resolvePause(&atomic, held: held)
        let id = writeId()
        guard canonicalUUID(.string(id)), !pending.contains(where: { $0.object?["writeId"] == .string(id) }) else { throw Failure.unavailable }
        pending.append(.object([
          "writeId": .string(id), "scope": .object(scope),
          "receipt": atomic["anchor"] ?? .null,
          "operations": .array([.object(["path": .string(path), "value": .bool(value),
            "baseRevision": .number(next.baseRevision), "localStep": .number(next.localStep)])])
        ]))
      } else if case .unchanged = edit {
        held.removeValue(forKey: path)
        resolvePause(&atomic, held: held)
      } else {
        // Preserve a local choice without fabricating an ordering stamp at saturation/recovery.
        held[path] = .bool(value)
        if atomic["paused"] != .string("ownership-unconfirmed") {
          atomic["paused"] = .string(pending.count >= 64 ? "pending-limit" : scope["accountId"] != .null && anchor == nil ? "awaiting-anchor" : "ordering-hold")
        }
      }
      atomic["sequence"] = .number(sequence + 1)
      atomic["pending"] = .array(pending)
      atomic["held"] = .object(held)
      root["atomic"] = .object(atomic)
      settings["pauses"] = .array([]) // The TypeScript writer's legacy projection on every write.
    } else {
      // Existing V2 behavior remains until coordinated protocol rollout. Expanded schema is held.
      guard settings["schemaVersion"] == nil || settings["schemaVersion"] == .number(1),
        path == "globalOn" || path.hasPrefix("services."),
        (try? JSONDecoder().decode(StillSettings.self, from: encoder.encode(settings))) != nil
      else { throw Failure.unreadable }
      if priorValue == value { return (raw, false) }
      setField(&settings, path, value)
      // As AtomicSettingsWriter.commit: watched legacy peers reject equal or older stamps, so the
      // stamp is allocated from this locked durable read and a same-millisecond or backward clock
      // cannot hide a genuine later choice.
      let previous: Double
      if case .number(let n) = settings["updatedAt"] { previous = n } else { previous = 0 }
      let stamped = max(Double(updatedAt), previous.rounded(.down) + 1)
      guard stamped <= SettingsV2Migration.maxRevision else { throw Failure.unavailable }
      settings["updatedAt"] = .number(stamped)
    }
    if root["settings"] == nil { root = ["syncMetadata": .null] }
    root["settings"] = .object(settings)
    let result = try encoder.encode(root)
    guard result.count <= 131_072 else { throw Failure.unreadable }
    return (result, true)
  }
}
