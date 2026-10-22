import Foundation
import XCTest
@testable import StillKit

/// Store builds pin their public access-proof trust in scripts/release/production-access-keys.json.
/// apps/apple/scripts/archive.sh writes those rows into the four shipped Info.plists as
/// `StillAccessEnvironment` = production and `StillAccessTrustKeys` (scripts/release/access-trust.mjs,
/// `plistTrustFields`; its node tests prove the XML it writes parses to exactly these fields).
/// These tests read the committed plists and trust files and prove the native side turns that overlay
/// into non-empty production trust, using the TEST-ONLY fixture (not the real keys).
final class StoreAccessTrustPlistTests: XCTestCase {
  private var repositoryRoot: URL {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { url.deleteLastPathComponent() }
    return url
  }

  private let plists = ["iOS (App)", "iOS (Extension)", "macOS (App)", "macOS (Extension)"]
    .map { "apps/apple/Still/\($0)/Info.plist" }

  private func plist(_ path: String) throws -> [String: Any] {
    let data = try Data(contentsOf: repositoryRoot.appendingPathComponent(path))
    return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any], path)
  }

  private func trustRows(_ path: String) throws -> [[String: String]] {
    let data = try Data(contentsOf: repositoryRoot.appendingPathComponent(path))
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    return try XCTUnwrap(object["keys"] as? [[String: String]], path)
  }

  /// What archive.sh adds to each plist (mirrors access-trust.mjs plistTrustFields).
  private func overlaid(_ info: [String: Any], rows: [[String: String]]) -> [String: Any] {
    var info = info
    info["StillAccessEnvironment"] = "production"
    info["StillAccessTrustKeys"] = rows
    return info
  }

  func testCommittedPlistsCarryNoNativeAccessConfiguration() throws {
    // Both the store overlay and the paid-sandbox QA overlay refuse a plist that already has these.
    for path in plists {
      let info = try plist(path)
      for key in ["StillAccessEnvironment", "StillAccessTrustKeys", "StillBackendRouteProfile",
                  "StillAccessSupabaseURL", "StillAccessSupabasePublishableKey"] {
        XCTAssertNil(info[key], "\(path) must not commit \(key)")
      }
      XCTAssertTrue(NativeAccessConfiguration.trust(info: info).keys.isEmpty, path)
    }
  }

  func testShippedPlistsWithPinnedTrustParseToNonEmptyProductionTrust() throws {
    let rows = try trustRows("scripts/release/fixtures/access-trust/TEST-ONLY-production-access-keys.json")
    XCTAssertEqual(rows.count, 2, "the fixture pins a current and a standby key")
    for path in plists {
      let info = overlaid(try plist(path), rows: rows)
      let trust = NativeAccessConfiguration.trust(info: info)
      XCTAssertEqual(trust.environment, "production", path)
      XCTAssertEqual(trust.keys.map(\.kid), ["test-only-access-current", "test-only-access-standby"], path)
      XCTAssertTrue(trust.keys.allSatisfy { $0.environment == "production" && $0.publicKey.count == 32 }, path)
      XCTAssertEqual(trust.keys.first?.publicKey.map { String(format: "%02x", $0) }.joined(), rows[0]["publicKeyHex"], path)
      // Production trust keeps the production backend route and never opens the QA rating origin.
      XCTAssertEqual(NativeAccessConfiguration.backendRouteProfile(info: info), .production, path)
      XCTAssertNil(NativeAccessConfiguration.ratingPolicySupabaseURL(info: info), path)
    }
  }

  func testEveryRowOfTheRealPinnedFileIsAcceptedAsProductionTrust() throws {
    let rows = try trustRows("scripts/release/production-access-keys.json")
    XCTAssertLessThanOrEqual(rows.count, 2)
    let info = overlaid(try plist(plists[0]), rows: rows)
    XCTAssertEqual(NativeAccessConfiguration.trust(info: info).keys.count, rows.count, "no pinned row may be silently dropped")
  }

  func testAStorePlistWithASandboxRowGetsNoTrust() throws {
    var rows = try trustRows("scripts/release/fixtures/access-trust/TEST-ONLY-production-access-keys.json")
    rows[1]["environment"] = "sandbox"
    XCTAssertTrue(NativeAccessConfiguration.trust(info: overlaid(try plist(plists[0]), rows: rows)).keys.isEmpty)
  }

  func testActualReleaseWriterConfiguresNativeAccountAndSessionConsumersForEveryTarget() throws {
    // Exercise the real Node producer and native consumers together, rather than duplicating its
    // output shape. Only synthetic public client material and the public trust fixture are used.
    for path in plists {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.currentDirectoryURL = repositoryRoot
      process.arguments = ["node", "--input-type=module", "-e", """
        import { readFileSync } from 'node:fs';
        import { applyStoreTrustToPlist, PRODUCTION_SUPABASE_ORIGIN } from './scripts/release/access-trust.mjs';
        const rows = JSON.parse(readFileSync('scripts/release/fixtures/access-trust/TEST-ONLY-production-access-keys.json')).keys;
        process.stdout.write(applyStoreTrustToPlist(readFileSync(process.argv[1], 'utf8'), rows, {
          VITE_SUPABASE_URL: PRODUCTION_SUPABASE_ORIGIN, VITE_SUPABASE_ANON_KEY: 'sb_publishable_synthetic_public'
        }));
        """, path]
      let output = Pipe()
      process.standardOutput = output
      try process.run()
      let bytes = output.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      XCTAssertEqual(process.terminationStatus, 0, path)
      let info = try XCTUnwrap(PropertyListSerialization.propertyList(from: bytes, format: nil) as? [String: Any])
      XCTAssertFalse(NativeAccessConfiguration.trust(info: info).keys.isEmpty, path)
      XCTAssertEqual(NativeAccessConfiguration.backendRouteProfile(info: info), .production, path)
      XCTAssertNotNil(NativeAccessConfiguration.sessionVerifier(info: info), path)
      XCTAssertNotNil(NativeAccountAccessRuntime(info: info), path)
      for field in ["StillAccessSupabaseURL", "StillAccessSupabasePublishableKey"] {
        var incomplete = info
        incomplete.removeValue(forKey: field)
        XCTAssertNil(NativeAccessConfiguration.sessionVerifier(info: incomplete), path)
        XCTAssertNil(NativeAccountAccessRuntime(info: incomplete), path)
      }
    }
  }
}
