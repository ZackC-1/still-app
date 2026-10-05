import XCTest
@testable import StillKit

final class SettingsFieldOrderTests: XCTestCase {
  private func field(_ base: Double, _ step: Double, _ value: Bool) -> SettingsOrderedField {
    SettingsOrderedField(value: value, stamp: ["baseRevision": .number(base), "localStep": .number(step)])!
  }

  private func status(_ result: SettingsFieldEditResult) -> String {
    switch result {
    case .unchanged: return "unchanged"
    case .edited: return "edited"
    case .hold: return "hold"
    case .recovery: return "recovery"
    }
  }

  func testSharedVectors() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let raw = try Data(contentsOf: root.appendingPathComponent("packages/shared-types/fixtures/field-order.json"))
    let vectors = try JSONDecoder().decode(SettingsJSONValue.self, from: raw).object!
    func array(_ key: String) -> [SettingsJSONValue] { if case .array(let a) = vectors[key] { return a }; return [] }
    func pair(_ json: SettingsJSONValue?) -> SettingsOrderedField? { json.flatMap(SettingsOrderedField.init(json:)) }
    for json in array("merges") {
      let v = json.object!
      XCTAssertEqual(SettingsFieldOrder.merge(pair(v["left"])!, pair(v["right"])!), pair(v["expected"]))
    }
    for json in array("edits") {
      let v = json.object!
      guard case .number(let revision) = v["revision"], case .bool(let requested) = v["requested"], case .string(let expectedStatus) = v["status"] else { return XCTFail("Invalid edit fixture") }
      let result = SettingsFieldOrder.edit(pair(v["prior"])!, acknowledgedRevision: revision, requestedValue: requested)
      XCTAssertEqual(status(result), expectedStatus)
      XCTAssertEqual(result.field, pair(v["expected"]))
      if expectedStatus == "hold" || expectedStatus == "recovery" { XCTAssertEqual(result.requestedValue, requested) }
    }
    for json in array("pending") {
      let v = json.object!
      XCTAssertEqual(SettingsFieldOrder.pendingAfterAck(pair(v["pending"]), canonical: pair(v["canonical"])!), pair(v["expected"]))
    }
    for json in array("invalid") { XCTAssertNil(SettingsOrderedField(json: json)) }
    XCTAssertEqual(array("merges").count + array("edits").count + array("pending").count + array("invalid").count, 31)
  }

  func testNoopPreservesOpaqueMetadataAndInvalidAnchorsRecover() {
    let prior = SettingsOrderedField(value: false, stamp: ["baseRevision": .number(4), "localStep": .number(SettingsV2Migration.maxLocalStep), "future": .string("kept")])!
    XCTAssertEqual(SettingsFieldOrder.edit(prior, acknowledgedRevision: 5, requestedValue: false).field, prior)
    XCTAssertEqual(status(SettingsFieldOrder.edit(prior, acknowledgedRevision: 5, requestedValue: false)), "unchanged")
    XCTAssertEqual(SettingsOrderedField(json: .object(["value": .bool(false), "stamp": .object(prior.stamp)])), prior)
    XCTAssertEqual(SettingsFieldOrder.edit(prior, acknowledgedRevision: 5, requestedValue: true).field.stamp, ["baseRevision": .number(5), "localStep": .number(1), "future": .string("kept")])
    for revision in [Double.nan, .infinity, -.infinity, -1, 1.5, SettingsV2Migration.maxRevision + 1] {
      XCTAssertEqual(status(SettingsFieldOrder.edit(prior, acknowledgedRevision: revision, requestedValue: true)), "recovery")
    }
    XCTAssertNil(SettingsOrderedField(value: true, stamp: ["baseRevision": .number(.infinity), "localStep": .number(1)]))
  }

  func testIndependentKeysAllOffAndRejectedAlias() throws {
    let baseline = Dictionary(uniqueKeysWithValues: PackagedFeatureRegistry.settingsFields.map { ($0, field(2, 0, false)) })
    let a = try SettingsFieldOrder.mergeFields(baseline, ["globalOn": field(2, 1, true)])
    let b = try SettingsFieldOrder.mergeFields(a, ["services.youtube": field(2, 1, true)])
    XCTAssertEqual(b["globalOn"]?.value, true)
    XCTAssertEqual(b["services.youtube"]?.value, true)
    XCTAssertEqual(b["services.tiktok"]?.value, false)
    XCTAssertEqual(try SettingsFieldOrder.mergeFields(baseline, baseline), baseline)
    let global = SettingsOrderedField(value: true, stamp: ["baseRevision": .number(3), "localStep": .number(1), "future": .object(["retained": .bool(true)])])!
    let youtube = field(4, 2, false)
    let cases: [(left: [String: SettingsOrderedField], right: [String: SettingsOrderedField], expected: [String: SettingsOrderedField])] = [
      ([:], [:], [:]),
      ([:], ["globalOn": global], ["globalOn": global]),
      (["globalOn": global], [:], ["globalOn": global]),
      (["globalOn": global], ["services.youtube": youtube], ["globalOn": global, "services.youtube": youtube]),
    ]
    for test in cases {
      let leftCopy = test.left
      let rightCopy = test.right
      let merged = try SettingsFieldOrder.mergeFields(test.left, test.right)
      XCTAssertEqual(merged, test.expected)
      XCTAssertEqual(merged.keys.sorted(), test.expected.keys.sorted())
      XCTAssertEqual(test.left, leftCopy)
      XCTAssertEqual(test.right, rightCopy)
    }
    XCTAssertThrowsError(try SettingsFieldOrder.mergeFields(baseline, ["sites.tiktok.all": field(2, 1, true)]))
  }
}
