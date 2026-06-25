import XCTest
@testable import StillKit

/// The native-bridge trust boundary (P0 #1). These prove the decision logic that ViewController's
/// WKNavigationDelegate + script-message handler delegate to — no WebKit needed.
final class BridgeTrustTests: XCTestCase {
  private let bundled = URL(fileURLWithPath: "/var/app/Bundle/WebUI/index.html")

  // MARK: isTrusted (script messages)

  func testTrustsMainFrameAtTheBundledIndex() {
    XCTAssertTrue(BridgeTrust.isTrusted(isMainFrame: true, url: bundled, bundledURL: bundled))
  }

  func testTrustsMainFrameForABundledSubResource() {
    let sub = URL(fileURLWithPath: "/var/app/Bundle/WebUI/assets/app.js")
    XCTAssertTrue(BridgeTrust.isTrusted(isMainFrame: true, url: sub, bundledURL: bundled))
  }

  func testRejectsNonMainFrame() {
    XCTAssertFalse(BridgeTrust.isTrusted(isMainFrame: false, url: bundled, bundledURL: bundled))
  }

  func testRejectsRemoteOrigin() {
    let evil = URL(string: "https://evil.example/index.html")
    XCTAssertFalse(BridgeTrust.isTrusted(isMainFrame: true, url: evil, bundledURL: bundled))
  }

  func testRejectsAFileOutsideTheBundleDirectory() {
    let outside = URL(fileURLWithPath: "/etc/passwd")
    XCTAssertFalse(BridgeTrust.isTrusted(isMainFrame: true, url: outside, bundledURL: bundled))
  }

  func testRejectsPathTraversalEscape() {
    // A standardized path with `..` cannot climb out of the bundle root.
    let escape = URL(fileURLWithPath: "/var/app/Bundle/WebUI/../../secrets.txt")
    XCTAssertFalse(BridgeTrust.isTrusted(isMainFrame: true, url: escape, bundledURL: bundled))
  }

  func testRejectsNilURL() {
    XCTAssertFalse(BridgeTrust.isTrusted(isMainFrame: true, url: nil, bundledURL: bundled))
  }

  func testRejectsSiblingDirectoryPrefixCollision() {
    // "/var/app/Bundle/WebUI-evil/x" must NOT be treated as under "/var/app/Bundle/WebUI".
    let sibling = URL(fileURLWithPath: "/var/app/Bundle/WebUI-evil/x.js")
    XCTAssertFalse(BridgeTrust.isTrusted(isMainFrame: true, url: sibling, bundledURL: bundled))
  }

  // MARK: allowsNavigation

  func testAllowsBundledNavigationAndAboutBlank() {
    XCTAssertTrue(BridgeTrust.allowsNavigation(to: bundled, bundledURL: bundled))
    XCTAssertTrue(BridgeTrust.allowsNavigation(to: URL(string: "about:blank"), bundledURL: bundled))
  }

  func testCancelsRemoteNavigation() {
    XCTAssertFalse(BridgeTrust.allowsNavigation(to: URL(string: "https://evil.example"), bundledURL: bundled))
  }

  // MARK: opensExternally

  func testHttpLinksOpenExternally() {
    XCTAssertTrue(BridgeTrust.opensExternally(URL(string: "https://still.app/privacy")))
    XCTAssertTrue(BridgeTrust.opensExternally(URL(string: "http://example.com")))
  }

  func testNonHttpDoesNotOpenExternally() {
    XCTAssertFalse(BridgeTrust.opensExternally(bundled))
    XCTAssertFalse(BridgeTrust.opensExternally(URL(string: "about:blank")))
    XCTAssertFalse(BridgeTrust.opensExternally(nil))
  }
}
