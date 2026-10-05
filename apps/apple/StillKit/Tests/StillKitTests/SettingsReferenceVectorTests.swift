import XCTest
@testable import StillKit

/// Runs the shared settings field-order reference vectors (packages/shared-types/fixtures/
/// sync-reference-vectors.json) against StillKit's compiled ordering authority. The same file
/// drives the core vitest runner and the Deno sync server runner.
final class SettingsReferenceVectorTests: XCTestCase {
  private struct Fixture {
    let root: [String: SettingsJSONValue]
    let domain: [SettingsOrderedField]
    let algebra: [String: SettingsJSONValue]
    let cases: [[String: SettingsJSONValue]]
  }

  private func load() throws -> Fixture {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let raw = try Data(contentsOf: root.appendingPathComponent("packages/shared-types/fixtures/sync-reference-vectors.json"))
    let object = try XCTUnwrap(try JSONDecoder().decode(SettingsJSONValue.self, from: raw).object)
    let domain = try array(object["domain"]).map { try XCTUnwrap(SettingsOrderedField(json: $0)) }
    let algebra = try XCTUnwrap(object["algebra"]?.object)
    let cases = try array(object["cases"]).map { try XCTUnwrap($0.object) }
    return Fixture(root: object, domain: domain, algebra: algebra, cases: cases)
  }

  private func array(_ value: SettingsJSONValue?) throws -> [SettingsJSONValue] {
    guard case .array(let items) = value else { XCTFail("fixture array"); throw CocoaError(.coderInvalidValue) }
    return items
  }
  private func number(_ value: SettingsJSONValue?) throws -> Double {
    guard case .number(let n) = value else { XCTFail("fixture number"); throw CocoaError(.coderInvalidValue) }
    return n
  }
  private func bool(_ value: SettingsJSONValue?) throws -> Bool {
    guard case .bool(let b) = value else { XCTFail("fixture bool"); throw CocoaError(.coderInvalidValue) }
    return b
  }
  private func string(_ value: SettingsJSONValue?) throws -> String {
    guard case .string(let s) = value else { XCTFail("fixture string"); throw CocoaError(.coderInvalidValue) }
    return s
  }
  private func indices(_ value: SettingsJSONValue) throws -> [Int] {
    try array(value).map { Int(try number($0)) }
  }
  private func pair(_ value: SettingsJSONValue?) throws -> SettingsOrderedField {
    try XCTUnwrap(value.flatMap(SettingsOrderedField.init(json:)))
  }
  private func status(_ result: SettingsFieldEditResult) -> String {
    switch result {
    case .unchanged: return "unchanged"
    case .edited: return "edited"
    case .hold: return "hold"
    case .recovery: return "recovery"
    }
  }
  private func runs(_ c: [String: SettingsJSONValue], _ runner: String) -> Bool {
    guard case .array(let runners) = c["runners"] else { return false }
    return runners.contains(.string(runner))
  }

