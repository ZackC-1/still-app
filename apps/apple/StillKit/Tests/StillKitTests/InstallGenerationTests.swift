import XCTest
@testable import StillKit

/// The install-generation marker (issue #63): the app stamps each install so the Safari extension
/// can tell "reinstalled" apart from "App Group unreachable". Idempotency across launches is the
/// load-bearing behavior — a regenerating id would read as a reinstall on every app open and purge
/// Pro from the extension each time.
final class InstallGenerationTests: XCTestCase {
  private func freshDefaults(_ name: String) -> UserDefaults {
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return defaults
  }

  func testEnsureIsIdempotentAcrossCalls() {
    let defaults = freshDefaults("still.installGeneration.tests.idempotent")
    let first = InstallGeneration.ensure(defaults)
    let second = InstallGeneration.ensure(defaults)
    XCTAssertEqual(first, second, "an ordinary relaunch must never regenerate the install id")
    XCTAssertFalse(first.isEmpty)
  }

  func testEnsureGeneratesOnceAndPersists() {
    let name = "still.installGeneration.tests.persists"
    let defaults = freshDefaults(name)
    XCTAssertNil(InstallGeneration.current(defaults), "fresh install starts with no id")

    let id = InstallGeneration.ensure(defaults)
    XCTAssertEqual(InstallGeneration.current(defaults), id, "ensure persists the generated id")

    // A separate handle onto the same suite (a "new process") sees the same id.
    let rehydrated = UserDefaults(suiteName: name)!
    XCTAssertEqual(InstallGeneration.current(rehydrated), id)
  }

  func testIdsDifferAcrossInstalls() {
    let a = InstallGeneration.ensure(freshDefaults("still.installGeneration.tests.installA"))
    let b = InstallGeneration.ensure(freshDefaults("still.installGeneration.tests.installB"))
    XCTAssertNotEqual(a, b, "two installs (fresh suites) must get distinct ids")
  }
}
