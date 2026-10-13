import XCTest
@testable import StillKit

final class StillAppRouteTests: XCTestCase {
  func testOnlyTheFixedDestinationsAreAccepted() {
    XCTAssertEqual(StillAppRoute.destination(for: URL(string: "still://pro")!), .pro)
    XCTAssertEqual(StillAppRoute.destination(for: URL(string: "still://pro/")!), .pro)
    XCTAssertEqual(StillAppRoute.destination(for: URL(string: "still://sync")!), .sync)
    XCTAssertEqual(StillAppRoute.destination(for: URL(string: "still://sync/")!), .sync)
    for raw in ["https://pro", "https://sync", "still://other", "still://open", "still://sign-in",
      "still://pro/pay", "still://pro?account=other", "still://pro#purchase", "still://user@pro",
      "still://pro:42", "still://pro/?price=1", "still://sync/sign-in", "still://sync?email=x",
      "still://sync#code", "still://user@sync", "still://sync:1", "still://PRO", "still:pro",
      "STILL-other://sync", "still://"] {
      XCTAssertFalse(StillAppRoute.accepts(URL(string: raw)!), raw)
    }
  }

  func testDestinationURLsMatchTheSharedCoreConstants() throws {
    XCTAssertEqual(StillAppRoute.Destination.pro.url.absoluteString, "still://pro")
    XCTAssertEqual(StillAppRoute.Destination.sync.url.absoluteString, "still://sync")
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let bridge = try String(
      contentsOf: root.appendingPathComponent("packages/core/src/native/bridge.ts"), encoding: .utf8)
    XCTAssertTrue(bridge.contains(#"export const STILL_PRO_APP_URL = "still://pro";"#))
    XCTAssertTrue(bridge.contains(#"export const STILL_SYNC_APP_URL = "still://sync";"#))
  }

  @MainActor func testColdPendingAndWarmRequestsSurviveAStaleAcknowledgment() async {
    XCTAssertTrue(StillAppRoute.receive(URL(string: "still://pro")!))
    let cold = StillAppRoute.pending()!["revision"] as! Int
    XCTAssertEqual(StillAppRoute.pending()!["route"] as? String, "pro")
    XCTAssertTrue(StillAppRoute.receive(URL(string: "still://pro")!))
    let warm = StillAppRoute.pending()!["revision"] as! Int
    XCTAssertGreaterThan(warm, cold)
    XCTAssertFalse(StillAppRoute.acknowledge(cold))
    XCTAssertEqual(StillAppRoute.pending()!["revision"] as? Int, warm)
    XCTAssertTrue(StillAppRoute.acknowledge(warm))
    XCTAssertNil(StillAppRoute.pending())
  }

  @MainActor func testTheLatestDestinationWinsAndRefusedURLsLeaveThePendingRouteAlone() async {
    XCTAssertTrue(StillAppRoute.receive(URL(string: "still://pro")!))
    XCTAssertTrue(StillAppRoute.receive(URL(string: "still://sync")!))
    let pending = StillAppRoute.pending()!
    XCTAssertEqual(pending["route"] as? String, "sync")
    XCTAssertFalse(StillAppRoute.receive(URL(string: "still://sync?email=x")!))
    XCTAssertFalse(StillAppRoute.receive(URL(string: "still://open")!))
    XCTAssertEqual(StillAppRoute.pending()!["route"] as? String, "sync")
    XCTAssertEqual(StillAppRoute.pending()!["revision"] as? Int, pending["revision"] as? Int)
    XCTAssertTrue(StillAppRoute.acknowledge(pending["revision"] as! Int))
    XCTAssertNil(StillAppRoute.pending())
  }

  func testExtensionOpenRequestAcceptsOnlyTheClosedShape() {
    XCTAssertEqual(StillAppRoute.extensionOpenRequest(rawBody: ["kind": "openAppRoute", "route": "pro"]), .open(.pro))
    XCTAssertEqual(StillAppRoute.extensionOpenRequest(rawBody: ["kind": "openAppRoute", "route": "sync"]), .open(.sync))
    let refused: [[String: Any]] = [
      ["kind": "openAppRoute"],
      ["kind": "openAppRoute", "route": "still://pro"],
      ["kind": "openAppRoute", "route": "https://example.com"],
      ["kind": "openAppRoute", "route": "other"],
      ["kind": "openAppRoute", "route": "PRO"],
      ["kind": "openAppRoute", "route": 1],
      ["kind": "openAppRoute", "route": "pro", "url": "still://pro"],
      ["kind": "openAppRoute", "route": "sync", "email": "x"],
    ]
    for body in refused {
      XCTAssertEqual(StillAppRoute.extensionOpenRequest(rawBody: body), .refused, "\(body)")
    }
    // Other kinds and non-dictionaries belong to other lanes.
    XCTAssertNil(StillAppRoute.extensionOpenRequest(rawBody: ["kind": "get"]))
    XCTAssertNil(StillAppRoute.extensionOpenRequest(rawBody: ["route": "pro"]))
    XCTAssertNil(StillAppRoute.extensionOpenRequest(rawBody: "still://pro"))
    XCTAssertNil(StillAppRoute.extensionOpenRequest(rawBody: ["openAppRoute"]))
  }

  func testExtensionOpenReplyIsClosed() {
    let opened = StillAppRoute.ExtensionOpenRequest.open(.sync).reply(opened: true)["openAppRoute"] as! [String: Any]
    XCTAssertEqual(opened["ok"] as? Bool, true)
    XCTAssertEqual(opened["route"] as? String, "sync")
    let failed = StillAppRoute.ExtensionOpenRequest.open(.pro).reply(opened: false)["openAppRoute"] as! [String: Any]
    XCTAssertEqual(failed["ok"] as? Bool, false)
    XCTAssertEqual(failed["route"] as? String, "pro")
    let refused = StillAppRoute.ExtensionOpenRequest.refused.reply(opened: true)["openAppRoute"] as! [String: Any]
    XCTAssertEqual(refused["ok"] as? Bool, false)
    XCTAssertTrue(refused["route"] is NSNull)
  }
}
