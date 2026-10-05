import Foundation
import XCTest
@testable import StillKit

/// Runs packages/core/src/invitations/__tests__/invitation-ledger-vectors.json, the same file the
/// TS suite runs, so the two ledgers must agree on every step and every full final ledger.
final class InvitationLedgerTests: XCTestCase {
  private static let T0 = 1_790_000_000_000, DAY = 86_400_000
  private static var D0: Int { T0 / DAY }

  private func vectors() throws -> [String: Any] {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let url = root.appendingPathComponent("packages/core/src/invitations/__tests__/invitation-ledger-vectors.json")
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
  }

  private func context(_ s: [String: Any]) -> InvitationContext {
    InvitationContext(opening: s["opening"] as? String ?? "", nowMs: (s["nowMs"] as? NSNumber)?.intValue ?? -1,
                      syncApplicable: s["syncApplicable"] as? Bool ?? true, linkApplicable: s["linkApplicable"] as? Bool ?? true,
                      suppressed: (s["suppressed"] as? String).flatMap(InvitationSuppression.init(rawValue:)))
  }
  private func int(_ v: Any?) -> Int? { (v as? NSNumber)?.intValue }

  /// Mirrors vector-runner.ts. Returns the final ledger and every mismatch.
  private func run(_ scenario: [String: Any]) throws -> (InvitationLedger?, [String]) {
    let name = scenario["name"] as? String ?? "?"
    var parameters = InvitationOwnerParameters.proposed
    if let p = scenario["parameters"] as? [String: Any] {
      parameters = InvitationOwnerParameters(
        spaceRatingFromInvitations: try XCTUnwrap(p["spaceRatingFromInvitations"] as? Bool),
        countedControls: try XCTUnwrap(p["countedControls"] as? [String]).map { try XCTUnwrap(InvitationControl(rawValue: $0)) })
    }
    var ledger: InvitationLedger?
    var failures: [String] = []
    for (index, step) in try XCTUnwrap(scenario["steps"] as? [[String: Any]]).enumerated() {
      let op = step["op"] as? String ?? ""
      func fail(_ actual: String) { failures.append("\(name) step \(index) \(op): expected \(step["expect"] ?? step["ledger"] ?? "") got \(actual)") }
      if op == "create" {
        ledger = InvitationLedger.create(installation: try XCTUnwrap(step["installation"] as? String), anchorMs: int(step["anchorMs"]))
        continue
      }
      guard let l = ledger else { failures.append("\(name) step \(index): no ledger"); continue }
      let expect = step["expect"] as? [String: Any] ?? [:]
      switch op {
      case "open":
        ledger = l.recordingOpening(InvitationOpening(opening: try XCTUnwrap(step["opening"] as? String), ordinary: try XCTUnwrap(step["ordinary"] as? Bool),
                                                      nowMs: try XCTUnwrap(int(step["nowMs"])), localDay: int(step["localDay"])))
      case "control":
        ledger = l.recordingDirectControl(InvitationDirectControl(
          control: try XCTUnwrap(InvitationControl(rawValue: step["control"] as? String ?? "")),
          source: try XCTUnwrap(InvitationControlSource(rawValue: step["source"] as? String ?? "")),
          outcome: try XCTUnwrap(InvitationDirectControl.Outcome(rawValue: step["outcome"] as? String ?? "")),
          signedIn: try XCTUnwrap(step["signedIn"] as? Bool), ready: try XCTUnwrap(step["ready"] as? Bool)), parameters: parameters)
      case "purchase":
        ledger = l.recordingPurchase(InvitationPurchaseEvent(
          source: try XCTUnwrap(InvitationPurchaseSource(rawValue: step["source"] as? String ?? "")),
          verified: try XCTUnwrap(step["verified"] as? Bool), unlinked: try XCTUnwrap(step["unlinked"] as? Bool)))
      case "adoptAnchor":
        ledger = l.adoptingAnchor(try XCTUnwrap(int(step["anchorMs"])))
      case "arbitrate":
        let a = l.arbitrate(context(step), parameters: parameters)
        let kind = expect["kind"] is NSNull ? nil : (expect["kind"] as? String)
        if a.kind?.rawValue != kind || a.reason.rawValue != expect["reason"] as? String { fail("\(String(describing: a.kind)) \(a.reason)") }
      case "reserve":
        let kind = try XCTUnwrap(InvitationKind(rawValue: step["kind"] as? String ?? ""))
        switch l.reserving(kind, context(step), parameters: parameters) {
        case let .reserved(next, r):
          if expect["ok"] as? Bool != true || int(expect["generation"]) != r.generation { fail("reserved \(r.generation)") }
          ledger = next
        case let .refused(reason):
          if expect["ok"] as? Bool != false || expect["reason"] as? String != reason.rawValue { fail("refused \(reason)") }
        }
      case "commit", "release":
        let r = InvitationReservation(kind: try XCTUnwrap(InvitationKind(rawValue: step["kind"] as? String ?? "")),
                                      opening: try XCTUnwrap(step["opening"] as? String), generation: try XCTUnwrap(int(step["generation"])))
        let next = op == "commit" ? l.committing(r, nowMs: try XCTUnwrap(int(step["nowMs"]))) : l.releasing(r)
        if (next != nil) != (expect["ok"] as? Bool) { fail("ok \(next != nil)") }
        if let next { ledger = next }
      case "check":
        let actual = l.jsonObject
        for (key, value) in try XCTUnwrap(step["ledger"] as? [String: Any]) where !((actual[key] as AnyObject).isEqual(value)) {
          fail("\(key)=\(actual[key] ?? "missing")")
        }
      default:
        failures.append("\(name) step \(index): unknown op \(op)")
      }
    }
    return (ledger, failures)
  }

