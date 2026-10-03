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
    if root["atomic"] != nil { return raw }
    let settings = root["settings"]?.object ?? root
    let original = try encoder.encode(settings)
    let provenance = SettingsV2Provenance(kind: "readable-local", provenInitialization: ownership == "never-linked" && settings["updatedAt"] == .number(0))
    guard case .ready(let modern, _) = SettingsV2Migration.read(original, provenance: provenance) else { throw Failure.unreadable }
    if root["settings"] == nil { root = ["syncMetadata": .null, "syncEpoch": .number(0)] }
    root["settings"] = .object(modern.document)
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
    // A never-linked null-to-null teardown has no account/session generation to retire.
    // Return the original bytes before saturation checks or complete-record replacement.
    if action["action"] == .string("scope"), Set(action.keys) == Set(["action", "accountId"]),
      action["accountId"] == .null, priorScope["accountId"] == .null, state["ownership"] == .string("never-linked") { return raw }
    guard sequence < SettingsV2Migration.maxRevision else { throw Failure.unreadable }
    if action["action"] == .string("scope") {
      guard Set(action.keys) == Set(["action", "accountId"]) || Set(action.keys) == Set(["action", "accountId", "sessionId"]),
        action["accountId"] == .null || canonicalUUID(action["accountId"]),
        case .number(let generation) = priorScope["generation"], generation < SettingsV2Migration.maxRevision else { throw Failure.invalidIntent }
      if action["sessionId"] != nil {
        guard action["accountId"] != .null, canonicalUUID(action["sessionId"]) else { throw Failure.invalidIntent }
      }
      if action["accountId"] != .null, action["accountId"] == priorScope["accountId"] {
        // UUID alone cannot establish continuity after an unsuccessful sign-out and process death.
        guard action["sessionId"] != nil, priorScope["sessionId"] != nil else { throw Failure.unavailable }
        if action["sessionId"] == priorScope["sessionId"] { return raw }
      }
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
      guard Set(action.keys) == Set(["action", "envelope", "scope"]), let captured = action["scope"]?.object,
        validScope(captured) else { throw Failure.invalidIntent }
      if captured != priorScope { return raw }
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
        if scope != captured { continue }
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

  public static func commit(_ raw: Data?, path: String, value: Bool, updatedAt: Int) throws -> (data: Data, changed: Bool) {
    guard PackagedFeatureRegistry.settingsFields.contains(path) else { throw Failure.unknownField }
    guard updatedAt > 0, Double(updatedAt) <= SettingsV2Migration.maxRevision else { throw Failure.invalidIntent }
    var root: [String: SettingsJSONValue]
    if let raw { root = try decode(raw) }
    else {
      root = ["settings": try JSONDecoder().decode(SettingsJSONValue.self, from: encoder.encode(StillSettings.default)), "syncMetadata": .null]
    }
    var settings = root["settings"]?.object ?? root
    guard let priorValue = field(settings, path) else { throw Failure.unreadable }
    if var atomic = root["atomic"]?.object {
      guard validState(atomic), atomic["format"] == .number(1), case .number(let sequence) = atomic["sequence"], sequence >= 0, sequence < SettingsV2Migration.maxRevision, sequence.rounded(.towardZero) == sequence, let scope = atomic["scope"]?.object,
        case .array(var pending) = atomic["pending"], var held = atomic["held"]?.object,
        let clocks = settings["clocks"]?.object, let stamp = clocks[path]?.object,
        let prior = SettingsOrderedField(value: priorValue, stamp: stamp),
        case .ready = SettingsV2Migration.read(try encoder.encode(settings), provenance: .init(kind: "readable-local", provenInitialization: settings["updatedAt"] == .number(0)))
      else { throw Failure.unreadable }
      let effective = held[path] ?? .bool(priorValue)
      if effective == .bool(value) { return (try raw ?? encoder.encode(root), false) }
      pending = pending.filter { $0.object?["scope"]?.object == scope }
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
        held.removeValue(forKey: path)
        resolvePause(&atomic, held: held)
        pending.append(.object([
          "writeId": .string(UUID().uuidString.lowercased()), "scope": .object(scope),
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
    } else {
      // Existing V2 behavior remains until coordinated protocol rollout. Expanded schema is held.
      guard settings["schemaVersion"] == nil || settings["schemaVersion"] == .number(1),
        path == "globalOn" || path.hasPrefix("services."),
        (try? JSONDecoder().decode(StillSettings.self, from: encoder.encode(settings))) != nil
      else { throw Failure.unreadable }
      if priorValue == value { return (try raw ?? encoder.encode(root), false) }
      setField(&settings, path, value)
    }
    settings["updatedAt"] = .number(Double(updatedAt))
    if root["settings"] == nil { root = ["syncMetadata": .null] }
    root["settings"] = .object(settings)
    let result = try encoder.encode(root)
    guard result.count <= 131_072 else { throw Failure.unreadable }
    return (result, true)
  }
}
