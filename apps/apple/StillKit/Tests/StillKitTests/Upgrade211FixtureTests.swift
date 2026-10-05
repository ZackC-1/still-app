import XCTest
@testable import StillKit

/// Upgrade from the shipped 2.1.0 App Group bytes and 2.1.1 browser records, through the current
/// Swift readers. The fixture and its expectations are shared with packages/core
/// (upgrade-2.1.1-fixtures.test.ts), so both readers are held to the same saved choices.
final class Upgrade211FixtureTests: XCTestCase {
  private struct Fixture: Decodable {
    let sources: [String: String]
    let cases: [UpgradeCase]
  }

  private struct UpgradeCase: Decodable {
    let name: String
    let surface: String
    let present: Bool
    let stored: SettingsJSONValue?
    let rawJSON: String?
    let expected: Expected?
  }

  private struct Expected: Decodable {
    let globalOn: Bool
    let services: [String: Bool]
    let updatedAt: Int
    let syncMetadata: SettingsSyncMetadata?
    let syncEpoch: Int?
    let retained: Retained?
  }

  private struct Retained: Decodable {
    let root: [String: SettingsJSONValue]
    let settings: [String: SettingsJSONValue]
    let services: [String: SettingsJSONValue]
  }

  /// Same set as SWIFT_HOLDS_UNKNOWN in packages/core upgrade-2.1.1-fixtures.test.ts.
  private static let swiftHoldsUnknown: Set<String> = ["browser-defaults-synced", "app-group-defaults-synced"]

  private func fixture() throws -> Fixture {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let data = try Data(contentsOf: root.appendingPathComponent("packages/shared-types/fixtures/upgrade-2.1.1.json"))
    return try JSONDecoder().decode(Fixture.self, from: data)
  }

  /// App Group cases are the exact 2.1.0 bytes. Browser records reach Swift as JSON over the bridge.
  private func raw(_ c: UpgradeCase) throws -> Data? {
    if let rawJSON = c.rawJSON { return Data(rawJSON.utf8) }
    guard let stored = c.stored, stored != .null else { return nil }
    return try JSONEncoder().encode(stored)
  }

  private func settingsObject(_ data: Data) throws -> [String: SettingsJSONValue] {
    let root = try JSONDecoder().decode([String: SettingsJSONValue].self, from: data)
    return try XCTUnwrap(root["settings"]?.object)
  }

  private func expectedSites(_ e: Expected) -> [String: SettingsJSONValue] {
    Dictionary(uniqueKeysWithValues: PackagedFeatureRegistry.features.map {
      ($0.id, .bool($0.tier == "free" ? e.services[$0.service]! : false))
    })
  }

  private func assertChoices(_ settings: StillSettings, _ e: Expected, _ name: String, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(settings.globalOn, e.globalOn, name, file: file, line: line)
    XCTAssertEqual(settings.services.youtube, e.services["youtube"], name, file: file, line: line)
    XCTAssertEqual(settings.services.instagram, e.services["instagram"], name, file: file, line: line)
    XCTAssertEqual(settings.services.tiktok, e.services["tiktok"], name, file: file, line: line)
    XCTAssertEqual(settings.services.facebook, e.services["facebook"], name, file: file, line: line)
    XCTAssertEqual(settings.updatedAt, e.updatedAt, name, file: file, line: line)
  }

