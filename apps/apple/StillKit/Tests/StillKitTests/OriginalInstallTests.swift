import Foundation
import XCTest
@testable import StillKit

final class OriginalInstallTests: XCTestCase {
  private func freshDefaults(_ name: String) -> UserDefaults {
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return defaults
  }

  private let firstLaunch = Date(timeIntervalSince1970: 1_700_000_000)
  private let laterLaunch = Date(timeIntervalSince1970: 1_800_000_000)

  func testTheLocalHalfIsWrittenOnceAndNeverMovesForward() {
    let defaults = freshDefaults("still.originalInstall.tests.once")

    let first = OriginalInstall.ensure(
      firstRecordedAt: firstLaunch,
      appVersion: "2.0.0",
      defaults: defaults
    )
    XCTAssertEqual(first.firstRecordedAt, firstLaunch)
    XCTAssertEqual(first.firstRecordedAppVersion, "2.0.0")

    // A later launch, and a later app version: the cohort must not move.
    let second = OriginalInstall.ensure(
      firstRecordedAt: laterLaunch,
      appVersion: "3.0.0",
      defaults: defaults
    )
    XCTAssertEqual(second, first)
    XCTAssertEqual(OriginalInstall.current(defaults), first)
  }

  func testTheVerifiedHalfIsTaggedWithTheNamespaceItIsIn() {
    // The defect this pins: Apple reports originalAppVersion as a build number on iOS and a
    // marketing version on macOS, so the same release writes "6" on one platform and "1.0.1" on
    // the other. Comparing them against one shared threshold would grant or deny an entire
    // platform's installs by accident, and these records cannot be recreated afterwards.
    let defaults = freshDefaults("still.originalInstall.tests.kind")
    OriginalInstall.ensure(firstRecordedAt: firstLaunch, appVersion: "2.0.0", defaults: defaults)

    let filled = OriginalInstall.fillVerifiedValues(
      applicationVersion: "6",
      kind: .buildNumber,
      originalPurchaseDate: firstLaunch,
      defaults: defaults
    )

    XCTAssertEqual(filled?.applicationVersion, "6")
    XCTAssertEqual(filled?.applicationVersionKind, .buildNumber)
    XCTAssertEqual(OriginalInstall.current(defaults)?.applicationVersionKind, .buildNumber)
    // The local half is untouched by the fill.
    XCTAssertEqual(OriginalInstall.current(defaults)?.firstRecordedAt, firstLaunch)
    XCTAssertEqual(OriginalInstall.current(defaults)?.firstRecordedAppVersion, "2.0.0")
  }

  func testTheVerifiedHalfIsWrittenOnlyOnce() {
    let defaults = freshDefaults("still.originalInstall.tests.fillOnce")
    OriginalInstall.ensure(firstRecordedAt: firstLaunch, appVersion: "2.0.0", defaults: defaults)
    OriginalInstall.fillVerifiedValues(
      applicationVersion: "6",
      kind: .buildNumber,
      originalPurchaseDate: firstLaunch,
      defaults: defaults
    )

    OriginalInstall.fillVerifiedValues(
      applicationVersion: "99",
      kind: .marketingVersion,
      originalPurchaseDate: laterLaunch,
      defaults: defaults
    )

    XCTAssertEqual(OriginalInstall.current(defaults)?.applicationVersion, "6")
    XCTAssertEqual(OriginalInstall.current(defaults)?.originalPurchaseDate, firstLaunch)
  }

  func testTheVerifiedHalfIsNeverWrittenWithoutALocalHalf() {
    let defaults = freshDefaults("still.originalInstall.tests.noLocalHalf")

    let result = OriginalInstall.fillVerifiedValues(
      applicationVersion: "6",
      kind: .buildNumber,
      originalPurchaseDate: firstLaunch,
      defaults: defaults
    )

    XCTAssertNil(result)
    XCTAssertNil(OriginalInstall.current(defaults))
  }

  /// Nothing asks Apple about purchases while Still sells nothing.
  ///
  /// The ask can raise an App Store sign-in sheet on a device where nobody is signed in. That is
  /// wrong on an app with no purchase to honor, and it is the kind of thing a store reviewer sees
  /// first, so the whole ask is switched off beside the rest of the paid tier rather than managed.
  ///
  /// Written as an equality against the switch rather than a flat `false`, because the whole suite
  /// is run in both switch positions before anything about the paid tier ships.
  func testNothingAsksAppleAboutPurchasesWhileThereIsNothingToBuy() {
    let defaults = freshDefaults("still.originalInstall.tests.dormant")
    OriginalInstall.ensure(firstRecordedAt: firstLaunch, appVersion: "2.0.0", defaults: defaults)

    // A fresh install with no verified half yet and every attempt unspent: the only thing that can
    // be deciding this is the paid-tier switch.
    XCTAssertEqual(
      OriginalInstall.shouldRequestVerifiedValues(defaults),
      MonetizationConfig.paidTierEnabled,
      "a device asks Apple for its purchase history exactly when there is a purchase to honor"
    )

    // The half that the cohort is actually read from is written either way. It comes from the app's
    // own bundle, so it costs no network call and cannot be affected by any of this.
    XCTAssertEqual(OriginalInstall.current(defaults)?.firstRecordedAt, firstLaunch)
    XCTAssertEqual(OriginalInstall.current(defaults)?.firstRecordedAppVersion, "2.0.0")
  }

