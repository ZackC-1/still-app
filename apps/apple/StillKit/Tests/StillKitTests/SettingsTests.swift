import XCTest
@testable import StillKit

final class SettingsTests: XCTestCase {
  func testDefaultsMatchTheWebSide() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    XCTAssertEqual(store.current(), .default)
    XCTAssertTrue(StillSettings.default.globalOn)
    XCTAssertTrue(StillSettings.default.services.youtube)
  }

  func testRoundTrip() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    var settings = StillSettings.default
    settings.services.youtube = false
    settings.updatedAt = 100
    store.save(settings)
    XCTAssertEqual(store.current().services.youtube, false)
    XCTAssertEqual(store.current().updatedAt, 100)
  }

  /// The JSON must match the TypeScript StillSettings exactly, or the WKWebView UI can't read it.
  func testJSONShapeMatchesWebUI() throws {
    let settings = StillSettings(
      globalOn: true,
      services: StillServices(youtube: false, instagram: true, tiktok: true, facebook: true),
      pauses: ["youtube.com"],
      updatedAt: 5,
    )
    let data = try JSONEncoder().encode(settings)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(object["globalOn"] as? Bool, true)
    XCTAssertEqual(object["pauses"] as? [String], ["youtube.com"])
    XCTAssertEqual(object["updatedAt"] as? Int, 5)
    let services = try XCTUnwrap(object["services"] as? [String: Any])
    XCTAssertEqual(services["youtube"] as? Bool, false)
    XCTAssertEqual(services["facebook"] as? Bool, true)
  }

  func testLastWriteWins() {
    let store = SharedSettingsStore(backing: InMemoryBacking())
    store.save(StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 50))

    // An older incoming set is ignored.
    XCTAssertFalse(store.applyRemote(StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 40)))
    XCTAssertTrue(store.current().globalOn)

    // A newer incoming set wins.
    XCTAssertTrue(store.applyRemote(StillSettings(globalOn: false, services: StillServices(), pauses: [], updatedAt: 60)))
    XCTAssertFalse(store.current().globalOn)
  }

  /// A web-written JSON blob decodes into the Swift model (interop direction: web → native).
  func testDecodesWebWrittenJSON() throws {
    let json = """
    { "globalOn": false, "services": { "youtube": true, "instagram": false, "tiktok": true, "facebook": true }, "pauses": ["instagram.com"], "updatedAt": 1782264630248 }
    """
    let settings = try JSONDecoder().decode(StillSettings.self, from: Data(json.utf8))
    XCTAssertFalse(settings.globalOn)
    XCTAssertFalse(settings.services.instagram)
    XCTAssertEqual(settings.pauses, ["instagram.com"])
    XCTAssertEqual(settings.updatedAt, 1782264630248)
  }
}
