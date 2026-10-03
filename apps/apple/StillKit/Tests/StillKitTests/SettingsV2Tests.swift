import XCTest
@testable import StillKit

final class SettingsV2Tests: XCTestCase {
  func testSharedMigrationVectorsAndLegacyReaderCompatibility() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let data = try Data(contentsOf: root.appendingPathComponent("packages/shared-types/fixtures/settings-v2.json"))
    let vectors = try JSONDecoder().decode([MigrationVector].self, from: data)
    for vector in vectors {
      let provenance = SettingsV2Provenance(kind: vector.provenance, revision: vector.revision, provenInitialization: vector.provenInitialization ?? false)
      let raw = try vector.rawJSON.map { Data($0.utf8) } ?? vector.input.map { try JSONEncoder().encode($0) }
      let result = SettingsV2Migration.read(raw, provenance: provenance)
      if let expected = vector.expected {
        guard case .ready(let settings, _) = result else { return XCTFail("Expected ready: \(vector.name)") }
        XCTAssertEqual(settings.document, expected.object, vector.name)
        let encoded = try settings.serialized()
        guard case .ready(let reread, let migrated) = SettingsV2Migration.read(encoded, provenance: SettingsV2Provenance(kind: "readable-local", provenInitialization: settings.document["updatedAt"] == .number(0))) else { return XCTFail("Roundtrip: \(vector.name)") }
        XCTAssertFalse(migrated)
        XCTAssertEqual(reread, settings)
        let old = try JSONDecoder().decode(StillSettings.self, from: encoded)
        XCTAssertEqual(old.globalOn, settings.document["globalOn"] == .bool(true))
        XCTAssertEqual(old.services.tiktok, settings.document["services"]?.object?["tiktok"] == .bool(true))
        XCTAssertTrue(old.pauses.isEmpty)
      } else {
        guard case .recovery(let reason, let retained, _) = result else { return XCTFail("Expected recovery: \(vector.name)") }
        XCTAssertEqual(reason.rawValue, vector.reason, vector.name)
        XCTAssertEqual(retained, raw)
      }
    }
  }

  func testRegistryHasNoSecondTikTokClockAndFrozenDefaults() {
    XCTAssertEqual(PackagedFeatureRegistry.featureIDs.count, 15)
    XCTAssertEqual(Set(PackagedFeatureRegistry.featureIDs).count, 15)
    XCTAssertEqual(PackagedFeatureRegistry.features.filter { $0.tier == "pro" }.count, 12)
    XCTAssertTrue(PackagedFeatureRegistry.features.allSatisfy { $0.freshDefault == ($0.tier == "free") })
    XCTAssertEqual(PackagedFeatureRegistry.settingsFields.count, 20)
    XCTAssertEqual(PackagedFeatureRegistry.tiktokField, "services.tiktok")
    XCTAssertFalse(PackagedFeatureRegistry.settingsFields.contains("sites.tiktok.all"))
  }

  func testDamagedFieldsRemainUsableWithoutDefaulting() throws {
    let data = Data(#"{"globalOn":false,"services":{"youtube":false,"instagram":"bad","facebook":false},"updatedAt":5}"#.utf8)
    guard case .recovery(_, let retained, let fields) = SettingsV2Migration.read(data, provenance: .init(kind: "readable-local")) else { return XCTFail("Must recover") }
    XCTAssertEqual(retained, data)
    XCTAssertEqual(fields["globalOn"], false)
    XCTAssertEqual(fields["services.youtube"], false)
    XCTAssertNil(fields["services.instagram"])
  }

  func testCanonicalEquivalentUnknownKeysRecoverOriginalRawBytes() {
    for opaque in [#"{"é":false,"e\u0301":true}"#, #"[{"é":false,"e\u0301":true}]"#] {
      let raw = Data("{\"globalOn\":false,\"services\":{\"youtube\":false},\"updatedAt\":50,\"opaque\":\(opaque)}".utf8)
      guard case .recovery(let reason, let retained, let fields) = SettingsV2Migration.read(raw, provenance: .init(kind: "readable-local")) else { return XCTFail("Distinct raw keys must never return a lossy ready document") }
      XCTAssertEqual(reason, .malformed)
      XCTAssertEqual(retained, raw)
      XCTAssertEqual(fields["globalOn"], false)
      XCTAssertEqual(fields["services.youtube"], false)
    }
  }

  func testLiteralInvalidUTF8AndOversizedRawBytesRemainRecoveryEvidence() {
    for (raw, reason) in [(Data([0xff]), SettingsV2RecoveryReason.malformed), (Data(repeating: 32, count: 65_537), .bounds)] {
      guard case .recovery(let actual, let retained, _) = SettingsV2Migration.read(raw, provenance: .init(kind: "readable-local")) else { return XCTFail("Raw byte bounds must recover") }
      XCTAssertEqual(actual, reason)
      XCTAssertEqual(retained, raw)
    }
  }

  private struct MigrationVector: Decodable {
    let name: String
    let rawJSON: String?
    let input: SettingsJSONValue?
    let provenance: String
    let revision: Double?
    let provenInitialization: Bool?
    let expected: SettingsJSONValue?
    let reason: String?
  }
}