  func testAskingAppleForTheVerifiedHalfStopsAfterAFewAttempts() {
    // Each ask can raise an App Store sign-in prompt on a device with no cached transaction, so a
    // device has to stop asking rather than prompt at every launch forever. Modelled the way the
    // app does it: every launch asks whether to ask, and counts an attempt only when told yes.
    //
    // While the paid tier is dormant the answer is always no, so a whole free era of launches
    // spends none of the budget and a device still has all three attempts when paid access returns.
    let defaults = freshDefaults("still.originalInstall.tests.attempts")
    OriginalInstall.ensure(firstRecordedAt: firstLaunch, appVersion: "2.0.0", defaults: defaults)

    var asks = 0
    for _ in 0..<(OriginalInstall.maxVerifiedAttempts + 5)
    where OriginalInstall.shouldRequestVerifiedValues(defaults) {
      OriginalInstall.countVerifiedAttempt(defaults)
      asks += 1
    }

    let expected = MonetizationConfig.paidTierEnabled ? OriginalInstall.maxVerifiedAttempts : 0
    XCTAssertEqual(asks, expected)
    XCTAssertEqual(defaults.integer(forKey: OriginalInstall.verifiedAttemptsKey), expected)
    XCTAssertFalse(OriginalInstall.shouldRequestVerifiedValues(defaults))
    // The install is still identifiable as a free-era one: only the optional half was lost.
    XCTAssertEqual(OriginalInstall.current(defaults)?.firstRecordedAt, firstLaunch)
  }

  func testAskingStopsAsSoonAsTheVerifiedHalfArrives() {
    let defaults = freshDefaults("still.originalInstall.tests.attemptsSatisfied")
    OriginalInstall.ensure(firstRecordedAt: firstLaunch, appVersion: "2.0.0", defaults: defaults)
    OriginalInstall.countVerifiedAttempt(defaults)
    OriginalInstall.fillVerifiedValues(
      applicationVersion: "1.0.1",
      kind: .marketingVersion,
      originalPurchaseDate: firstLaunch,
      defaults: defaults
    )

    XCTAssertFalse(OriginalInstall.shouldRequestVerifiedValues(defaults))
  }

  func testThePlatformNamespaceMatchesApplesDocumentedBehavior() {
    // These tests build for macOS, where Apple reports the marketing version. The iOS side of the
    // same rule is pinned by the source check in MonetizationConfigTests, which proves the app
    // asks for this value rather than hardcoding one platform's answer.
    #if os(macOS)
      XCTAssertEqual(OriginalInstall.applicationVersionKindForThisPlatform, .marketingVersion)
    #else
      XCTAssertEqual(OriginalInstall.applicationVersionKindForThisPlatform, .buildNumber)
    #endif
  }

  func testMalformedStoredValueReadsAsAbsent() {
    let defaults = freshDefaults("still.originalInstall.tests.malformed")
    defaults.set(Data("not-json".utf8), forKey: OriginalInstall.storageKey)

    XCTAssertNil(OriginalInstall.current(defaults))
  }

  // MARK: - Records already on devices have to stay readable

  // A record that cannot be decoded is read as no record, and the next launch writes a fresh one
  // dated today. So a change to OriginalInstallRecord that makes an existing record unreadable
  // does not fail loudly: it quietly re-dates everybody who already has one, permanently, and the
  // original is gone. These tests decode raw bytes rather than a freshly encoded value, so they
  // keep testing the stored shape even after the type changes.

  /// The exact bytes this build writes, written out by hand. Dates are seconds since Apple's
  /// reference date, which is what JSONEncoder produces by default.
  private var recordInTodaysShape: String {
    """
    {"schemaVersion":1,"firstRecordedAt":721692800,"firstRecordedAppVersion":"2.0.0",\
    "applicationVersion":"1.0.1","applicationVersionKind":"marketingVersion",\
    "originalPurchaseDate":721692800}
    """
  }

