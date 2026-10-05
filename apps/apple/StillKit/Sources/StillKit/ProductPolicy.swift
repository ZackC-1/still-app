import Foundation

/// Remote product policy grammar and fail-safe evaluator (U6), the Swift twin of
/// `packages/shared-types/src/product-policy.ts` (grammar) and
/// `packages/core/src/entitlement/product-policy.ts` (evaluator). Both run the shared vectors in
/// `packages/shared-types/fixtures/product-policy-vectors.json` and must give identical verdicts.
///
/// Dormant: no fetch, storage or caller uses this yet. It never decides access (`paidMode` stays
/// the compiled `MonetizationConfig.paidTierEnabled`), and free blocking, free sync and Restore
/// never consult it.
///
/// Two keys for sales: the compiled flag (passed in from packaged code, never read from the
/// payload) AND the remote sales policy AND an allowlisted packaged build. With the compiled flag
/// false every remote value is inert. Missing, late, oversized, invalid, wrong-environment, stale
/// or unknown input is Off. Nothing in a payload is ever evaluated as code.
///
/// Wire format: a deliberately restricted JSON. ASCII only; strings without escapes; numbers are
/// non-negative safe integers; unique object keys; shallow nesting. Foundation's JSON parsers are
/// not used for the body because they disagree with JavaScript on duplicate keys, byte-order
/// marks, trailing commas and Boolean/number bridging.
///
/// To extend the grammar, add a field to `salesFields` or `ratingFields` (and the TypeScript twin)
/// and add vectors. Never add free text, URLs, prices, thresholds, feature tiers, rule content or
/// a switch for free blocking or sync.
public enum ProductPolicy {
  public static let schema = 1
  public static let maxBytes = 8192
  public static let maxBuilds = 32
  public static let maxDepth = 4
  /// A fresh check counts only when consumed within this many milliseconds of its request start.
  public static let freshWindowMs = 5000
  static let maxSafeInteger = 9_007_199_254_740_991

  public static let environments = ["sandbox", "production"]
  /// The fixed supported surface groups. Safari maps to its Apple host, never a second surface.
  public static let surfaces = [
    "chrome_desktop", "edge_desktop", "firefox_desktop", "firefox_android",
    "apple_mobile_host", "apple_macos_host",
  ]
  /// Remembered by the owner view but with no enabled launch producer: always inert.
  public static let deferredSurfaces: Set<String> = ["edge_desktop"]
  public static let salesChannels = ["apple", "web"]
  /// Packaged mapping from a surface to the only channel it may ever start a purchase through.
  public static let salesChannelBySurface: [String: String] = [
    "chrome_desktop": "web", "firefox_desktop": "web", "firefox_android": "web",
    "apple_mobile_host": "apple", "apple_macos_host": "apple",
  ]
  /// Reviewed offers a channel may reference. A remote value outside this list is invalid.
  public static let salesOffers = ["still-pro-v3"]

  public enum Namespace: String, Sendable { case sales, rating }

  public enum Reason: String, Equatable, Sendable {
    case context
    case compiledOff = "compiled_off"
    case deferredSurface = "deferred_surface"
    case missing, late, oversized, invalid, environment, stale, build, off, on
  }

  public struct Verdict: Equatable, Sendable {
    public let allowed: Bool
    public let reason: Reason
    /// Present only once the body fully validated for this environment.
    public let revision: Int?
    init(_ reason: Reason, revision: Int? = nil) {
      self.allowed = reason == .on
      self.reason = reason
      self.revision = revision
    }
  }

  /// Packaged identity only. No request, payload, cache or account may supply any of these.
  public struct Context: Sendable {
    public let paidTierEnabled: Bool
    public let environment: String
    public let surface: String
    public let build: String
    public init(paidTierEnabled: Bool = MonetizationConfig.paidTierEnabled, environment: String, surface: String, build: String) {
      self.paidTierEnabled = paidTierEnabled
      self.environment = environment
      self.surface = surface
      self.build = build
    }
  }

