import Foundation
import XCTest
@testable import StillKit

/// The Apple rating path (U13-P3). Synthetic values only; no network, no StoreKit: the sheet is a
/// recording closure, which is exactly the seam the app's presenter fills with Apple's API.
final class RatingPromptTests: XCTestCase {
  private let day = 86_400_000
  private let t0 = 1_790_000_000_000
  private let utc = TimeZone(identifier: "UTC")!
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("still-rating-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: directory)
  }

  private func store() -> InvitationLedgerStore {
    InvitationLedgerStore(backing: AtomicSettingsBacking(directory: directory, name: RatingPrompt.ledgerRecordName),
                          parameters: RatingPrompt.parameters)
  }
  /// What a second process (the Safari extension, or a relaunch) reads from the App Group right now.
  private func onDisk() -> InvitationLedger? {
    AtomicSettingsBacking(directory: directory, name: RatingPrompt.ledgerRecordName).read().flatMap(InvitationLedger.decode)
  }

  private final class Clock: @unchecked Sendable { var ms = 0 }
  private final class Sheet: @unchecked Sendable {
    var calls = 0
    var consumedAtCall: [InvitationTriggerState?] = []
  }

  private func coordinator(_ clock: Clock, timeout: TimeInterval = 5,
                           check: @escaping RatingPromptCoordinator.FreshCheck = { ProductPolicy.Verdict(.on, revision: 5) })
    -> RatingPromptCoordinator {
    RatingPromptCoordinator(store: store(), freshCheck: check, now: { clock.ms }, timeoutSeconds: timeout)
  }

  /// Three app openings on three days, then one eight days after first run: locally due.
  private func eligible(_ clock: Clock, _ c: RatingPromptCoordinator) {
    for i in 0..<3 {
      clock.ms = t0 + i * day
      XCTAssertEqual(c.recordOpening(installation: "install-a", anchorMs: t0, opening: "o\(i + 1)", ordinary: true, timeZone: utc), .ready)
    }
    clock.ms = t0 + 8 * day
    XCTAssertEqual(c.recordOpening(installation: "install-a", anchorMs: t0, opening: "o4", ordinary: true, timeZone: utc), .ready)
  }

  private func prompt(_ c: RatingPromptCoordinator, _ sheet: Sheet, opening: String = "o4",
                      suppressed: InvitationSuppression? = nil, status: SafariExtensionStatus = .unknown,
                      sync: Bool = false) async -> RatingPrompt.Outcome {
    await c.promptIfAllowed(opening: opening, syncApplicable: sync, linkApplicable: false, suppressed: { suppressed },
                            extensionStatus: status) { [self] in
      sheet.calls += 1
      sheet.consumedAtCall.append(onDisk()?.rating)
    }
  }

  func testTheConsumedFlagIsDurableBeforeStoreKitIsCalled() async {
    let clock = Clock(), sheet = Sheet(), c = coordinator(clock)
    eligible(clock, c)
    let outcome = await prompt(c, sheet)
    XCTAssertEqual(outcome, .requested)
    XCTAssertEqual(sheet.calls, 1)
    // Read from the App Group by an independent reader at the instant StoreKit was called.
    XCTAssertEqual(sheet.consumedAtCall, [.consumed])
  }

  func testASuppressedSheetStillConsumesTheOneAttempt() async {
    let clock = Clock(), sheet = Sheet(), c = coordinator(clock)
    eligible(clock, c)
    // Apple decides not to show anything: the closure is called and nothing appears.
    let first = await prompt(c, sheet)
    XCTAssertEqual(first, .requested)
    XCTAssertEqual(onDisk()?.rating, .consumed)
    clock.ms = t0 + 60 * day
    XCTAssertEqual(c.recordOpening(installation: "install-a", anchorMs: t0, opening: "o9", ordinary: true, timeZone: utc), .ready)
    let later = await prompt(c, sheet, opening: "o9")
    XCTAssertEqual(later, .notRequested(.local))
    XCTAssertEqual(sheet.calls, 1)
  }

