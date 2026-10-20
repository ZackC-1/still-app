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
