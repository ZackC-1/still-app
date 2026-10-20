import XCTest
@testable import StillKit

/// `presentSafariSetup` (ISS-0075): the Help card's "Safari setup" link may ask native to show its
/// one fixed sheet, only from the bundled main frame, only while the app is active, and with
/// nothing else in the message.
final class SafariSetupSheetTests: XCTestCase {
  private let bundled = URL(fileURLWithPath: "/var/app/Bundle/WebUI/index.html")
  private var trusted: BridgeFrame { BridgeFrame(isMainFrame: true, url: bundled, bundledURL: bundled) }
  private let message: [String: Any] = ["kind": "presentSafariSetup"]

  private func refusal(
    _ body: Any, frame: BridgeFrame? = nil, active: Bool = true
  ) -> SafariSetupSheetRequest.Refusal? {
    SafariSetupSheetRequest.refusal(body: body, frame: frame ?? trusted, appIsActive: active)
  }

  func testTheExactMessageFromTheBundledPageIsShown() {
    XCTAssertNil(refusal(message))
    XCTAssertEqual(SafariSetupSheetRequest.messageKind, "presentSafariSetup")
  }

  func testAnUntrustedFrameCanNeverShowIt() {
    let frames = [
      BridgeFrame(isMainFrame: false, url: bundled, bundledURL: bundled),
      BridgeFrame(isMainFrame: true, url: URL(string: "https://evil.example/index.html"), bundledURL: bundled),
      BridgeFrame(isMainFrame: true, url: nil, bundledURL: bundled),
      BridgeFrame(isMainFrame: true, url: URL(fileURLWithPath: "/var/app/Bundle/WebUI-evil/x.html"), bundledURL: bundled),
    ]
    for frame in frames {
      XCTAssertEqual(refusal(message, frame: frame), .untrustedFrame, "\(frame)")
    }
  }

  func testOnlyTheExactShapeIsAccepted() {
    let refused: [Any] = [
      // Anything beside the kind is refused, never ignored: the page names no screen or place.
      ["kind": "presentSafariSetup", "destination": "safari"],
      ["kind": "presentSafariSetup", "url": "https://evil.example"],
      ["kind": "presentSafariSetup", "step": 0],
      ["kind": "PresentSafariSetup"],
      ["kind": "openDestination"],
      ["kind": 1],
      [String: Any](),
      "presentSafariSetup",
      ["presentSafariSetup"],
    ]
    for body in refused {
      XCTAssertEqual(refusal(body), .malformed, "\(body)")
    }
  }

  func testNothingIsShownWhileTheAppIsNotActive() {
    XCTAssertEqual(refusal(message, active: false), .inactive)
  }

  func testReplyIsOnlyOk() {
    let reply = SafariSetupSheetRequest.reply()
    XCTAssertEqual(reply["ok"] as? Bool, true)
    XCTAssertEqual(reply.count, 1)
  }
}

/// The sheet's life (ISS-0075): Apple's rating sheet stays held while it is up, and closing runs
/// exactly once whichever way the sheet goes.
@MainActor
final class SafariSetupSheetLifecycleTests: XCTestCase {
  func testTheRatingSheetIsHeldUntilTheSetupSheetCloses() {
    let hold = RatingHold()
    hold.report("none")
    XCTAssertNil(hold.suppression(onboardingShowing: false))
    var finished = 0
    let sheet = SafariSetupSheetLifecycle(ratingHold: hold) { finished += 1 }
    XCTAssertEqual(hold.suppression(onboardingShowing: false), .setup)
    var dismissed = 0
    sheet.close { dismissed += 1 }
    XCTAssertTrue(sheet.isClosed)
    XCTAssertEqual(dismissed, 1)
    XCTAssertEqual(finished, 1)
    XCTAssertNil(hold.suppression(onboardingShowing: false))
  }

  func testASecondCloseDismissesNothingAndTellsThePageNothing() {
    let hold = RatingHold()
    hold.report("none")
    var finished = 0
    var dismissed = 0
    let sheet = SafariSetupSheetLifecycle(ratingHold: hold) { finished += 1 }
    // Two quick Check again answers, or Check again then Close.
    sheet.close { dismissed += 1 }
    sheet.close { dismissed += 1 }
    sheet.finish()
    XCTAssertEqual(dismissed, 1)
    XCTAssertEqual(finished, 1)
    // A second sheet's hold is not released by the first one's extra closes.
    let second = SafariSetupSheetLifecycle(ratingHold: hold) {}
    sheet.close { dismissed += 1 }
    XCTAssertEqual(hold.suppression(onboardingShowing: false), .setup)
    second.finish()
    XCTAssertNil(hold.suppression(onboardingShowing: false))
  }

  func testASwipeDownFinishesTheSheetAndALaterCloseDoesNothing() {
    let hold = RatingHold()
    hold.report("none")
    var finished = 0
    let sheet = SafariSetupSheetLifecycle(ratingHold: hold) { finished += 1 }
    sheet.finish() // the system dismissed it
    XCTAssertEqual(finished, 1)
    XCTAssertNil(hold.suppression(onboardingShowing: false))
    sheet.close { XCTFail("Nothing is left to dismiss") }
    XCTAssertEqual(finished, 1)
  }

  func testASheetReleasedWithoutClosingStillReleasesTheHold() {
    let hold = RatingHold()
    hold.report("none")
    var sheet: SafariSetupSheetLifecycle? = SafariSetupSheetLifecycle(ratingHold: hold) {}
    XCTAssertEqual(hold.suppression(onboardingShowing: false), .setup)
    XCTAssertNotNil(sheet)
    sheet = nil
    XCTAssertNil(hold.suppression(onboardingShowing: false))
  }

  func testAHoldTokenCountsOnce() {
    let hold = RatingHold()
    hold.report("none")
    let first = hold.hold(.setup)
    let second = hold.hold(.setup)
    first.end()
    first.end()
    XCTAssertEqual(hold.suppression(onboardingShowing: false), .setup)
    second.end()
    XCTAssertNil(hold.suppression(onboardingShowing: false))
  }

  func testTheClosedEventName() {
    XCTAssertEqual(SafariSetupSheetRequest.closedEvent, "still:safari-setup-closed")
  }
}