  /// One fresh check: raw body (nil when absent) plus monotonic request-start/consumption times.
  public struct Response: Sendable {
    public let body: Data?
    public let requestStartedAt: Int
    public let evaluatedAt: Int
    public init(body: Data?, requestStartedAt: Int, evaluatedAt: Int) {
      self.body = body
      self.requestStartedAt = requestStartedAt
      self.evaluatedAt = evaluatedAt
    }
  }

  public struct Build: Equatable, Sendable {
    public let surface: String
    public let build: String
  }

  /// A validated policy. Only the fields the evaluator needs are surfaced as typed properties.
  public struct Policy: Equatable, Sendable {
    public let environment: String
    public let revision: Int
    public let builds: [Build]
    /// Sales: the remote master. Rating: nil.
    public let paidTierEnabled: Bool?
    /// Sales: channel -> enabled. Rating: empty.
    public let channels: [String: Bool]
    /// Rating: the master. Sales: nil.
    public let master: Bool?
    /// Rating: surface -> allowed. Sales: empty.
    public let surfaces: [String: Bool]
  }

  public enum GrammarError: Error, Equatable { case oversized, invalid }

  // MARK: Evaluator

  /// May this packaged build start a purchase right now? Restore never calls this.
  public static func evaluateSales(_ context: Context, _ response: Response?, highestSeenRevision: Int = 0) -> Verdict {
    guard validContext(context, highestSeenRevision) else { return Verdict(.context) }
    // Key one: the compiled constant from packaged code. The payload's flag is only key two.
    guard context.paidTierEnabled else { return Verdict(.compiledOff) }
    guard let channel = salesChannelBySurface[context.surface], !deferredSurfaces.contains(context.surface) else {
      return Verdict(.deferredSurface)
    }
    switch check(.sales, context, response, highestSeenRevision) {
    case .verdict(let verdict): return verdict
    case .policy(let policy):
      let on = policy.paidTierEnabled == true && policy.channels[channel] == true
      return Verdict(on ? .on : .off, revision: policy.revision)
    }
  }

  /// May this packaged build request a review prompt right now? Master AND surface AND build.
  public static func evaluateRating(_ context: Context, _ response: Response?, highestSeenRevision: Int = 0) -> Verdict {
    guard validContext(context, highestSeenRevision) else { return Verdict(.context) }
    guard !deferredSurfaces.contains(context.surface) else { return Verdict(.deferredSurface) }
    switch check(.rating, context, response, highestSeenRevision) {
    case .verdict(let verdict): return verdict
    case .policy(let policy):
      let on = policy.master == true && policy.surfaces[context.surface] == true
      return Verdict(on ? .on : .off, revision: policy.revision)
    }
  }

  private enum Checked { case verdict(Verdict), policy(Policy) }

  private static func check(_ namespace: Namespace, _ context: Context, _ response: Response?, _ highestSeenRevision: Int) -> Checked {
    guard let response, let body = response.body else { return .verdict(Verdict(.missing)) }
    let start = response.requestStartedAt, at = response.evaluatedAt
    guard safe(start), safe(at), at >= start, at - start < freshWindowMs else { return .verdict(Verdict(.late)) }
    let policy: Policy
    do { policy = try parse(namespace, body) } catch GrammarError.oversized {
      return .verdict(Verdict(.oversized))
    } catch { return .verdict(Verdict(.invalid)) }
    guard policy.environment == context.environment else { return .verdict(Verdict(.environment)) }
    guard policy.revision >= highestSeenRevision else { return .verdict(Verdict(.stale, revision: policy.revision)) }
    guard policy.builds.contains(Build(surface: context.surface, build: context.build)) else {
      return .verdict(Verdict(.build, revision: policy.revision))
    }
    return .policy(policy)
  }

