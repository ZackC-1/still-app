import Foundation

/// Pure ordering projection, never an authenticated receipt or a second settings authority.
public struct SettingsOrderedField: Equatable, Sendable {
  public let value: Bool
  public let stamp: [String: SettingsJSONValue]
  public var baseRevision: Double { if case .number(let n) = stamp["baseRevision"] { return n }; preconditionFailure("Validated stamp") }
  public var localStep: Double { if case .number(let n) = stamp["localStep"] { return n }; preconditionFailure("Validated stamp") }

  public init?(value: Bool, stamp: [String: SettingsJSONValue]) {
    guard case .number(let base) = stamp["baseRevision"], case .number(let step) = stamp["localStep"],
      SettingsFieldOrder.integer(base, maximum: SettingsV2Migration.maxRevision),
      SettingsFieldOrder.integer(step, maximum: SettingsV2Migration.maxLocalStep) else { return nil }
    self.value = value
    self.stamp = stamp
  }

  /// Strict types, including Bool versus numeric JSON; whole-document bounds belong to migration.
  public init?(json: SettingsJSONValue) {
    guard let obj = json.object, case .bool(let value) = obj["value"], let stamp = obj["stamp"]?.object else { return nil }
    self.init(value: value, stamp: stamp)
  }
}

public enum SettingsFieldEditResult: Equatable, Sendable {
  case unchanged(SettingsOrderedField)
  case edited(SettingsOrderedField)
  /// Preserve requested local choice separately; the prior stamp cannot safely rank it.
  case hold(SettingsOrderedField, requestedValue: Bool)
  case recovery(SettingsOrderedField, requestedValue: Bool, reason: SettingsFieldOrder.RecoveryReason)

  public var field: SettingsOrderedField {
    switch self {
    case .unchanged(let field), .edited(let field), .hold(let field, _), .recovery(let field, _, _): return field
    }
  }
  public var requestedValue: Bool? {
    switch self {
    case .hold(_, let value), .recovery(_, let value, _): return value
    default: return nil
    }
  }

}

public enum SettingsFieldOrder {
  public enum RecoveryReason: String, Sendable { case invalidAcknowledgement = "invalid-acknowledgement", staleAcknowledgement = "stale-acknowledgement" }
  public enum FieldError: Error { case unknownField }

  fileprivate static func integer(_ value: Double, maximum: Double) -> Bool {
    value.isFinite && value >= 0 && value <= maximum && value.rounded(.towardZero) == value
  }
  private static func sameOrder(_ a: SettingsOrderedField, _ b: SettingsOrderedField) -> Bool {
    a.baseRevision == b.baseRevision && a.localStep == b.localStep
  }

  /// An exact revision/step tie selects Off. Wall time never participates.
  public static func merge(_ left: SettingsOrderedField, _ right: SettingsOrderedField) -> SettingsOrderedField {
    if sameOrder(left, right) { return left.value ? right : left }
    if left.baseRevision != right.baseRevision { return left.baseRevision > right.baseRevision ? left : right }
    return left.localStep > right.localStep ? left : right
  }

  /// The adapter supplies the trusted acknowledgement. Only a deliberate changed choice is an edit.
  public static func edit(_ prior: SettingsOrderedField, acknowledgedRevision: Double, requestedValue: Bool) -> SettingsFieldEditResult {
    if requestedValue == prior.value { return .unchanged(prior) }
    guard integer(acknowledgedRevision, maximum: SettingsV2Migration.maxRevision) else { return .recovery(prior, requestedValue: requestedValue, reason: .invalidAcknowledgement) }
    guard acknowledgedRevision >= prior.baseRevision else { return .recovery(prior, requestedValue: requestedValue, reason: .staleAcknowledgement) }
    if acknowledgedRevision == prior.baseRevision && prior.localStep == SettingsV2Migration.maxLocalStep { return .hold(prior, requestedValue: requestedValue) }
    var stamp = prior.stamp
    stamp["baseRevision"] = .number(acknowledgedRevision)
    stamp["localStep"] = .number(acknowledgedRevision > prior.baseRevision ? 1 : prior.localStep + 1)
    return .edited(SettingsOrderedField(value: requestedValue, stamp: stamp)!)
  }

  /// Sparse known-key maps only; absence is neither a default nor an edit.
  public static func mergeFields(_ left: [String: SettingsOrderedField], _ right: [String: SettingsOrderedField]) throws -> [String: SettingsOrderedField] {
    let known = Set(PackagedFeatureRegistry.settingsFields)
    guard left.keys.allSatisfy({ known.contains($0) }), right.keys.allSatisfy({ known.contains($0) }) else { throw FieldError.unknownField }
    return left.merging(right, uniquingKeysWith: merge)
  }

  public static func pendingAfterAck(_ pending: SettingsOrderedField?, canonical: SettingsOrderedField) -> SettingsOrderedField? {
    guard let pending else { return nil }
    let winner = merge(pending, canonical)
    return sameOrder(winner, pending) && winner.value == pending.value && !(sameOrder(pending, canonical) && pending.value == canonical.value) ? pending : nil
  }
}