  func testPolicyOffStaleLateBuildOrSurfaceMismatchNeverCallsStoreKit() async {
    for reason: ProductPolicy.Reason in [.off, .missing, .stale, .late, .build, .environment, .invalid, .context, .deferredSurface] {
      try? FileManager.default.removeItem(at: directory)
      let clock = Clock(), sheet = Sheet()
      let c = coordinator(clock) { ProductPolicy.Verdict(reason, revision: 5) }
      eligible(clock, c)
      let outcome = await prompt(c, sheet)
      XCTAssertEqual(outcome, .notRequested(.policy), "\(reason)")
      XCTAssertEqual(sheet.calls, 0)
      XCTAssertEqual(onDisk()?.rating, .due)
    }
  }

  func testACheckThatDoesNotAnswerInTimeIsOff() async {
    let clock = Clock(), sheet = Sheet()
    let c = coordinator(clock, timeout: 0.05) {
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      return ProductPolicy.Verdict(.on, revision: 5)
    }
    eligible(clock, c)
    let outcome = await prompt(c, sheet)
    XCTAssertEqual(outcome, .notRequested(.policy))
    XCTAssertEqual(sheet.calls, 0)
    XCTAssertEqual(onDisk()?.rating, .due)
  }

  func testNothingIsFetchedUnlessLocallyEligible() async {
    let clock = Clock(), sheet = Sheet()
    let asked = Sheet()
    let c = coordinator(clock) { asked.calls += 1; return ProductPolicy.Verdict(.on, revision: 5) }
    // Three days but not yet a later opening: the earning opening establishes readiness only.
    for i in 0..<3 {
      clock.ms = t0 + 8 * day + i * day
      c.recordOpening(installation: "install-a", anchorMs: t0, opening: "o\(i + 1)", ordinary: true, timeZone: utc)
    }
    let earning = await prompt(c, sheet, opening: "o3")
    XCTAssertEqual(earning, .notRequested(.local))
    // Suppressed during setup, consent, an error, purchase or Restore.
    clock.ms += 1
    c.recordOpening(installation: "install-a", anchorMs: t0, opening: "o4", ordinary: true, timeZone: utc)
    for reason in InvitationSuppression.allCases {
      let suppressed = await prompt(c, sheet, suppressed: reason)
      XCTAssertEqual(suppressed, .notRequested(.held))
    }
    XCTAssertEqual(asked.calls, 0)
    XCTAssertEqual(sheet.calls, 0)
  }

  func testHeldWhileTheSafariExtensionIsKnownToBeOff() async {
    let clock = Clock(), sheet = Sheet()
    let asked = Sheet()
    let c = coordinator(clock) { asked.calls += 1; return ProductPolicy.Verdict(.on, revision: 5) }
    eligible(clock, c)
    let held = await prompt(c, sheet, status: .disabled)
    XCTAssertEqual(held, .notRequested(.held))
    XCTAssertEqual(asked.calls, 0)
    XCTAssertEqual(onDisk()?.rating, .due)
    let unknown = await prompt(c, sheet, status: .unknown)
    XCTAssertEqual(unknown, .requested)
  }

  func testTheAllowanceCountsOnlyForTheOpeningThatCapturedIt() async {
    let clock = Clock(), sheet = Sheet()
    let relaunch = coordinator(clock)
    let c = coordinator(clock) {
      // While the check is in flight, a newer opening is recorded (another window, a relaunch).
      relaunch.recordOpening(installation: "install-a", anchorMs: nil, opening: "o5", ordinary: true)
      return ProductPolicy.Verdict(.on, revision: 5)
    }
    eligible(clock, c)
    let outcome = await prompt(c, sheet)
    XCTAssertEqual(outcome, .notRequested(.reserve))
    XCTAssertEqual(sheet.calls, 0)
    XCTAssertEqual(onDisk()?.rating, .due)
  }