  func testSharedReferenceVectors() throws {
    let fixture = try load()
    let d = fixture.domain
    let merge = SettingsFieldOrder.merge
    var executed = 0

    // Fixture accounting: one vector per reference-model assertion.
    let sections = ["commutativity", "replayIdempotence", "associativity", "selfIdempotence", "observedEdit", "acknowledgementAdvance"]
    var total = fixture.cases.count
    let counts = try XCTUnwrap(fixture.root["counts"]?.object)
    for name in sections {
      let size = try array(fixture.algebra[name]).count
      XCTAssertEqual(Double(size), try number(counts[name]), name)
      total += size
    }
    XCTAssertEqual(Double(fixture.cases.count), try number(counts["cases"]))
    XCTAssertEqual(total, 6558)
    XCTAssertEqual(try number(fixture.root["referenceAssertions"]), 6558)
    XCTAssertTrue(try array(fixture.algebra["runners"]).contains(.string("swift")))

    for row in try array(fixture.algebra["commutativity"]) {
      let v = try indices(row)
      XCTAssertEqual(merge(d[v[0]], d[v[1]]), d[v[2]])
      XCTAssertEqual(merge(d[v[1]], d[v[0]]), d[v[2]])
      executed += 1
    }
    for row in try array(fixture.algebra["replayIdempotence"]) {
      let v = try indices(row)
      let once = merge(d[v[0]], d[v[1]])
      XCTAssertEqual(once, d[v[2]])
      XCTAssertEqual(merge(once, d[v[1]]), d[v[2]])
      executed += 1
    }
    for row in try array(fixture.algebra["associativity"]) {
      let v = try indices(row)
      XCTAssertEqual(merge(merge(d[v[0]], d[v[1]]), d[v[2]]), d[v[3]])
      XCTAssertEqual(merge(d[v[0]], merge(d[v[1]], d[v[2]])), d[v[3]])
      executed += 1
    }
    for row in try array(fixture.algebra["selfIdempotence"]) {
      let v = try indices(row)
      XCTAssertEqual(merge(d[v[0]], d[v[0]]), d[v[1]])
      executed += 1
    }
    for row in try array(fixture.algebra["observedEdit"]) + array(fixture.algebra["acknowledgementAdvance"]) {
      let v = try XCTUnwrap(row.object)
      let prior = d[Int(try number(v["prior"]))]
      let edit = SettingsFieldOrder.edit(prior, acknowledgedRevision: try number(v["acknowledgedRevision"]), requestedValue: try bool(v["requested"]))
      XCTAssertEqual(status(edit), "edited")
      XCTAssertEqual(edit.field, try pair(v["edited"]))
      if v["merged"] != nil {
        XCTAssertEqual(merge(prior, edit.field), try pair(v["merged"]))
      } else {
        XCTAssertEqual(merge(prior, edit.field).value, try bool(v["mergedValue"]))
      }
      executed += 1
    }
    XCTAssertEqual(executed, 6534)

    var kinds = Set<String>()
    for c in fixture.cases where runs(c, "swift") {
      let id = try string(c["id"])
      let kind = try string(c["kind"])
      kinds.insert(kind)
      switch kind {
      case "merge":
        let expected = try pair(c["expected"])
        XCTAssertEqual(merge(try pair(c["left"]), try pair(c["right"])), expected, id)
        XCTAssertEqual(merge(try pair(c["right"]), try pair(c["left"])), expected, id)
      case "fields":
        func fields(_ json: SettingsJSONValue?) throws -> [String: SettingsOrderedField] {
          try XCTUnwrap(json?.object).mapValues { try pair($0) }
        }
        var merged = try fields(c["initial"])
        for change in try array(c["changes"]) { merged = try SettingsFieldOrder.mergeFields(merged, try fields(change)) }
        XCTAssertEqual(merged, try fields(c["expected"]), id)
      case "pending":
        let expected: SettingsOrderedField? = c["expected"] == .null ? nil : try pair(c["expected"])
        XCTAssertEqual(SettingsFieldOrder.pendingAfterAck(try pair(c["pending"]), canonical: try pair(c["canonical"])), expected, id)
      case "invalid":
        XCTAssertEqual(try string(c["expected"]), "rejected")
        XCTAssertNil(SettingsOrderedField(json: try XCTUnwrap(c["field"])), id)
      case "edit":
        let expected = try XCTUnwrap(c["expected"]?.object)
        let requested = try bool(c["requested"])
        let result = SettingsFieldOrder.edit(try pair(c["prior"]), acknowledgedRevision: try number(c["acknowledgedRevision"]), requestedValue: requested)
        XCTAssertEqual(status(result), try string(expected["status"]), id)
        XCTAssertEqual(result.field, try pair(expected["field"]), id)
        if expected["requestedValue"] != nil { XCTAssertEqual(result.requestedValue, try bool(expected["requestedValue"]), id) }
      default:
        XCTFail("Unhandled Swift vector kind \(kind) for \(id)")
      }
      executed += 1
    }
    XCTAssertEqual(kinds, ["edit", "fields", "invalid", "merge", "pending"])
    // Anchor MAC, receipt admission and receive-time replay require the server-only key and store.
    for c in fixture.cases where !runs(c, "swift") {
      XCTAssertTrue(["admission", "anchor", "replay"].contains(try string(c["kind"])))
    }
    XCTAssertEqual(executed, 6548)
  }
}
