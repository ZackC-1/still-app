import XCTest
@testable import StillKit

/// The explicit-choice marker behind onboarding's "Saved", and the one-read-per-launch rule for the
/// app's analytics context.
final class AnalyticsConsentCommitTests: XCTestCase {
  func testTheUnsetDefaultReadsOnButIsNotAnAnswer() {
    let store = AnalyticsIdentityStore(group: MemoryKeyValue())
    XCTAssertTrue(store.consent, "sharing defaults to on")
    XCTAssertFalse(store.consentAnswered, "a default is not a saved choice")
  }

  func testEitherExplicitChoiceIsAnAnswer() {
    for choice in [true, false] {
      let store = AnalyticsIdentityStore(group: MemoryKeyValue())
      store.setConsent(choice)
      XCTAssertEqual(store.consent, choice)
      XCTAssertTrue(store.consentAnswered)
    }
  }

  func testAnUnreadableStoredValueIsNotAnAnswer() {
    let group = MemoryKeyValue()
    group.set("false", forKey: AnalyticsIdentityStore.consentKey)
    let store = AnalyticsIdentityStore(group: group)
    XCTAssertFalse(store.consentAnswered)
    XCTAssertTrue(store.consent)
  }

  func testCommitWritesAndReportsTheStoredAnswer() {
    let store = AnalyticsIdentityStore(group: MemoryKeyValue())
    let off = store.commitConsent(false)
    XCTAssertEqual(off["ok"] as? Bool, true)
    XCTAssertEqual(off["enabled"] as? Bool, false)
    XCTAssertEqual(off["answered"] as? Bool, true)
    XCTAssertEqual(off.count, 3)
    let on = store.commitConsent(true)
    XCTAssertEqual(on["enabled"] as? Bool, true)
    XCTAssertEqual(on["answered"] as? Bool, true)
    XCTAssertTrue(store.consent)
  }

  @MainActor
  func testConcurrentLaunchReadsShareOneComputation() async {
    let once = LaunchValue<Int>()
    var runs = 0
    let gate = AsyncStream<Void>.makeStream()
    async let first = once.get {
      runs += 1
      for await _ in gate.stream { break } // held, like the first-launch iCloud wait
      return 1
    }
    async let second = once.get {
      runs += 1
      return 2
    }
    // Let both callers arrive while the first computation is still waiting.
    for _ in 0..<5 { await Task.yield() }
    gate.continuation.yield(())
    gate.continuation.finish()
    let values = await [first, second]
    XCTAssertEqual(values, [1, 1], "both callers get the first computation's value")
    XCTAssertEqual(runs, 1, "a second caller must not run the computation again")
    let later = await once.get {
      runs += 1
      return 3
    }
    XCTAssertEqual(later, 1)
    XCTAssertEqual(runs, 1)
  }
}