  /// The App Group record, with a hook that can interfere with the transaction after the next one.
  private final class InterferingBacking: SettingsBacking, @unchecked Sendable {
    enum Interference { case fail, bumpGeneration }
    let inner: AtomicSettingsBacking
    var armed: Interference?
    var skip = 0
    init(_ inner: AtomicSettingsBacking) { self.inner = inner }
    func read() -> Data? { inner.read() }
    func write(_ data: Data) { inner.write(data) }
    func transaction<T>(_ body: (inout Data?) throws -> T) throws -> T {
      if let interference = armed {
        if skip > 0 { skip -= 1 } else {
          armed = nil
          switch interference {
          case .fail: throw AtomicSettingsBacking.Failure.lock
          case .bumpGeneration:
            // Another host fenced this ledger since the reservation (its generation moved on).
            try inner.transaction { data in
              guard let bytes = data, var other = InvitationLedger.decode(bytes) else { return }
              other.generation += 1
              data = try other.encoded()
            }
          }
        }
      }
      return try inner.transaction(body)
    }
  }

  func testARejectedOrFailedCommitNeverCallsStoreKit() async throws {
    for interference in [InterferingBacking.Interference.fail, .bumpGeneration] {
      try? FileManager.default.removeItem(at: directory)
      let backing = InterferingBacking(AtomicSettingsBacking(directory: directory, name: RatingPrompt.ledgerRecordName))
      let clock = Clock(), sheet = Sheet()
      // The check arms the interference for the transaction after reserve: the commit.
      let c = RatingPromptCoordinator(
        store: InvitationLedgerStore(backing: backing, parameters: RatingPrompt.parameters),
        freshCheck: { backing.armed = interference; backing.skip = 1; return ProductPolicy.Verdict(.on, revision: 5) },
        now: { clock.ms }, timeoutSeconds: 5)
      eligible(clock, c)
      let outcome = await prompt(c, sheet)
      XCTAssertEqual(outcome, .notRequested(.commit), "\(interference)")
      XCTAssertEqual(sheet.calls, 0)
      XCTAssertNotEqual(onDisk()?.rating, .consumed)
    }
  }

  func testTheSyncSpacingAndPrecedenceRulingsHold() async throws {
    XCTAssertTrue(RatingPrompt.parameters.spaceRatingFromInvitations)
    XCTAssertEqual(RatingPrompt.parameters.countedControls, InvitationOwnerParameters.proposed.countedControls)
    let clock = Clock(), sheet = Sheet(), c = coordinator(clock)
    eligible(clock, c)
    let due = try XCTUnwrap(onDisk())
    var synced = due
    synced.lastInvitationAt = clock.ms - InvitationRules.invitationSpacingMs + 1
    AtomicSettingsBacking(directory: directory, name: RatingPrompt.ledgerRecordName).write(try synced.encoded())
    let spaced = await prompt(c, sheet)
    XCTAssertEqual(spaced, .notRequested(.local))
    var syncDue = due
    syncDue.sync = .due
    AtomicSettingsBacking(directory: directory, name: RatingPrompt.ledgerRecordName).write(try syncDue.encoded())
    let yielded = await prompt(c, sheet, sync: true)
    XCTAssertEqual(yielded, .notRequested(.local))
    XCTAssertEqual(sheet.calls, 0)
  }

  // MARK: Anchor clamp (parity with the browser's newLedgerAnchor)

