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

  /// The app target is not built by `swift test`, so this reads its source: the buy flow sells
  /// the new product ONLY. PurchaseManager's sellable ids must read the `stillProV3` entries, while
  /// the restorable sets keep recognizing BOTH products — a one-word sellable/restorable split,
  /// never a rename, so past buyers' receipts and entitlements keep resolving (U16-W2).
  func testPurchaseManagerSellsOnlyTheNewProductAndRestoresBoth() throws {
    let source = try text("apps/apple/Still/Shared (App)/Purchases/PurchaseManager.swift")
    for name in ["productID", "entitlementID"] {
      let pattern = "static let \(name) = ([A-Za-z0-9_.]+)"
      let regex = try NSRegularExpression(pattern: pattern)
      let matches = regex.matches(in: source, range: NSRange(source.startIndex..., in: source))
      XCTAssertEqual(matches.count, 1, "PurchaseManager must declare \(name) exactly once")
      let value = try XCTUnwrap(matches.first.flatMap { Range($0.range(at: 1), in: source) }.map { String(source[$0]) })
      XCTAssertEqual(value, "ApplePurchaseCatalog.stillProV3.\(name)")
    }
    // The restorable sets must name both catalog products: dropping the historical id would
    // silently strand past buyers' receipts and RevenueCat entitlements.
    for id in ["productID", "entitlementID"] {
      for entry in ["stillProV3", "historicalStillSync"] {
        XCTAssertTrue(
          source.contains("ApplePurchaseCatalog.\(entry).\(id)"),
          "PurchaseManager must keep recognizing ApplePurchaseCatalog.\(entry).\(id)")
      }
    }
    // The package selector charges the sellable id: an offering holding only the historical
    // product resolves to no package, which flows to `.unavailable` — never a purchase.
    XCTAssertTrue(
      source.contains("ApplePurchaseCatalog.lifetimeOffering(offeringID: package.offeringIdentifier"),
      "the offering selector must validate the reviewed offering/package/product tuple")
    XCTAssertTrue(source.contains("offerings?.all[offeringID]"),
      "the default/current offering must never substitute an arbitrary product")
  }

  /// The server grants Pro from the new entitlement OR the historical one (U16-W2 ruling: both
  /// ids mean lifetime Pro, ORed into the existing boolean — no migration, no new client field,
  /// no new DB column). Renaming or dropping either side would strand one buyer cohort.
  func testServerDerivesProFromBothTheNewAndTheHistoricalEntitlement() throws {
    let source = try text("supabase/functions/_shared/revenuecat.ts")
    XCTAssertTrue(
      source.contains("export const STILL_PRO_V3_ENTITLEMENT = \"still_pro_v3\";"),
      "the server must derive Pro from the new still_pro_v3 entitlement")
    XCTAssertTrue(
      source.contains("STILL_PRO_V3_ENTITLEMENT,\n  STILL_PRO_ENTITLEMENT,"),
      "the server must OR both entitlement ids into the one Pro boolean")
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

  /// `Still.storekit` may appear in the project only as a navigator file reference so the scheme's
  /// Run options can select it. It must never be a member of a target (which would copy it into a
  /// shipped app) and no build setting may name it. Only lines naming a `.storekit` configuration
  /// file are inspected, so linking StoreKit.framework or StoreKitTest cannot trip this guard.
  func testProjectNeverBuildsOrShipsAStoreKitFile() throws {
    let project = try String(
      contentsOf: projectDirectory.appendingPathComponent("Still.xcodeproj/project.pbxproj"),
      encoding: .utf8)
    let fileReference = try NSRegularExpression(pattern:
      #"^\t\t[0-9A-F]{24} /\* Still\.storekit \*/ = \{isa = PBXFileReference; [^{}]*path = Still\.storekit; [^{}]*\};$"#)
    let groupChild = try NSRegularExpression(pattern: #"^\t{4}[0-9A-F]{24} /\* Still\.storekit \*/,$"#)
    var references = 0
    var offenders: [String] = []
    for line in project.components(separatedBy: "\n") where Self.namesStoreKitConfigurationFile(line) {
      let range = NSRange(line.startIndex..., in: line)
      if fileReference.firstMatch(in: line, range: range) != nil {
        references += 1
      } else if groupChild.firstMatch(in: line, range: range) == nil {
        offenders.append(line.trimmingCharacters(in: .whitespaces))
      }
    }
    XCTAssertEqual(offenders, [], "a StoreKit configuration file must never join a build phase or build setting")
    XCTAssertEqual(references, 1, "Still.storekit should be referenced exactly once, with no target")
  }

  /// True when the text names a `.storekit` configuration file (any case), not the StoreKit or
  /// StoreKitTest frameworks.
  private static func namesStoreKitConfigurationFile(_ text: String) -> Bool {
    text.range(of: #"\.storekit\b"#, options: [.regularExpression, .caseInsensitive]) != nil
  }

  /// Xcode applies a StoreKit configuration only through a scheme's Run or Test options. Any
  /// shared scheme that selects one must do so only for a Debug Run/Test action, never Archive or
  /// Profile, and the archive scheme used by `archive.sh` must not select one at all.
  ///
  /// No shared scheme is committed today (Xcode auto-creates `Still (iOS)`/`Still (macOS)`), so
  /// this passes vacuously now and only guards shared schemes someone commits later.
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
      XCTAssertFalse(Self.namesStoreKitConfigurationFile(try text(path)), path)
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
