import Foundation

/// Preservation-only JSON. Unknown fields never grant access or add blocking semantics.
public indirect enum SettingsJSONValue: Codable, Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([SettingsJSONValue])
  case object([String: SettingsJSONValue])

  public var object: [String: SettingsJSONValue]? {
    if case .object(let value) = self { return value }
    return nil
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let value = try? c.decode(Bool.self) { self = .bool(value) }
    else if let value = try? c.decode(Double.self) { self = .number(value) }
    else if let value = try? c.decode(String.self) { self = .string(value) }
    else if let value = try? c.decode([SettingsJSONValue].self) { self = .array(value) }
    else { self = .object(try c.decode([String: SettingsJSONValue].self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    }
  }
}

/// Provenance is supplied by the installation/account authority, never guessed from an empty read.
public struct SettingsV2Provenance: Sendable {
  public let kind: String
  public let revision: Double?
  public let provenInitialization: Bool
  public init(kind: String, revision: Double? = nil, provenInitialization: Bool = false) {
    self.kind = kind
    self.revision = revision
    self.provenInitialization = provenInitialization
  }
}

public enum SettingsV2RecoveryReason: String, Codable, Equatable, Sendable {
  case missingProvenance = "missing-provenance"
  case provenanceConflict = "provenance-conflict"
  case missingData = "missing-data"
  case malformed
  case futureSchema = "future-schema"
  case unsupportedSchema = "unsupported-schema"
  case bounds
}

public enum SettingsV2ReadResult: Equatable, Sendable {
  case ready(SettingsV2, migrated: Bool)
  /// Raw damaged/future bytes and individually valid choices remain available to U3 repair.
  case recovery(reason: SettingsV2RecoveryReason, original: Data?, usableFields: [String: Bool])
}

/// This packaged model does not write to SharedSettingsStore or accept remote ordering authority.
public struct SettingsV2: Equatable, Sendable {
  public let document: [String: SettingsJSONValue]

  public func serialized() throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(document)
  }
}

public enum SettingsV2Migration {
  public static let maxRevision = 9_007_199_254_740_991.0
  public static let maxLocalStep = 1_048_575.0
  private static let maxBytes = 65_536
  private static let unsafeKeys = Set(["__proto__", "prototype", "constructor"])

  private static func integer(_ value: SettingsJSONValue?, maximum: Double) -> Bool {
    guard case .number(let n) = value else { return false }
    return n.isFinite && n >= 0 && n <= maximum && n.rounded(.towardZero) == n
  }

  private static func bounded(_ value: SettingsJSONValue, depth: Int, nodes: inout Int) -> Bool {
    nodes += 1
    guard nodes <= 4_096, depth <= 8 else { return false }
    switch value {
    case .null, .bool: return true
    case .number(let n): return n.isFinite && abs(n) <= maxRevision
    case .string(let s): return s.utf8.count <= 8_192
    case .array(let values):
      return values.count <= 128 && values.allSatisfy { bounded($0, depth: depth + 1, nodes: &nodes) }
    case .object(let values):
      return values.count <= 128 && values.allSatisfy { key, v in
        key.utf8.count <= 128 && !unsafeKeys.contains(key) && bounded(v, depth: depth + 1, nodes: &nodes)
      }
    }
  }

  private static func usable(_ value: SettingsJSONValue?) -> [String: Bool] {
    guard let obj = value?.object else { return [:] }
    var result: [String: Bool] = [:]
    if case .bool(let v) = obj["globalOn"] { result["globalOn"] = v }
    for (group, ids) in [("services", PackagedFeatureRegistry.serviceIDs), ("sites", PackagedFeatureRegistry.featureIDs)] {
      guard let values = obj[group]?.object else { continue }
      for id in ids {
        if case .bool(let v) = values[id] { result["\(group).\(id)"] = v }
      }
    }
    return result
  }