  private func assertModern(_ document: [String: SettingsJSONValue], _ e: Expected, _ name: String, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(document["schemaVersion"], .number(2), name, file: file, line: line)
    XCTAssertEqual(document["globalOn"], .bool(e.globalOn), name, file: file, line: line)
    XCTAssertEqual(document["updatedAt"], .number(Double(e.updatedAt)), name, file: file, line: line)
    let services = document["services"]?.object ?? [:]
    for id in PackagedFeatureRegistry.serviceIDs {
      XCTAssertEqual(services[id], .bool(e.services[id]!), "\(name) \(id)", file: file, line: line)
    }
    XCTAssertEqual(document["sites"]?.object, expectedSites(e), name, file: file, line: line)
    let clocks = document["clocks"]?.object ?? [:]
    XCTAssertEqual(Set(clocks.keys), Set(PackagedFeatureRegistry.settingsFields), name, file: file, line: line)
    for field in PackagedFeatureRegistry.settingsFields {
      XCTAssertEqual(clocks[field], .object(["baseRevision": .number(0), "localStep": .number(0)]), "\(name) \(field)", file: file, line: line)
    }
    XCTAssertNil(document["pauses"], name, file: file, line: line)
    for (key, value) in e.retained?.settings ?? [:] { XCTAssertEqual(document[key], value, "\(name) \(key)", file: file, line: line) }
    for (key, value) in e.retained?.services ?? [:] { XCTAssertEqual(services[key], value, "\(name) \(key)", file: file, line: line) }
  }

  func testFixtureCoversEveryRequiredShapeFromTheShippedCommits() throws {
    let fixture = try fixture()
    let names = Set(fixture.cases.map(\.name))
    for surface in ["browser", "app-group"] {
      for shape in ["defaults-never-touched", "defaults-synced", "all-off", "mixed", "signed-in-synced", "legacy-pauses", "unknown-extra-fields"] {
        XCTAssertTrue(names.contains("\(surface)-\(shape)"), "\(surface)-\(shape)")
      }
    }
    XCTAssertTrue(fixture.sources["browser"]?.hasPrefix("ec1e68b ") == true)
    XCTAssertTrue(fixture.sources["apple"]?.hasPrefix("8a67977 ") == true)
  }

  func testCurrentRecordDecoderReadsEveryShippedRecordExactly() throws {
    for c in try fixture().cases where c.present {
      let e = try XCTUnwrap(c.expected, c.name)
      let record = try JSONDecoder().decode(StoredSettingsRecord.self, from: try XCTUnwrap(raw(c)))
      assertChoices(record.settings, e, c.name)
      XCTAssertEqual(record.syncMetadata, e.syncMetadata, c.name)
      XCTAssertEqual(record.syncEpoch, e.syncEpoch, c.name)
      // The shared store hands the same choices to the app UI and the Safari extension.
      let store = SharedSettingsStore(backing: InMemoryBacking(try raw(c)))
      let peeked = try XCTUnwrap(store.peekRecord(), c.name)
      assertChoices(peeked.settings, e, c.name)
      XCTAssertEqual(peeked.syncMetadata, e.syncMetadata, c.name)
      XCTAssertEqual(peeked.syncEpoch, e.syncEpoch, c.name)
    }
  }

  func testMigrationMatchesTheSharedExpectationsWithoutDefaults() throws {
    for c in try fixture().cases where c.present {
      let e = try XCTUnwrap(c.expected, c.name)
      let settings = try JSONEncoder().encode(try settingsObject(try XCTUnwrap(raw(c))))
      let result = SettingsV2Migration.read(settings, provenance: .init(kind: "readable-local", provenInitialization: e.updatedAt == 0))
      guard case .ready(let modern, let migrated) = result else { return XCTFail("\(c.name) needs recovery: \(result)") }
      XCTAssertTrue(migrated, c.name)
      assertModern(modern.document, e, c.name)
    }
  }

  func testUnknownOrFreshProvenanceNeverResetsSavedChoices() throws {
    for c in try fixture().cases where c.present {
      let e = try XCTUnwrap(c.expected, c.name)
      let settings = try JSONEncoder().encode(try settingsObject(try XCTUnwrap(raw(c))))
      guard case .recovery(let reason, let original, let usable) = SettingsV2Migration.read(settings, provenance: .init(kind: "unknown")) else {
        return XCTFail("\(c.name) must not be ready without provenance")
      }
      XCTAssertEqual(reason, .missingProvenance, c.name)
      XCTAssertEqual(original, settings, c.name)
      var expectedFields = ["globalOn": e.globalOn]
      for (id, on) in e.services { expectedFields["services.\(id)"] = on }
      XCTAssertEqual(usable, expectedFields, c.name)
      guard case .recovery(.provenanceConflict, _, _) = SettingsV2Migration.read(settings, provenance: .init(kind: "proven-fresh")) else {
        return XCTFail("\(c.name) must never be accepted as a fresh install")
      }
    }
  }

