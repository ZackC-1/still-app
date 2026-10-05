import Foundation
import XCTest
@testable import StillKit

/// The purchase catalog is the only place the Apple app names its products, so these tests pin
/// three things: the new product resolves, the historical `still_sync` right still resolves, and
/// the local-only `Still.storekit` test file mirrors the catalog without any path into a release
/// build. Some read checked-in files on purpose, because the drift they guard is between files.
final class ApplePurchaseCatalogTests: XCTestCase {
  private var repositoryRoot: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }

  private var projectDirectory: URL { repositoryRoot.appendingPathComponent("apps/apple/Still") }

  private func text(_ relativePath: String) throws -> String {
    try String(contentsOf: repositoryRoot.appendingPathComponent(relativePath), encoding: .utf8)
  }

  // MARK: - Mapping

  func testNewProProductResolvesToItsOwnEntitlementAndTheFrozenPackage() throws {
    let product = try XCTUnwrap(ApplePurchaseCatalog.product(forProductID: "still_pro_v3"))
    XCTAssertEqual(product, ApplePurchaseCatalog.stillProV3)
    XCTAssertEqual(product.role, .currentOffer)
    XCTAssertTrue(product.isSellable)
    XCTAssertEqual(product.entitlementID, "still_pro_v3")
    XCTAssertEqual(product.offeringID, "still_pro_v3")
    XCTAssertEqual(product.packageID, "$rc_lifetime")
    XCTAssertEqual(product.grantedPackage, "still-pro-v3")
    XCTAssertEqual(ApplePurchaseCatalog.product(forEntitlementID: "still_pro_v3"), product)
  }

  func testHistoricalStillSyncRightIsStillRecognizedButNeverSold() throws {
    let product = try XCTUnwrap(ApplePurchaseCatalog.product(forProductID: "still_sync"))
    XCTAssertEqual(product, ApplePurchaseCatalog.historicalStillSync)
    XCTAssertEqual(product.role, .historical)
    XCTAssertFalse(product.isSellable)
    XCTAssertEqual(product.entitlementID, "still_sync")
    XCTAssertEqual(ApplePurchaseCatalog.product(forEntitlementID: "still_sync"), product)
    // An active still_sync entitlement alone is not proof of new Pro ownership: the grant is
    // decided by the purchase-rights resolver after verification, never by this table.
    XCTAssertNil(product.grantedPackage)
    XCTAssertNil(product.offeringID)
    XCTAssertNil(product.packageID)
  }

  func testNewAndHistoricalProductsNeverShareAnIdentifier() {
    let all = ApplePurchaseCatalog.all
    XCTAssertEqual(all.count, 2)
    XCTAssertEqual(Set(all.map(\.productID)).count, all.count)
    XCTAssertEqual(Set(all.map(\.entitlementID)).count, all.count)
    XCTAssertEqual(all.filter(\.isSellable), [ApplePurchaseCatalog.stillProV3])
  }

  func testLookupIsExactAndUnknownIdentifiersResolveToNothing() {
    for unknown in ["", "STILL_SYNC", " still_sync", "still_sync ", "still_pro", "still-pro-v3",
                    "still_sync_web", "Still_Pro_V3", "$rc_lifetime"] {
      XCTAssertNil(ApplePurchaseCatalog.product(forProductID: unknown), unknown)
      XCTAssertNil(ApplePurchaseCatalog.product(forEntitlementID: unknown), unknown)
    }
  }

  /// The server derives historical rights from this exact entitlement id. Renaming either side
  /// would make every past buyer read as never having paid.
  func testServerHistoricalEntitlementMatchesTheCatalog() throws {
    let source = try text("supabase/functions/_shared/revenuecat.ts")
    XCTAssertTrue(
      source.contains(
        "export const STILL_PRO_ENTITLEMENT = \"\(ApplePurchaseCatalog.historicalStillSync.entitlementID)\";"),
      "the server's historical entitlement id must stay identical to the catalog's still_sync")
  }

  /// One source of truth: no Apple Swift source outside the catalog may spell a product or
  /// entitlement id as a string literal.
  func testNoAppleSwiftSourceOutsideTheCatalogSpellsAProductID() throws {
    let catalogName = "ApplePurchaseCatalog.swift"
    let literals = Set(ApplePurchaseCatalog.all.flatMap { [$0.productID, $0.entitlementID] })
      .map { "\"\($0)\"" }
    var offenders: [String] = []
    for directory in ["apps/apple/Still", "apps/apple/StillKit/Sources"] {
      let base = repositoryRoot.appendingPathComponent(directory)
      let walker = try XCTUnwrap(FileManager.default.enumerator(at: base, includingPropertiesForKeys: nil))
      for case let url as URL in walker where url.pathExtension == "swift" && url.lastPathComponent != catalogName {
        let source = try String(contentsOf: url, encoding: .utf8)
        for literal in literals where source.contains(literal) {
          offenders.append("\(url.lastPathComponent) spells \(literal)")
        }
      }
    }
    XCTAssertEqual(offenders, [], "read product ids from ApplePurchaseCatalog instead")
  }

  // MARK: - Local StoreKit configuration mirrors the catalog

  private func storeKitConfiguration() throws -> [String: Any] {
    let data = try Data(contentsOf: projectDirectory.appendingPathComponent("Still.storekit"))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func testStoreKitConfigurationListsExactlyTheCatalogProducts() throws {
    let configuration = try storeKitConfiguration()
    let products = try XCTUnwrap(configuration["products"] as? [[String: Any]])
    let ids = products.compactMap { $0["productID"] as? String }
    XCTAssertEqual(ids.count, products.count)
    XCTAssertEqual(Set(ids), Set(ApplePurchaseCatalog.all.map(\.productID)))
    XCTAssertEqual(Set(ids).count, ids.count)
    for product in products {
      XCTAssertEqual(product["type"] as? String, "NonConsumable", "\(product["productID"] ?? "?")")
      let price = try XCTUnwrap(Decimal(string: product["displayPrice"] as? String ?? ""))
      XCTAssertGreaterThan(price, 0, "a zero-price product would be a free trial SKU")
    }
  }

  /// One-time purchases only: no subscription, renewal or trial lane may appear in the test file.
  func testStoreKitConfigurationHasNoSubscriptionOrTrialProducts() throws {
    let configuration = try storeKitConfiguration()
    XCTAssertEqual((configuration["subscriptionGroups"] as? [Any])?.count, 0)
    XCTAssertEqual((configuration["nonRenewingSubscriptions"] as? [Any])?.count, 0)
  }

  // MARK: - Release builds cannot pick up the local StoreKit file

  /// The `.storekit` file may appear in the project only as a navigator file reference so the
  /// scheme's Run options can select it. It must never be a member of a target (which would copy
  /// it into a shipped app) and no build setting may name it.
  func testProjectNeverBuildsOrShipsAStoreKitFile() throws {
    let project = try String(
      contentsOf: projectDirectory.appendingPathComponent("Still.xcodeproj/project.pbxproj"),
      encoding: .utf8)
    let fileReference = try NSRegularExpression(
      pattern: #"^\t\t[0-9A-F]{24} /\* [^*/]+\.storekit \*/ = \{isa = PBXFileReference; [^{}]*\};$"#)
    let groupChild = try NSRegularExpression(pattern: #"^\t{4}[0-9A-F]{24} /\* [^*/]+\.storekit \*/,$"#)
    var references = 0
    var offenders: [String] = []
    for line in project.components(separatedBy: "\n") where line.lowercased().contains("storekit") {
      let range = NSRange(line.startIndex..., in: line)
      if fileReference.firstMatch(in: line, range: range) != nil {
        references += 1
      } else if groupChild.firstMatch(in: line, range: range) == nil {
        offenders.append(line.trimmingCharacters(in: .whitespaces))
      }
    }
    XCTAssertEqual(offenders, [], "a StoreKit file must never join a build phase or build setting")
    XCTAssertEqual(references, 1, "Still.storekit should be referenced exactly once, with no target")
  }

  /// Xcode applies a StoreKit configuration only through a scheme's Run or Test options. Any
  /// shared scheme that selects one must do so only for a Debug Run/Test action, never Archive or
  /// Profile, and the archive scheme used by `archive.sh` must not select one at all.
  func testSharedSchemesSelectStoreKitOnlyForDebugRunAndTest() throws {
    let schemeDirectories = [
      "Still.xcodeproj/xcshareddata/xcschemes",
      "Still.xcodeproj/project.xcworkspace/xcshareddata/xcschemes",
    ].map { projectDirectory.appendingPathComponent($0) }
    for directory in schemeDirectories {
      let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
      for name in names where name.hasSuffix(".xcscheme") {
        let data = try Data(contentsOf: directory.appendingPathComponent(name))
        let inspector = SchemeStoreKitInspector()
        let parser = XMLParser(data: data)
        parser.delegate = inspector
        XCTAssertTrue(parser.parse(), "\(name) must be valid XML")
        XCTAssertEqual(inspector.violations, [], name)
        if name == "Still (iOS).xcscheme" || name == "Still (macOS).xcscheme" {
          XCTAssertEqual(inspector.storeKitReferences, 0, "\(name) is the archive scheme")
          XCTAssertEqual(inspector.archiveConfiguration, "Release", "\(name) must archive Release")
        }
      }
    }
  }

  func testArchiveScriptAndExportOptionsNeverNameAStoreKitFile() throws {
    for path in ["apps/apple/scripts/archive.sh", "apps/apple/scripts/ExportOptions.plist"] {
      XCTAssertFalse(try text(path).lowercased().contains("storekit"), path)
    }
  }
}

/// Records where a scheme selects a StoreKit configuration, which action owns it, and the build
/// configuration that action uses.
private final class SchemeStoreKitInspector: NSObject, XMLParserDelegate {
  private var stack: [(name: String, configuration: String?)] = []
  private(set) var violations: [String] = []
  private(set) var storeKitReferences = 0
  private(set) var archiveConfiguration: String?

  func parser(
    _ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
    qualifiedName: String?, attributes: [String: String] = [:]
  ) {
    if elementName == "ArchiveAction" { archiveConfiguration = attributes["buildConfiguration"] }
    if elementName == "StoreKitConfigurationFileReference" {
      storeKitReferences += 1
      let owner = stack.last
      if owner?.name != "LaunchAction" && owner?.name != "TestAction" {
        violations.append("StoreKit configuration inside \(owner?.name ?? "nothing")")
      } else if owner?.configuration != "Debug" {
        violations.append("StoreKit configuration in \(owner!.name) using \(owner?.configuration ?? "no") configuration")
      }
    }
    stack.append((elementName, attributes["buildConfiguration"]))
  }

  func parser(
    _ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?,
    qualifiedName: String?
  ) {
    _ = stack.popLast()
  }
}