  func testSharedScenarioVectorsMatchTSStepByStepAndFinalLedger() throws {
    let scenarios = try XCTUnwrap(try vectors()["scenarios"] as? [[String: Any]])
    XCTAssertGreaterThanOrEqual(scenarios.count, 20)
    for scenario in scenarios {
      let name = scenario["name"] as? String ?? "?"
      let (ledger, failures) = try run(scenario)
      XCTAssertEqual(failures, [], name)
      let final = try XCTUnwrap(scenario["final"] as? [String: Any], "\(name) pins its final ledger")
      let actual = try XCTUnwrap(ledger, name)
      XCTAssertEqual(actual.jsonObject as NSDictionary, final as NSDictionary, name)
      // The TS-produced final ledger parses in Swift and re-encodes to the same object.
      XCTAssertEqual(InvitationLedger.parse(final), actual, name)
      XCTAssertEqual(InvitationLedger.decode(try actual.encoded()), actual, name)
    }
  }

  func testSharedDayOrdinalAndCivilVectors() throws {
    let v = try vectors()
    for d in try XCTUnwrap(v["dayOrdinals"] as? [[String: Any]]) {
      let zone = try XCTUnwrap(TimeZone(identifier: try XCTUnwrap(d["timeZone"] as? String)))
      let expected = d["ordinal"] is NSNull ? nil : int(d["ordinal"])
      XCTAssertEqual(InvitationDayOrdinal.local(epochMs: try XCTUnwrap(int(d["epochMs"])), timeZone: zone), expected, d["name"] as? String ?? "")
    }
    for c in try XCTUnwrap(v["civilDates"] as? [[String: Any]]) {
      XCTAssertEqual(InvitationDayOrdinal.civil(year: try XCTUnwrap(int(c["year"])), month: try XCTUnwrap(int(c["month"])),
                                                day: try XCTUnwrap(int(c["day"]))), int(c["ordinal"]))
    }
  }

  func testSharedStrictParseVectors() throws {
    for p in try XCTUnwrap(try vectors()["parse"] as? [[String: Any]]) {
      XCTAssertEqual(InvitationLedger.parse(p["value"]) != nil, p["valid"] as? Bool, p["name"] as? String ?? "")
    }
  }

  // MARK: Store over the App Group atomic backing

  private func temporaryDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("still-invitations-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    return dir
  }
  private func ctx(_ opening: String, _ now: Int) -> InvitationContext {
    InvitationContext(opening: opening, nowMs: now, syncApplicable: true, linkApplicable: true, suppressed: nil)
  }
  private func dueLink(_ dir: URL) -> InvitationLedgerStore {
    let store = InvitationLedgerStore(backing: AtomicSettingsBacking(directory: dir, name: "still-invitations"))
    XCTAssertEqual(store.ensure(installation: "install-a", anchorMs: Self.T0), .ready)
    store.recordOpening(InvitationOpening(opening: "o1", ordinary: true, nowMs: Self.T0, localDay: Self.D0))
    store.recordPurchase(InvitationPurchaseEvent(source: .newApplePurchase, verified: true, unlinked: true))
    return store
  }

  func testParallelHostsAcrossSeparateLocksConsumeOnce() throws {
    for round in 0..<25 {
      let dir = try temporaryDirectory()
      _ = dueLink(dir)
      let committed = NSLock()
      var successes = 0
      DispatchQueue.concurrentPerform(iterations: 4) { host in
        // Each host is its own store and lock handle, like the app and the Safari extension.
        let store = InvitationLedgerStore(backing: AtomicSettingsBacking(directory: dir, name: "still-invitations"))
        let opening = "r\(round)-h\(host)"
        store.recordOpening(InvitationOpening(opening: opening, ordinary: true, nowMs: Self.T0 + 1, localDay: Self.D0))
        if let r = store.reserve(.link, ctx(opening, Self.T0 + 1)), store.commit(r, nowMs: Self.T0 + 2) {
          committed.lock(); successes += 1; committed.unlock()
        }
      }
      XCTAssertEqual(successes, 1, "round \(round)")
      let stored = try XCTUnwrap(InvitationLedger.decode(Data(contentsOf: dir.appendingPathComponent("still-invitations.json"))))
      XCTAssertEqual(stored.shown, 1)
      XCTAssertEqual(stored.link, .consumed)
    }
  }