  private static func safe(_ value: Int) -> Bool { value >= 0 && value <= maxSafeInteger }

  private static func validContext(_ context: Context, _ highestSeenRevision: Int) -> Bool {
    environments.contains(context.environment) && surfaces.contains(context.surface) &&
      validBuild(context.build) && safe(highestSeenRevision)
  }

  /// `^[a-z0-9][a-z0-9._-]{0,95}$`: lowercase, no `:` or `/`, so never a URL.
  static func validBuild(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard (1...96).contains(bytes.count) else { return false }
    for (index, byte) in bytes.enumerated() {
      let alnum = (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)
      if !(alnum || (index > 0 && (byte == 0x2e || byte == 0x5f || byte == 0x2d))) { return false }
    }
    return true
  }

  // MARK: Grammar

  /// Parse one namespace's body exactly. Throws `GrammarError`; never returns a partial.
  public static func parse(_ namespace: Namespace, _ body: Data) throws -> Policy {
    guard body.count <= maxBytes else { throw GrammarError.oversized }
    var parser = RestrictedJSONParser(bytes: Array(body))
    let root = try parser.parseDocument()
    let fields = namespace == .sales ? salesFields : ratingFields
    let object = try exactObject(root, keys: fields)
    let builds = try parseBuilds(object["builds"])
    guard case .int(let schemaValue)? = object["schema"], schemaValue == schema,
          case .string(let environment)? = object["environment"], environments.contains(environment),
          case .int(let revision)? = object["revision"], revision >= 1 else { throw GrammarError.invalid }
    switch namespace {
    case .sales:
      guard case .bool(let paid)? = object["paidTierEnabled"] else { throw GrammarError.invalid }
      let channelObject = try exactObject(object["channels"], keys: salesChannels)
      var channels: [String: Bool] = [:]
      for channel in salesChannels {
        let entry = try exactObject(channelObject[channel], keys: ["enabled", "offer"])
        guard case .bool(let enabled)? = entry["enabled"],
              case .string(let offer)? = entry["offer"], salesOffers.contains(offer) else { throw GrammarError.invalid }
        channels[channel] = enabled
      }
      return Policy(environment: environment, revision: revision, builds: builds, paidTierEnabled: paid,
                    channels: channels, master: nil, surfaces: [:])
    case .rating:
      guard case .bool(let master)? = object["master"] else { throw GrammarError.invalid }
      let surfaceObject = try exactObject(object["surfaces"], keys: surfaces)
      var allowed: [String: Bool] = [:]
      for surface in surfaces {
        guard case .bool(let value)? = surfaceObject[surface] else { throw GrammarError.invalid }
        allowed[surface] = value
      }
      return Policy(environment: environment, revision: revision, builds: builds, paidTierEnabled: nil,
                    channels: [:], master: master, surfaces: allowed)
    }
  }

  /// The complete closed key sets. Any other key anywhere is invalid.
  static let envelopeFields = ["schema", "environment", "revision", "builds"]
  static let salesFields = envelopeFields + ["paidTierEnabled", "channels"]
  static let ratingFields = envelopeFields + ["master", "surfaces"]

  private static func exactObject(_ value: RestrictedJSON?, keys: [String]) throws -> [String: RestrictedJSON] {
    guard case .object(let object)? = value, object.count == keys.count,
          keys.allSatisfy({ object[$0] != nil }) else { throw GrammarError.invalid }
    return object
  }

  private static func parseBuilds(_ value: RestrictedJSON?) throws -> [Build] {
    guard case .array(let items)? = value, items.count <= maxBuilds else { throw GrammarError.invalid }
    var builds: [Build] = []
    var seen = Set<String>()
    for item in items {
      let entry = try exactObject(item, keys: ["surface", "build"])
      guard case .string(let surface)? = entry["surface"], surfaces.contains(surface),
            case .string(let build)? = entry["build"], validBuild(build),
            seen.insert("\(surface) \(build)").inserted else { throw GrammarError.invalid }
      builds.append(Build(surface: surface, build: build))
    }
    return builds
  }
}