  func testARecordInTheShapeThisBuildWritesStaysReadable() {
    // If this fails after you added a field to OriginalInstallRecord, the field is required and
    // must not be. Make it optional, or give it a default in init(from:). Do not add it to the
    // JSON above: the point of that literal is that it is what is already on people's devices.
    let defaults = freshDefaults("still.originalInstall.tests.todaysShape")
    defaults.set(Data(recordInTodaysShape.utf8), forKey: OriginalInstall.storageKey)

    let record = OriginalInstall.current(defaults)

    XCTAssertNotNil(record, "a record written by this build must still decode")
    XCTAssertEqual(record?.schemaVersion, 1)
    XCTAssertEqual(record?.firstRecordedAt, firstLaunch)
    XCTAssertEqual(record?.firstRecordedAppVersion, "2.0.0")
    XCTAssertEqual(record?.applicationVersion, "1.0.1")
    XCTAssertEqual(record?.applicationVersionKind, .marketingVersion)
    XCTAssertEqual(record?.originalPurchaseDate, firstLaunch)
  }

  func testARecordCarryingFieldsFromALaterBuildStillReads() {
    // The other direction of the same rule. A device that ran a newer build and then an older one,
    // which is ordinary on TestFlight and across an App Group two targets share, must not lose its
    // record just because the newer build added something.
    let defaults = freshDefaults("still.originalInstall.tests.laterShape")
    let laterShape = """
      {"schemaVersion":2,"firstRecordedAt":721692800,"firstRecordedAppVersion":"2.0.0",\
      "applicationVersion":"1.0.1","applicationVersionKind":"marketingVersion",\
      "originalPurchaseDate":721692800,"arrivedFrom":"migration","cohort":{"era":"included"}}
      """
    defaults.set(Data(laterShape.utf8), forKey: OriginalInstall.storageKey)

    let record = OriginalInstall.current(defaults)

    XCTAssertEqual(record?.firstRecordedAt, firstLaunch, "unknown fields must be ignored, not fatal")
    XCTAssertEqual(record?.firstRecordedAppVersion, "2.0.0")
    XCTAssertEqual(record?.schemaVersion, 2, "the record says which shape it was written in")
  }

  func testARecordWithNoOptionalFieldsAtAllStillReads() {
    // The common case on a device that never got Apple's verified half, and also the shape written
    // before schemaVersion existed. It is the whole cohort answer on its own.
    let defaults = freshDefaults("still.originalInstall.tests.localHalfOnly")
    let localHalfOnly = #"{"firstRecordedAt":721692800,"firstRecordedAppVersion":"2.0.0"}"#
    defaults.set(Data(localHalfOnly.utf8), forKey: OriginalInstall.storageKey)

    let record = OriginalInstall.current(defaults)

    XCTAssertEqual(record?.firstRecordedAt, firstLaunch)
    XCTAssertEqual(record?.schemaVersion, 1, "no schemaVersion means the first shape, not a failure")
    XCTAssertNil(record?.applicationVersion)
    XCTAssertNil(record?.applicationVersionKind)
    XCTAssertNil(record?.originalPurchaseDate)
  }

  func testAVersionNamespaceThisBuildDoesNotKnowCostsOnlyThatField() {
    // If a later build ever tags a third version namespace, an older build reading that record
    // must lose the tag, not the record.
    let defaults = freshDefaults("still.originalInstall.tests.unknownNamespace")
    let unknownNamespace = """
      {"schemaVersion":1,"firstRecordedAt":721692800,"firstRecordedAppVersion":"2.0.0",\
      "applicationVersion":"1.0.1","applicationVersionKind":"someLaterNamespace",\
      "originalPurchaseDate":721692800}
      """
    defaults.set(Data(unknownNamespace.utf8), forKey: OriginalInstall.storageKey)

    let record = OriginalInstall.current(defaults)

    XCTAssertEqual(record?.firstRecordedAt, firstLaunch, "the record survives an unreadable tag")
    XCTAssertNil(record?.applicationVersionKind, "an unknown namespace reads as no namespace")
    XCTAssertEqual(record?.applicationVersion, "1.0.1")
  }

  func testWhatThisBuildWritesIsWhatThisBuildReads() {
    // Ties the hand-written literal above to the real encoder, so the literal cannot drift into
    // pinning a shape nothing actually writes.
    let defaults = freshDefaults("still.originalInstall.tests.roundTrip")
    OriginalInstall.ensure(firstRecordedAt: firstLaunch, appVersion: "2.0.0", defaults: defaults)
    OriginalInstall.fillVerifiedValues(
      applicationVersion: "1.0.1",
      kind: .marketingVersion,
      originalPurchaseDate: firstLaunch,
      defaults: defaults
    )

    let written = try? JSONSerialization.jsonObject(
      with: defaults.data(forKey: OriginalInstall.storageKey) ?? Data())
    let literal = try? JSONSerialization.jsonObject(with: Data(recordInTodaysShape.utf8))

    XCTAssertEqual(
      written as? NSDictionary,
      literal as? NSDictionary,
      "the stored shape changed: read the compatibility rules on OriginalInstallRecord, "
        + "then update the literal above"
    )
  }
}