  func testAPastDatedFirstRunCannotShortenTheWaitAtCreationOrAdoption() async {
    // Created now with a first-run record a year old: anchored now, not a year ago.
    let clock = Clock(), sheet = Sheet(), c = coordinator(clock)
    clock.ms = t0
    c.recordOpening(installation: "install-a", anchorMs: t0 - 365 * day, opening: "o1", ordinary: true, timeZone: utc)
    XCTAssertEqual(onDisk()?.anchorMs, t0)
    for i in 1..<3 {
      clock.ms = t0 + i * day
      c.recordOpening(installation: "install-a", anchorMs: t0 - 365 * day, opening: "o\(i + 1)", ordinary: true, timeZone: utc)
    }
    clock.ms = t0 + 7 * day - 1
    c.recordOpening(installation: "install-a", anchorMs: t0 - 365 * day, opening: "o4", ordinary: true, timeZone: utc)
    let early = await prompt(c, sheet)
    XCTAssertEqual(early, .notRequested(.local))
    clock.ms = t0 + 7 * day
    c.recordOpening(installation: "install-a", anchorMs: t0 - 365 * day, opening: "o5", ordinary: true, timeZone: utc)
    let due = await prompt(c, sheet, opening: "o5")
    XCTAssertEqual(due, .requested)
  }

  func testALateAdoptionIsClampedAndAnExistingAnchorIsKept() {
    let clock = Clock(), c = coordinator(clock)
    clock.ms = t0
    c.recordOpening(installation: "install-a", anchorMs: nil, opening: "o1", ordinary: true, timeZone: utc)
    XCTAssertNil(onDisk()?.anchorMs)
    // The first-run record becomes readable a day later, dated a year back: adopted as "now".
    clock.ms = t0 + day
    c.recordOpening(installation: "install-a", anchorMs: t0 - 365 * day, opening: "o2", ordinary: true, timeZone: utc)
    XCTAssertEqual(onDisk()?.anchorMs, t0 + day)
    // Once anchored, never moved.
    clock.ms = t0 + 2 * day
    c.recordOpening(installation: "install-a", anchorMs: t0 + 10 * day, opening: "o3", ordinary: true, timeZone: utc)
    XCTAssertEqual(onDisk()?.anchorMs, t0 + day)
    XCTAssertEqual(RatingPromptCoordinator.anchor(firstRunMs: t0 + day, nowMs: t0), t0 + day)
    XCTAssertNil(RatingPromptCoordinator.anchor(firstRunMs: nil, nowMs: t0))
  }

  // MARK: Holds: what the app is in the middle of

  private final class Asked: @unchecked Sendable { var calls = 0 }

  /// Prompt with the app's real hold object, the way the presenter does.
  private func prompt(_ c: RatingPromptCoordinator, _ sheet: Sheet, hold: RatingHold, onboarding: Bool = false) async
    -> RatingPrompt.Outcome {
    await c.promptIfAllowed(opening: "o4", syncApplicable: false, linkApplicable: false,
                            suppressed: { hold.suppression(onboardingShowing: onboarding) },
                            extensionStatus: .unknown) { sheet.calls += 1 }
  }

  func testEveryReportedFlowButNoneHoldsTheSheetAndAsksNothing() async {
    let expected: [RatingHold.Flow: InvitationSuppression] = [
      .setup: .setup, .signIn: .link, .consent: .consent, .restore: .restore, .purchase: .purchase,
      .delete: .delete, .error: .error,
    ]
    for flow in RatingHold.Flow.allCases where flow != .none {
      try? FileManager.default.removeItem(at: directory)
      let clock = Clock(), sheet = Sheet(), asked = Asked()
      let c = coordinator(clock) { asked.calls += 1; return ProductPolicy.Verdict(.on, revision: 5) }
      eligible(clock, c)
      let hold = RatingHold()
      XCTAssertTrue(hold.report(flow.rawValue))
      XCTAssertEqual(hold.suppression(onboardingShowing: false), expected[flow], "\(flow)")
      let outcome = await prompt(c, sheet, hold: hold)
      XCTAssertEqual(outcome, .notRequested(.held), "\(flow)")
      XCTAssertEqual(sheet.calls, 0, "\(flow)")
      XCTAssertEqual(asked.calls, 0, "\(flow)")
      XCTAssertEqual(onDisk()?.rating, .due, "\(flow)")
    }
  }

