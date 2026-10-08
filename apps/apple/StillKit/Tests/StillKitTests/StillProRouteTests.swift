import XCTest
@testable import StillKit

final class StillProRouteTests: XCTestCase {
  func testOnlyFixedProDestinationIsAccepted() {
    XCTAssertTrue(StillProRoute.accepts(URL(string: "still://pro")!))
    XCTAssertTrue(StillProRoute.accepts(URL(string: "still://pro/")!))
    for raw in ["https://pro", "still://other", "still://pro/pay", "still://pro?account=other",
      "still://pro#purchase", "still://user@pro", "still://pro:42", "still://pro/?price=1"] {
      XCTAssertFalse(StillProRoute.accepts(URL(string: raw)!), raw)
    }
  }

  @MainActor func testColdPendingAndWarmRequestsSurviveAStaleAcknowledgment() async {
    XCTAssertTrue(StillProRoute.receive(URL(string: "still://pro")!))
    let cold = StillProRoute.pending()!["revision"] as! Int
    XCTAssertEqual(StillProRoute.pending()!["route"] as? String, "pro")
    XCTAssertTrue(StillProRoute.receive(URL(string: "still://pro")!))
    let warm = StillProRoute.pending()!["revision"] as! Int
    XCTAssertGreaterThan(warm, cold)
    XCTAssertFalse(StillProRoute.acknowledge(cold))
    XCTAssertEqual(StillProRoute.pending()!["revision"] as? Int, warm)
    XCTAssertTrue(StillProRoute.acknowledge(warm))
    XCTAssertNil(StillProRoute.pending())
  }
}
