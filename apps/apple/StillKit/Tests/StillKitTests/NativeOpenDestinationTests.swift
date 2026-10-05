import XCTest
@testable import StillKit

/// `openDestination`: the web view may ask native to open one of a few fixed system locations, only
/// from the bundled main frame, only while the app is active, and never with a URL from the page.
final class NativeOpenDestinationTests: XCTestCase {
  private let bundled = URL(fileURLWithPath: "/var/app/Bundle/WebUI/index.html")
  private var trusted: BridgeFrame { BridgeFrame(isMainFrame: true, url: bundled, bundledURL: bundled) }

  private func message(_ destination: Any) -> [String: Any] {
    ["kind": "openDestination", "destination": destination]
  }

  private func authorize(
    _ body: Any,
    frame: BridgeFrame? = nil,
    platform: SafariSetupObservation.Platform = .macos,
    active: Bool = true
  ) -> Result<NativeOpenDestination, NativeOpenRequest.Refusal> {
    NativeOpenRequest.authorize(
      body: body, frame: frame ?? trusted, platform: platform, appIsActive: active)
  }

  // MARK: fixed destinations per platform

  func testMacOpensSafarisExtensionSettingsAndSafari() {
    XCTAssertEqual(try authorize(message("safariExtensionSettings")).get(), .safariExtensionSettings)
    XCTAssertEqual(try authorize(message("safari")).get(), .safari)
    XCTAssertEqual(authorize(message("settingsAppStillPage")), .failure(.unsupported))
  }

  func testIOSOpensOnlyStillsPageInTheSettingsApp() {
    XCTAssertEqual(
      try authorize(message("settingsAppStillPage"), platform: .ios).get(), .settingsAppStillPage)
    // No public iOS API opens Safari itself; an https link opens the default browser instead.
    XCTAssertEqual(authorize(message("safari"), platform: .ios), .failure(.unsupported))
    XCTAssertEqual(authorize(message("safariExtensionSettings"), platform: .ios), .failure(.unsupported))
  }

  func testDestinationsMatchTheSetupReadsEnableLocations() {
    // The web view opens the place `safariSetupState` named, by the same spelling.
    for platform in [SafariSetupObservation.Platform.ios, .macos] {
      let location = SafariSetupObservation(
        platform: platform, extensionStatus: .unknown,
        enableLocation: platform == .ios ? .settingsAppStillPage : .safariExtensionSettings
      ).bridgeReply["enableLocation"] as? String
      let destination = try? authorize(message(location ?? ""), platform: platform).get()
      XCTAssertEqual(destination?.rawValue, location)
    }
    XCTAssertEqual(NativeOpenDestination.safariBundleIdentifier, "com.apple.Safari")
  }

  // MARK: trusted frame only

  func testAnUntrustedFrameCanNeverOpen() {
    let frames = [
      BridgeFrame(isMainFrame: false, url: bundled, bundledURL: bundled),
      BridgeFrame(isMainFrame: true, url: URL(string: "https://evil.example/index.html"), bundledURL: bundled),
      BridgeFrame(isMainFrame: true, url: nil, bundledURL: bundled),
      BridgeFrame(isMainFrame: true, url: URL(fileURLWithPath: "/var/app/Bundle/WebUI-evil/x.html"), bundledURL: bundled),
    ]
    for frame in frames {
      for destination in NativeOpenDestination.allCases {
        for platform in [SafariSetupObservation.Platform.ios, .macos] {
          XCTAssertEqual(
            authorize(message(destination.rawValue), frame: frame, platform: platform),
            .failure(.untrustedFrame), "\(frame) \(destination)")
        }
      }
    }
  }

  // MARK: no URL from the page

  func testAPageSuppliedURLIsNeverHonoured() {
    let refused: [Any] = [
      // A URL instead of a destination.
      message("https://evil.example"),
      message("x-apple.systempreferences:com.apple.preference"),
      message("App-prefs:root=SAFARI"),
      message("file:///etc/passwd"),
      // A URL beside a valid destination: refused, never ignored.
      ["kind": "openDestination", "destination": "safari", "url": "https://evil.example"],
      ["kind": "openDestination", "destination": "safariExtensionSettings", "bundleID": "com.evil"],
      ["kind": "openDestination", "url": "https://evil.example"],
    ]
    for body in refused {
      XCTAssertEqual(authorize(body), .failure(.malformed), "\(body)")
      XCTAssertEqual(authorize(body, platform: .ios), .failure(.malformed), "\(body)")
    }
  }

  func testOnlyTheExactShapeIsAccepted() {
    let refused: [Any] = [
      message("Safari"),
      message(" safari"),
      message(""),
      message(1),
      message(NSNull()),
      ["kind": "openDestination"],
      ["kind": "OpenDestination", "destination": "safari"],
      ["destination": "safari"],
      "openDestination",
      ["safari"],
    ]
    for body in refused {
      XCTAssertEqual(authorize(body), .failure(.malformed), "\(body)")
    }
  }

  // MARK: only while a tap is possible

  func testNothingOpensWhileTheAppIsNotActive() {
    XCTAssertEqual(authorize(message("safari"), active: false), .failure(.inactive))
    XCTAssertEqual(
      authorize(message("settingsAppStillPage"), platform: .ios, active: false), .failure(.inactive))
  }

  func testReplyNamesTheDestinationItOpened() {
    let reply = NativeOpenRequest.reply(.safari)
    XCTAssertEqual(reply["ok"] as? Bool, true)
    XCTAssertEqual(reply["destination"] as? String, "safari")
    XCTAssertEqual(reply.count, 2)
    XCTAssertEqual(NativeOpenRequest.messageKind, "openDestination")
  }
}