  func testNotYetReportedOnboardingAndUnknownReportsHold() async {
    let clock = Clock(), sheet = Sheet(), c = coordinator(clock)
    eligible(clock, c)
    let hold = RatingHold()
    XCTAssertEqual(hold.suppression(onboardingShowing: false), .setup)
    let unreported = await prompt(c, sheet, hold: hold)
    XCTAssertEqual(unreported, .notRequested(.held))
    hold.report("none")
    let onboarding = await prompt(c, sheet, hold: hold, onboarding: true)
    XCTAssertEqual(onboarding, .notRequested(.held))
    for bad: Any? in [nil, "", "None", "signin", 1, ["none"]] {
      XCTAssertFalse(hold.report(bad))
      XCTAssertEqual(hold.suppression(onboardingShowing: false), .error)
      let held = await prompt(c, sheet, hold: hold)
      XCTAssertEqual(held, .notRequested(.held))
    }
    XCTAssertEqual(sheet.calls, 0)
    hold.report("none")
    let allowed = await prompt(c, sheet, hold: hold)
    XCTAssertEqual(allowed, .requested)
    XCTAssertEqual(sheet.calls, 1)
  }

  func testANativeRestoreOrPurchaseInFlightHoldsEvenWhenTheWebSaysNone() async {
    for flow: RatingHold.Flow in [.restore, .purchase, .signIn] {
      try? FileManager.default.removeItem(at: directory)
      let clock = Clock(), sheet = Sheet(), c = coordinator(clock)
      eligible(clock, c)
      let hold = RatingHold()
      hold.report("none")
      let during: RatingPrompt.Outcome = await hold.during(flow) {
        // An Apple Account sheet returns focus to the app while the native flow is still running.
        await self.prompt(c, sheet, hold: hold)
      }
      XCTAssertEqual(during, .notRequested(.held), "\(flow)")
      XCTAssertEqual(sheet.calls, 0)
      XCTAssertNil(hold.suppression(onboardingShowing: false))
      let after = await prompt(c, sheet, hold: hold)
      XCTAssertEqual(after, .requested, "\(flow)")
    }
  }

  func testAFlowThatStartsDuringTheCheckHoldsAndLeavesTheAttemptUnspent() async {
    for startsBeforeCommit in [false, true] {
      try? FileManager.default.removeItem(at: directory)
      let hold = RatingHold()
      hold.report("none")
      let clock = Clock(), sheet = Sheet()
      final class Reads: @unchecked Sendable { var count = 0 }
      let reads = Reads()
      let c = coordinator(clock) {
        if !startsBeforeCommit { hold.report("signIn") }
        return ProductPolicy.Verdict(.on, revision: 5)
      }
      eligible(clock, c)
      let outcome = await c.promptIfAllowed(
        opening: "o4", syncApplicable: false, linkApplicable: false,
        suppressed: {
          reads.count += 1
          // The third read is the one just before the commit.
          if startsBeforeCommit && reads.count == 3 { hold.report("restore") }
          return hold.suppression(onboardingShowing: false)
        },
        extensionStatus: .unknown) { sheet.calls += 1 }
      XCTAssertEqual(outcome, .notRequested(.held))
      XCTAssertEqual(sheet.calls, 0)
      XCTAssertEqual(onDisk()?.rating, .due)
      XCTAssertNil(onDisk()?.reservation)
    }
  }

  // MARK: The real policy client, end to end

  private final class Transport: ProductPolicyTransport, @unchecked Sendable {
    var requests: [URLRequest] = []
    let answer: () throws -> (status: Int, body: Data)
    init(_ answer: @escaping () throws -> (status: Int, body: Data)) { self.answer = answer }
    func send(_ request: URLRequest, maxBytes: Int) async throws -> (status: Int, body: Data) {
      requests.append(request)
      return try answer()
    }
  }