/// The restricted JSON tree. Kept internal: only the validated `ProductPolicy.Policy` leaves.
indirect enum RestrictedJSON: Equatable {
  case null
  case bool(Bool)
  case int(Int)
  case string(String)
  case array([RestrictedJSON])
  case object([String: RestrictedJSON])
}

struct RestrictedJSONParser {
  let bytes: [UInt8]
  var index = 0

  init(bytes: [UInt8]) { self.bytes = bytes }

  mutating func parseDocument() throws -> RestrictedJSON {
    let value = try parseValue(depth: 0)
    skipWhitespace()
    guard index == bytes.count else { throw ProductPolicy.GrammarError.invalid }
    return value
  }

  private var current: UInt8? { index < bytes.count ? bytes[index] : nil }

  private mutating func skipWhitespace() {
    while let byte = current, byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0d { index += 1 }
  }

  private mutating func expect(_ byte: UInt8) throws {
    guard current == byte else { throw ProductPolicy.GrammarError.invalid }
    index += 1
  }

  private mutating func parseString() throws -> String {
    try expect(0x22)
    let start = index
    while true {
      guard let byte = current else { throw ProductPolicy.GrammarError.invalid }
      if byte == 0x22 { break }
      // No escapes, controls or non-ASCII: every legitimate key and value is plain ASCII.
      if byte == 0x5c || byte < 0x20 || byte > 0x7e { throw ProductPolicy.GrammarError.invalid }
      index += 1
    }
    let text = String(decoding: bytes[start..<index], as: UTF8.self)
    index += 1
    return text
  }

  private mutating func parseValue(depth: Int) throws -> RestrictedJSON {
    guard depth <= ProductPolicy.maxDepth else { throw ProductPolicy.GrammarError.invalid }
    skipWhitespace()
    guard let byte = current else { throw ProductPolicy.GrammarError.invalid }
    switch byte {
    case 0x7b: // {
      index += 1
      var object: [String: RestrictedJSON] = [:]
      skipWhitespace()
      if current == 0x7d { index += 1; return .object(object) }
      while true {
        skipWhitespace()
        let key = try parseString()
        guard object[key] == nil else { throw ProductPolicy.GrammarError.invalid }
        skipWhitespace()
        try expect(0x3a)
        object[key] = try parseValue(depth: depth + 1)
        skipWhitespace()
        if current == 0x2c { index += 1; continue }
        try expect(0x7d)
        return .object(object)
      }
    case 0x5b: // [
      index += 1
      var items: [RestrictedJSON] = []
      skipWhitespace()
      if current == 0x5d { index += 1; return .array(items) }
      while true {
        items.append(try parseValue(depth: depth + 1))
        skipWhitespace()
        if current == 0x2c { index += 1; continue }
        try expect(0x5d)
        return .array(items)
      }
    case 0x22:
      return .string(try parseString())
    case 0x30...0x39:
      let start = index
      if byte == 0x30 { index += 1 } else {
        while let digit = current, digit >= 0x30, digit <= 0x39 { index += 1 }
      }
      // A following '.', 'e' or digit after a leading zero fails at the caller's delimiter check.
      guard index - start <= 16, let value = Int(String(decoding: bytes[start..<index], as: UTF8.self)),
            value <= ProductPolicy.maxSafeInteger else { throw ProductPolicy.GrammarError.invalid }
      return .int(value)
    default:
      for (word, literal) in [("true", RestrictedJSON.bool(true)), ("false", .bool(false)), ("null", .null)] {
        let w = Array(word.utf8)
        if index + w.count <= bytes.count, Array(bytes[index..<(index + w.count)]) == w {
          index += w.count
          return literal
        }
      }
      throw ProductPolicy.GrammarError.invalid
    }
  }
}