  /// Pure deterministic lazy migration. Public persistence awaits U3's atomic/ownership protection.
  public static func read(_ raw: Data?, provenance: SettingsV2Provenance) -> SettingsV2ReadResult {
    var decoded: SettingsJSONValue?
    var keyCollision = false
    // Check nesting before recursive Codable decoding, including opaque future data.
    let withinEncodedBounds = raw.map { $0.count <= maxBytes && !exceedsNestingBound($0) } ?? false
    if let raw, withinEncodedBounds {
      if let tree = try? JSONSerialization.jsonObject(with: raw) {
        keyCollision = hasKeyCollision(tree)
      }
      decoded = try? JSONDecoder().decode(SettingsJSONValue.self, from: raw)
    }
    func recovery(_ reason: SettingsV2RecoveryReason) -> SettingsV2ReadResult {
      .recovery(reason: reason, original: raw, usableFields: usable(decoded))
    }
    guard ["proven-fresh", "readable-local", "acknowledged-account"].contains(provenance.kind) else { return recovery(.missingProvenance) }
    if provenance.kind == "acknowledged-account" {
      guard let revision = provenance.revision, integer(.number(revision), maximum: maxRevision) else { return recovery(.missingProvenance) }
    }
    if provenance.kind == "proven-fresh" {
      guard raw == nil else { return recovery(.provenanceConflict) }
      let services = Dictionary(uniqueKeysWithValues: PackagedFeatureRegistry.serviceIDs.map { ($0, SettingsJSONValue.bool(true)) })
      let sites = Dictionary(uniqueKeysWithValues: PackagedFeatureRegistry.features.map { ($0.id, SettingsJSONValue.bool($0.freshDefault)) })
      let clocks = Dictionary(uniqueKeysWithValues: PackagedFeatureRegistry.settingsFields.map { ($0, stamp(0)) })
      return .ready(SettingsV2(document: ["schemaVersion": .number(2), "globalOn": .bool(true), "services": .object(services), "sites": .object(sites), "clocks": .object(clocks), "updatedAt": .number(0)]), migrated: true)
    }
    guard raw != nil else { return recovery(.missingData) }
    guard withinEncodedBounds else { return recovery(.bounds) }
    guard !keyCollision, let decoded else { return recovery(.malformed) }
    guard var input = decoded.object else { return recovery(.bounds) }
    var nodes = 0
    guard bounded(decoded, depth: 0, nodes: &nodes) else { return recovery(.bounds) }
    let version = input["schemaVersion"]
    if case .number(let n) = version, n > 2 { return recovery(.futureSchema) }
    guard version == nil || version == .number(1) || version == .number(2) else { return recovery(.unsupportedSchema) }
    guard case .bool = input["globalOn"], integer(input["updatedAt"], maximum: maxRevision), input["updatedAt"] != .number(0) || provenance.provenInitialization, var services = input["services"]?.object else { return recovery(.malformed) }
    if let pauses = input["pauses"] {
      guard case .array(let values) = pauses, values.allSatisfy({ if case .string = $0 { return true }; return false }) else { return recovery(.malformed) }
    }
    if input["sites"] != nil && input["sites"]?.object == nil { return recovery(.malformed) }
    var sites = input["sites"]?.object ?? [:]
    guard sites["tiktok"] == nil && sites["tiktok.all"] == nil else { return recovery(.malformed) }
    for id in PackagedFeatureRegistry.serviceIDs {
      if let v = services[id] { guard case .bool = v else { return recovery(.malformed) } }
      else if version == .number(2) { return recovery(.malformed) }
      else { services[id] = .bool(false) }
    }
    for f in PackagedFeatureRegistry.features {
      if let v = sites[f.id] { guard case .bool = v else { return recovery(.malformed) } }
      else if version == .number(2) { return recovery(.malformed) }
      else { sites[f.id] = f.tier == "free" ? services[f.service] : .bool(false) }
    }
    var clocks: [String: SettingsJSONValue]
    if version == .number(2) {
      guard let values = input["clocks"]?.object else { return recovery(.malformed) }
      clocks = values
      guard clocks["sites.tiktok"] == nil && clocks["sites.tiktok.all"] == nil else { return recovery(.malformed) }
      for (field, value) in clocks {
        guard let s = value.object, integer(s["baseRevision"], maximum: maxRevision), integer(s["localStep"], maximum: maxLocalStep), PackagedFeatureRegistry.settingsFields.contains(field) || field.hasPrefix("services.") || field.hasPrefix("sites.") else { return recovery(.malformed) }
      }
      guard PackagedFeatureRegistry.settingsFields.allSatisfy({ clocks[$0] != nil }) else { return recovery(.malformed) }
    } else {
      guard input["clocks"] == nil else { return recovery(.malformed) }
      let revision = provenance.kind == "acknowledged-account" ? max(1, provenance.revision ?? 0) : 0
      clocks = Dictionary(uniqueKeysWithValues: PackagedFeatureRegistry.settingsFields.map { field in
        let supplied: Bool
        if field == "globalOn" { supplied = true }
        else if field.hasPrefix("services.") { supplied = input["services"]?.object?[String(field.dropFirst(9))] != nil }
        else { supplied = input["sites"]?.object?[String(field.dropFirst(6))] != nil }
        return (field, stamp(supplied ? revision : 0))
      })
    }
    input["schemaVersion"] = .number(2)
    input["services"] = .object(services)
    input["sites"] = .object(sites)
    input["clocks"] = .object(clocks)
    input.removeValue(forKey: "pauses")
    let settings = SettingsV2(document: input)
    nodes = 0
    guard bounded(.object(input), depth: 0, nodes: &nodes), let data = try? settings.serialized(), data.count <= maxBytes else { return recovery(.bounds) }
    return .ready(settings, migrated: version != .number(2))
  }

  // Foundation preserves distinct UTF-8 object names in NSDictionary. Swift String keys
  // compare canonical equivalents equal, so Codable would discard one before migration.
  private static func hasKeyCollision(_ value: Any) -> Bool {
    if let values = value as? NSDictionary {
      var keys = Set<String>()
      for key in values.allKeys {
        guard let key = key as? String, keys.insert(key).inserted else { return true }
      }
      return values.allValues.contains { hasKeyCollision($0) }
    }
    if let values = value as? NSArray { return values.contains { hasKeyCollision($0) } }
    return false
  }

  private static func exceedsNestingBound(_ raw: Data) -> Bool {
    var depth = 0
    var quoted = false
    var escaped = false
    for byte in raw {
      if quoted {
        if escaped { escaped = false }
        else if byte == 92 { escaped = true }
        else if byte == 34 { quoted = false }
      } else if byte == 34 { quoted = true }
      else if byte == 123 || byte == 91 {
        depth += 1
        if depth > 9 { return true }
      } else if byte == 125 || byte == 93 { depth -= 1 }
    }
    return false
  }

  private static func stamp(_ revision: Double) -> SettingsJSONValue {
    .object(["baseRevision": .number(revision), "localStep": .number(0)])
  }
}