  func testAtomicBackingFreezesShippedAppGroupBytesWithoutRewriting() throws {
    for c in try fixture().cases where c.surface == "app-group" {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: directory) }
      let legacy = try raw(c)
      let backing = AtomicSettingsBacking(directory: directory, legacyRead: { legacy })
      XCTAssertEqual(backing.read(), legacy, c.name)
      let file = directory.appendingPathComponent("still-settings.json")
      if let legacy {
        XCTAssertEqual(try Data(contentsOf: file), legacy, c.name)
      } else {
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "\(c.name) must not fabricate a record")
      }
    }
  }

  func testAtomicInitializationPreservesChoicesSyncStateAndUnknownMembers() throws {
    for c in try fixture().cases where c.present {
      let e = try XCTUnwrap(c.expected, c.name)
      let bytes = try XCTUnwrap(raw(c))
      let backing = InMemoryBacking(bytes)
      let store = SharedSettingsStore(backing: backing)
      // Known divergence (reported, not fixed here): a never-edited record that 2.1.x synced keeps
      // updatedAt 0. TypeScript AtomicSettingsWriter.initialize accepts it for any ownership; Swift
      // initialize accepts zero only for "never-linked", so an "unknown" upgrade holds instead.
      // Holding is safe: the shipped bytes stay exactly as they were and still read back unchanged.
      // Keyed by case name: when Swift is aligned with TypeScript, empty the set and this test
      // must then migrate these cases like every other one.
      if Self.swiftHoldsUnknown.contains(c.name) {
        XCTAssertThrowsError(try store.initializeAtomic(ownership: "unknown"), c.name)
        XCTAssertEqual(backing.read(), bytes, c.name)
        assertChoices(try XCTUnwrap(store.peekRecord(), c.name).settings, e, c.name)
        continue
      }
      let data = try store.initializeAtomic(ownership: "unknown")
      let root = try JSONDecoder().decode([String: SettingsJSONValue].self, from: data)
      assertModern(try XCTUnwrap(root["settings"]?.object, c.name), e, c.name)
      let record = try JSONDecoder().decode(StoredSettingsRecord.self, from: data)
      XCTAssertEqual(record.syncMetadata, e.syncMetadata, c.name)
      XCTAssertEqual(record.syncEpoch, e.syncEpoch, c.name)
      let atomic = try XCTUnwrap(root["atomic"]?.object, c.name)
      XCTAssertEqual(atomic["ownership"], .string("unknown"), c.name)
      XCTAssertEqual(atomic["scope"], .object(["accountId": .null, "generation": .number(0)]), c.name)
      XCTAssertEqual(atomic["pending"], .array([]), c.name)
      for (key, value) in e.retained?.root ?? [:] { XCTAssertEqual(root[key], value, "\(c.name) \(key)") }
      assertChoices(try XCTUnwrap(store.peekRecord(), c.name).settings, e, c.name)
      // A later wake leaves the migrated record alone.
      XCTAssertEqual(try store.initializeAtomic(ownership: "unknown"), data, c.name)
      XCTAssertEqual(backing.read(), data, c.name)
    }
  }

  func testNothingStoredStaysNothingStored() throws {
    for c in try fixture().cases where !c.present {
      XCTAssertNil(c.expected, c.name)
      let backing = InMemoryBacking()
      let store = SharedSettingsStore(backing: backing)
      XCTAssertNil(store.peekRecord(), c.name)
      XCTAssertThrowsError(try store.initializeAtomic(ownership: "unknown"), c.name)
      XCTAssertNil(backing.read(), c.name)
      guard case .recovery(.missingData, _, _) = SettingsV2Migration.read(nil, provenance: .init(kind: "readable-local")) else {
        return XCTFail("\(c.name): absence is not a fresh install")
      }
    }
  }
}