  func testCrashBeforeVisibilityReleasesAndCrashAfterConsumes() throws {
    let dir = try temporaryDirectory()
    let store = dueLink(dir)
    store.recordOpening(InvitationOpening(opening: "o2", ordinary: true, nowMs: Self.T0 + 1, localDay: Self.D0))
    let crashed = try XCTUnwrap(store.reserve(.link, ctx("o2", Self.T0 + 1)))
    // The process dies before commit; a fresh host opens later.
    let relaunched = InvitationLedgerStore(backing: AtomicSettingsBacking(directory: dir, name: "still-invitations"))
    relaunched.recordOpening(InvitationOpening(opening: "o3", ordinary: true, nowMs: Self.T0 + 2, localDay: Self.D0))
    XCTAssertFalse(store.commit(crashed, nowMs: Self.T0 + 2), "the stale host is fenced")
    let r = try XCTUnwrap(relaunched.reserve(.link, ctx("o3", Self.T0 + 2)))
    XCTAssertTrue(relaunched.commit(r, nowMs: Self.T0 + 2))
    // Committed before visibility, then crashed: the attempt is consumed on the next opening.
    relaunched.recordOpening(InvitationOpening(opening: "o4", ordinary: true, nowMs: Self.T0 + 30 * Self.DAY, localDay: Self.D0 + 30))
    XCTAssertEqual(relaunched.arbitrate(ctx("o4", Self.T0 + 30 * Self.DAY)), InvitationArbitration(kind: nil, reason: .none))
  }

  func testUnreadableRecordIsNeverOverwrittenOrReset() throws {
    let dir = try temporaryDirectory()
    let corrupt = Data(#"{"schema":1,"milestones":99}"#.utf8)
    try corrupt.write(to: dir.appendingPathComponent("still-invitations.json"))
    let store = InvitationLedgerStore(backing: AtomicSettingsBacking(directory: dir, name: "still-invitations"))
    XCTAssertEqual(store.ensure(installation: "install-a", anchorMs: Self.T0), .unreadable)
    XCTAssertEqual(store.recordOpening(InvitationOpening(opening: "o1", ordinary: true, nowMs: Self.T0, localDay: Self.D0)), .unreadable)
    XCTAssertNil(store.reserve(.rating, ctx("o1", Self.T0)))
    XCTAssertEqual(try Data(contentsOf: dir.appendingPathComponent("still-invitations.json")), corrupt)
  }

  func testAbsentRecordIsOnlyCreatedByEnsureAndEnsureNeverReplaces() throws {
    let dir = try temporaryDirectory()
    let store = InvitationLedgerStore(backing: AtomicSettingsBacking(directory: dir, name: "still-invitations"))
    XCTAssertEqual(store.recordOpening(InvitationOpening(opening: "o1", ordinary: true, nowMs: Self.T0, localDay: Self.D0)), .absent)
    XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("still-invitations.json").path))
    XCTAssertEqual(store.ensure(installation: "install-a", anchorMs: Self.T0), .ready)
    XCTAssertEqual(store.ensure(installation: "install-b", anchorMs: Self.T0 + Self.DAY), .ready)
    let stored = try XCTUnwrap(InvitationLedger.decode(Data(contentsOf: dir.appendingPathComponent("still-invitations.json"))))
    XCTAssertEqual(stored.installation, "install-a")
    XCTAssertEqual(stored.anchorMs, Self.T0)
  }

  func testBoundariesDirectly() throws {
    XCTAssertEqual(InvitationRules.ratingMinimumAgeMs, 604_800_000)
    XCTAssertEqual(InvitationRules.invitationSpacingMs, 168 * 60 * 60 * 1000)
    var l = try XCTUnwrap(InvitationLedger.create(installation: "install-a", anchorMs: Self.T0))
    for i in 0..<3 { l = l.recordingOpening(InvitationOpening(opening: "o\(i)", ordinary: true, nowMs: Self.T0 + i * Self.DAY, localDay: Self.D0 + i)) }
    XCTAssertEqual(l.rating, .earned, "the third day only establishes readiness")
    l = l.recordingOpening(InvitationOpening(opening: "o3", ordinary: true, nowMs: Self.T0 + 3 * Self.DAY, localDay: Self.D0 + 3))
    XCTAssertNil(l.arbitrate(ctx("o3", Self.T0 + 604_799_999)).kind)
    XCTAssertEqual(l.arbitrate(ctx("o3", Self.T0 + 604_800_000)).kind, .rating)
    for _ in 0..<9 { l = l.recordingDirectControl(InvitationDirectControl(control: .site, source: .direct, outcome: .succeeded, signedIn: false, ready: true)) }
    XCTAssertEqual(l.milestones, 3)
  }
}
