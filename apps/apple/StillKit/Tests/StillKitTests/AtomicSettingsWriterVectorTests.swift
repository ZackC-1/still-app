import CryptoKit
import XCTest
@testable import StillKit

/// Replays the shared atomic settings writer vectors (packages/shared-types/fixtures/
/// atomic-settings-writer-vectors.json) through StillKit's AtomicSettingsRecord. The fixture is
/// generated from the reviewed TypeScript AtomicSettingsWriter, so every step here must reach the
/// identical complete stored record: compaction, queued holds, scope changes, acknowledgements and
/// legacy pre-conversion commits. The same file drives the compiled-host replay in core vitest.
final class AtomicSettingsWriterVectorTests: XCTestCase {
  private let encoder: JSONEncoder = {
    let value = JSONEncoder()
    value.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return value
  }()

  private func cases() throws -> [[String: SettingsJSONValue]] {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let raw = try Data(contentsOf: root.appendingPathComponent("packages/shared-types/fixtures/atomic-settings-writer-vectors.json"))
    guard case .array(let cases) = try JSONDecoder().decode(SettingsJSONValue.self, from: raw).object?["cases"] else {
      throw CocoaError(.coderInvalidValue)
    }
    return cases.compactMap(\.object)
  }

  /// The same text as the TypeScript canonicalJson: UTF-16 key order, no whitespace, JSON.stringify
  /// string escapes and integer formatting (every vector number is an integer within 2^53).
  static func canonical(_ value: SettingsJSONValue) -> String {
    switch value {
    case .null: return "null"
    case .bool(let flag): return flag ? "true" : "false"
    case .number(let n):
      precondition(n.isFinite && n.rounded(.towardZero) == n && abs(n) <= 9_007_199_254_740_991, "non-integer vector number")
      return String(Int64(n))
    case .string(let text): return quote(text)
    case .array(let items): return "[" + items.map(canonical).joined(separator: ",") + "]"
    case .object(let members):
      let keys = members.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
      return "{" + keys.map { quote($0) + ":" + canonical(members[$0]!) }.joined(separator: ",") + "}"
    }
  }
  private static func quote(_ text: String) -> String {
    var out = "\""
    for scalar in text.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
      }
    }
    return out + "\""
  }
  static func digest(_ value: SettingsJSONValue?) -> String {
    SHA256.hash(data: Data(canonical(value ?? .null).utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /// Confirms this file's canonical text and digest agree with the TypeScript generator, independent
  /// of either writer: each case's final step carries both the record and its digest.
  func testCanonicalDigestMatchesTheReferenceEncoding() throws {
    let all = try cases()
    XCTAssertGreaterThanOrEqual(all.count, 20)
    for vector in all {
      guard case .array(let steps) = vector["steps"], let last = steps.last?.object, case .string(let expected) = last["digest"] else {
        return XCTFail("malformed vector")
      }
      XCTAssertEqual(Self.digest(last["record"]), expected, "\(vector["name"] ?? .null)")
    }
  }

  /// The replay-only identity hook still admits nothing but a fresh canonical lowercase UUID.
  func testInjectedRequestIdentityMustBeAFreshCanonicalUUID() throws {
    let vector = try XCTUnwrap(try cases().first { $0["name"] == .string("compaction/never-linked-journal-stays-bounded") })
    let fresh = try encoder.encode(try XCTUnwrap(vector["initial"]))
    let valid = "abcdef00-0000-4000-8000-000000000001"
    for malformed in ["not-a-uuid", "", valid.uppercased(), valid + "\n", " " + valid, "abcdef00000040008000000000000001", valid + "0"] {
      XCTAssertThrowsError(try AtomicSettingsRecord.commit(fresh, path: "globalOn", value: false, updatedAt: 10, writeId: { malformed }), malformed)
    }
    let saved = try AtomicSettingsRecord.commit(fresh, path: "globalOn", value: false, updatedAt: 10, writeId: { valid })
    XCTAssertTrue(saved.changed)
    let state = try XCTUnwrap(try JSONDecoder().decode(SettingsJSONValue.self, from: XCTUnwrap(saved.data)).object?["atomic"]?.object)
    XCTAssertEqual(state["pending"], .array([.object(["writeId": .string(valid), "scope": state["scope"]!, "receipt": .null,
      "operations": .array([.object(["path": .string("globalOn"), "value": .bool(false), "baseRevision": .number(0), "localStep": .number(1)])])])]))
    // An identity already queued in this record is refused rather than duplicated.
    XCTAssertThrowsError(try AtomicSettingsRecord.commit(saved.data, path: "services.youtube", value: false, updatedAt: 11, writeId: { valid }))
  }

  func testEveryVectorStepReachesTheReferenceRecord() throws {
    var replayed = 0
    for vector in try cases() {
      guard case .string(let name) = vector["name"], case .string(let rule) = vector["rule"],
        case .array(let steps) = vector["steps"], case .array(let ids) = vector["writeIds"] else { return XCTFail("malformed vector") }
      let writeIds = ids.compactMap { value -> String? in if case .string(let id) = value { return id }; return nil }
      var raw: Data? = vector["initial"] == .null ? nil : try encoder.encode(vector["initial"]!)
      var allocated = 0
      for (index, entry) in steps.enumerated() {
        guard let step = entry.object, let command = step["command"]?.object, case .string(let outcome) = step["outcome"],
          case .string(let expected) = step["digest"] else { return XCTFail("\(name) step \(index): malformed step") }
        let label = "\(rule) | \(name) | step \(index)"
        do {
          if command["kind"] == .string("commit") {
            guard case .string(let path) = command["path"], case .bool(let value) = command["value"],
              case .number(let updatedAt) = command["updatedAt"] else { return XCTFail("\(label): malformed commit") }
            let result = try AtomicSettingsRecord.commit(raw, path: path, value: value, updatedAt: Int(updatedAt), writeId: {
              defer { allocated += 1 }
              return allocated < writeIds.count ? writeIds[allocated] : "ffffffff-ffff-4fff-8fff-ffffffffffff"
            })
            XCTAssertEqual(step["changed"], .bool(result.changed), "\(label): intentCommitted")
            raw = result.data
          } else {
            raw = try AtomicSettingsRecord.command(raw, command: encoder.encode(command["command"]!))
          }
          XCTAssertEqual(outcome, "applied", "\(label): StillKit applied a command the reference writer refused")
        } catch {
          XCTAssertEqual(outcome, "refused", "\(label): StillKit refused (\(error)) a command the reference writer applied")
        }
        let actual = try raw.map { try JSONDecoder().decode(SettingsJSONValue.self, from: $0) }
        if Self.digest(actual) != expected {
          let detail = step["record"].map { "expected \(Self.canonical($0))\nactual   \(Self.canonical(actual ?? .null))" } ?? "summary \(step["summary"] ?? .null)\nactual \(Self.canonical(actual ?? .null))"
          XCTFail("\(label): stored record differs from the reference writer\n\(detail)")
          break // Later steps would only repeat this divergence.
        }
        replayed += 1
      }
      XCTAssertEqual(allocated, writeIds.count, "\(rule) | \(name): request identities allocated")
    }
    XCTAssertGreaterThanOrEqual(replayed, 270)
  }
}
