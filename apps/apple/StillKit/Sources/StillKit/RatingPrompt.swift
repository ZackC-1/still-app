import Foundation

/// The Apple rating path (U13-P3): local eligibility, one fresh owner allowance, reserve, commit,
/// and only then Apple's own review sheet. The app's `RatingPromptPresenter` supplies the sheet;
/// everything that decides whether it may be asked for lives here, so it is testable.
///
/// Rules, each pinned by `RatingPromptTests`:
/// - Only Still app openings count toward the three days of use (coordinator ruling). The Safari
///   extension never records an opening and never shows anything: Safari maps to its Apple host.
/// - Held while the app can tell the Safari extension is turned off (macOS). On iPhone the app
///   cannot tell, so nothing is held for that reason.
/// - Local eligibility first; nothing is fetched for an opening the ledger would not offer.
/// - Then exactly one fresh allowance, bounded at five seconds. Only a fresh `.on` counts; a
///   cached value is never an input.
/// - The allowance counts only for the opening that captured it (reserve re-arbitrates).
/// - The consumed flag is committed to the App Group ledger BEFORE StoreKit is called. A rejected or
///   failed commit means no call. A system-suppressed sheet still consumed the one attempt.
/// - No analytics, notifications or identifiers. Nothing records whether anyone rated.
public enum RatingPrompt {
  /// Coordinator ruling (2026-10-05, U13 owner question 5): the 168 hour spacing applies between
  /// any two invitations, sync or rating. Every other parameter keeps the proposal.
  public static let parameters = InvitationOwnerParameters(
    spaceRatingFromInvitations: true, countedControls: InvitationOwnerParameters.proposed.countedControls)

  /// A fresh allowance check that has not answered within this many seconds is Off.
  public static let allowanceTimeoutSeconds: TimeInterval = 5

  /// The App Group record the app and the extension serialize through (one cross-process lock).
  public static let ledgerRecordName = "still-invitations"

  /// The ledger over the App Group atomic store, or nil when this process has no container.
  public static func appGroupLedger(_ identifier: String = StillAppGroup.identifier,
                                    container: (String) -> URL? = { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) })
    -> InvitationLedgerStore? {
    guard let directory = container(identifier) else { return nil }
    return InvitationLedgerStore(backing: AtomicSettingsBacking(directory: directory, name: ledgerRecordName), parameters: parameters)
  }

  /// The policy surface of the app on this platform.
  public static var appSurface: String {
    #if os(macOS)
    return "apple_macos_host"
    #else
    return "apple_mobile_host"
    #endif
  }

  public enum Refusal: String, Equatable, Sendable { case held, local, policy, reserve, commit }
  public enum Outcome: Equatable, Sendable {
    /// The attempt is consumed and StoreKit was asked. Apple may still decide not to show a sheet.
    case requested
    case notRequested(Refusal)
  }

  public static func wallMilliseconds() -> Int { Int((Date().timeIntervalSince1970 * 1000).rounded(.down)) }
}

/// Runs one app opening through the rating path. Not tied to an actor: the ledger work is a short
/// locked file transaction, and the sheet is requested through the caller's main-actor closure.
public final class RatingPromptCoordinator: @unchecked Sendable {
  public typealias FreshCheck = @Sendable () async -> ProductPolicy.Verdict

  private let store: InvitationLedgerStore
  private let freshCheck: FreshCheck
  private let now: () -> Int
  private let timeoutSeconds: TimeInterval

  public init(store: InvitationLedgerStore, freshCheck: @escaping FreshCheck,
              now: @escaping () -> Int = RatingPrompt.wallMilliseconds,
              timeoutSeconds: TimeInterval = RatingPrompt.allowanceTimeoutSeconds) {
    self.store = store
    self.freshCheck = freshCheck
    self.now = now
    self.timeoutSeconds = timeoutSeconds
  }

  /// Create the ledger once, fill a newly known anchor, and record this app opening's day of use.
  @discardableResult
  public func recordOpening(installation: String, anchorMs: Int?, opening: String, ordinary: Bool,
                            timeZone: TimeZone = .current) -> InvitationLedgerStore.Status {
    let created = store.ensure(installation: installation, anchorMs: anchorMs)
    guard created == .ready else { return created }
    if let anchorMs {
      let adopted = store.adoptAnchor(anchorMs)
      guard adopted == .ready else { return adopted }
    }
    let at = now()
    return store.recordOpening(InvitationOpening(
      opening: opening, ordinary: ordinary, nowMs: at, localDay: InvitationDayOrdinal.local(epochMs: at, timeZone: timeZone)))
  }

  /// Decide for this opening, and call `requestReview` only after the attempt is durably consumed.
  public func promptIfAllowed(opening: String, syncApplicable: Bool, linkApplicable: Bool,
                              suppressed: InvitationSuppression?, extensionStatus: SafariExtensionStatus,
                              requestReview: @escaping @MainActor @Sendable () -> Void) async -> RatingPrompt.Outcome {
    if extensionStatus == .disabled { return .notRequested(.held) }
    func context(_ at: Int) -> InvitationContext {
      InvitationContext(opening: opening, nowMs: at, syncApplicable: syncApplicable, linkApplicable: linkApplicable, suppressed: suppressed)
    }
    // 1. Local eligibility. Nothing is fetched unless the ledger would offer a rating now.
    guard store.arbitrate(context(now())).kind == .rating else { return .notRequested(.local) }
    // 2. One fresh owner allowance, for this opening only.
    let verdict = await Self.bounded(freshCheck, seconds: timeoutSeconds)
    guard verdict.allowed, verdict.reason == .on else { return .notRequested(.policy) }
    // 3. Reserve against the captured opening; a newer opening or another host wins.
    guard let reservation = store.reserve(.rating, context(now())) else { return .notRequested(.reserve) }
    // 4. Commit the consumed flag BEFORE StoreKit. Rejected or failed: no call.
    guard store.commit(reservation, nowMs: now()) else { return .notRequested(.commit) }
    // 5. Apple's own sheet. Whether Apple shows it or not, the one attempt is already spent.
    await MainActor.run { requestReview() }
    return .requested
  }

  /// The fresh check, or Off when it has not answered in time. A late answer is never read.
  static func bounded(_ check: @escaping FreshCheck, seconds: TimeInterval) async -> ProductPolicy.Verdict {
    await withCheckedContinuation { (continuation: CheckedContinuation<ProductPolicy.Verdict, Never>) in
      let once = ResumeOnce(continuation)
      let timer = Task {
        try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
        once.resume(ProductPolicy.Verdict(.late))
      }
      Task {
        let verdict = await check()
        timer.cancel()
        once.resume(verdict)
      }
    }
  }

  private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<ProductPolicy.Verdict, Never>?
    init(_ continuation: CheckedContinuation<ProductPolicy.Verdict, Never>) { self.continuation = continuation }
    func resume(_ value: ProductPolicy.Verdict) {
      lock.lock()
      let pending = continuation
      continuation = nil
      lock.unlock()
      pending?.resume(returning: value)
    }
  }
}