  private func ratingBody(master: Bool = true, revision: Int = 5, build: String = "3.0.0") -> Data {
    let surfaces = ["chrome_desktop", "edge_desktop", "firefox_desktop", "firefox_android", "apple_mobile_host", "apple_macos_host"]
      .map { "\"\($0)\":true" }.joined(separator: ",")
    return Data(("{\"schema\":1,\"environment\":\"production\",\"revision\":\(revision),\"master\":\(master)," +
      "\"surfaces\":{\(surfaces)},\"builds\":[{\"surface\":\"\(RatingPrompt.appSurface)\",\"build\":\"\(build)\"}]}").utf8)
  }

  private func realRuntime(_ transport: Transport, url: String? = "https://project.example", defaults: UserDefaults) -> ProductPolicyRuntime {
    ProductPolicyRuntime(supabaseURL: url, environment: "production", surface: RatingPrompt.appSurface, build: "3.0.0",
                         store: ProductPolicyRevisionStore(defaults: defaults), transport: transport)
  }

  func testTheRealClientOnlyAFreshCurrentOnRequestsTheSheet() async throws {
    let suite = "RatingPromptTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let cases: [(Transport, Bool)] = [
      (Transport { (200, self.ratingBody(master: false)) }, false),
      (Transport { (200, self.ratingBody(build: "9.9.9")) }, false),
      (Transport { (503, Data()) }, false),
      (Transport { throw URLError(.notConnectedToInternet) }, false),
      (Transport { (200, self.ratingBody(revision: 2)) }, false),   // stale: revision 4 already accepted below
      (Transport { (200, self.ratingBody()) }, true),
    ]
    defaults.set(4, forKey: "still.productPolicy.rating.highestSeenRevision.v1")
    for (transport, expected) in cases {
      try? FileManager.default.removeItem(at: directory)
      let clock = Clock(), sheet = Sheet()
      let runtime = realRuntime(transport, defaults: defaults)
      let c = coordinator(clock) { await runtime.freshCheck(.rating) }
      eligible(clock, c)
      let outcome = await prompt(c, sheet)
      XCTAssertEqual(outcome == .requested, expected)
      XCTAssertEqual(sheet.calls, expected ? 1 : 0)
      XCTAssertEqual(transport.requests.count, 1)
    }
  }

  func testWithNoPackagedProjectURLNoRequestIsMadeAndNothingIsShown() async throws {
    let suite = "RatingPromptTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let transport = Transport { (200, self.ratingBody()) }
    let runtime = realRuntime(transport, url: nil, defaults: defaults)
    let clock = Clock(), sheet = Sheet()
    let c = coordinator(clock) { await runtime.freshCheck(.rating) }
    eligible(clock, c)
    let outcome = await prompt(c, sheet)
    XCTAssertEqual(outcome, .notRequested(.policy))
    XCTAssertEqual(transport.requests.count, 0)
  }

  /// The one request is the policy read: no identifier, no analytics, nothing about the outcome.
  func testNoTelemetryOnAnyRatingPath() async throws {
    let suite = "RatingPromptTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let transport = Transport { (200, self.ratingBody()) }
    let runtime = realRuntime(transport, defaults: defaults)
    let clock = Clock(), sheet = Sheet()
    let c = coordinator(clock) { await runtime.freshCheck(.rating) }
    eligible(clock, c)
    _ = await prompt(c, sheet, status: .disabled)
    _ = await prompt(c, sheet, suppressed: .setup)
    _ = await prompt(c, sheet)
    _ = await prompt(c, sheet)
    XCTAssertEqual(transport.requests.count, 1)
    let request = try XCTUnwrap(transport.requests.first)
    XCTAssertEqual(request.url?.absoluteString, "https://project.example/functions/v1/product-policy")
    XCTAssertEqual(String(data: request.httpBody ?? Data(), encoding: .utf8), #"{"namespace":"rating","environment":"production"}"#)
    XCTAssertEqual(request.allHTTPHeaderFields ?? [:], ["Content-Type": "application/json"])
    // The only thing the rating path writes is the local ledger record (plus its lock).
    let files = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    XCTAssertEqual(files, ["still-invitations.json", "still-invitations.lock"])
  }
}
