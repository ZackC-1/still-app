import Foundation

/// What the App Store's current-entitlements list says about Still's purchase products, as read by
/// the APP TARGET from StoreKit 2 (`Transaction.currentEntitlements`). StillKit never performs
/// StoreKit I/O; it receives this value and owns the decision built on it.
public enum AppStoreEntitlementRead: Sendable, Equatable {
  /// A verified, unrevoked transaction for one of the products is in the list.
  case verified
  /// Only an unverified transaction for one of the products is in the list: something is there,
  /// but it is not proven, so it can be called neither restored nor absent.
  case unverified
  /// No transaction for any of the products is in the list.
  case absent
}

/// The read-only App Store seam the free-period Restore uses. It has exactly two members, and both
/// only read: listing what this Apple Account already owns, and asking the App Store to bring that
/// list up to date. Nothing reachable through it can sell, charge, or touch RevenueCat, which is
/// what lets the Restore tap run while the paid tier is switched off.
public protocol FreePeriodRestoreStore: Sendable {
  /// The current-entitlements list, narrowed to `productIDs`.
  func currentEntitlement(matching productIDs: Set<String>) async -> AppStoreEntitlementRead
  /// `AppStore.sync()`: bring this device's transactions up to date with the App Store. It may show
  /// an Apple Account sign-in sheet, so it is called only from the person's explicit Restore tap.
  /// Throws on cancel or failure.
  func syncWithAppStore() async throws
}

/// The conclusive answer the free-period Restore gives the web layer.
public enum FreePeriodRestoreResult: String, Sendable, Equatable {
  /// This Apple Account holds a verified Still purchase.
  case restored
  /// The App Store answered and this Apple Account holds no Still purchase (never bought, or the
  /// purchase was refunded or revoked: Apple drops revoked transactions from the list).
  case none
  /// No conclusive answer: the sync failed, was cancelled, or ran out of time, or the list held
  /// only an unverified transaction. Never reported as `none`.
  case failed
}

/// The Restore tap while the paid tier is off (owner decision 17): a real, read-only App Store
/// check that tells a past buyer their purchase is still theirs, without selling anything and
/// without unlocking anything. The result is only an answer for the screen. Any change to the App
/// Group entitlement stamp still goes through the existing receipt lane and `StampPolicy`, and while
/// the paid tier is off the extension's access snapshot ignores that stamp entirely.
///
/// One check at a time: a second tap while one runs joins it rather than asking Apple twice, so at
/// most one sign-in sheet can be raised by this path.
@MainActor
public final class FreePeriodRestoreCheck {
  /// Every product a past purchase can be restored from: the historical 2.x product and the
  /// current one. Exact identifiers from the single catalog.
  public nonisolated static let restorableProductIDs = Set(ApplePurchaseCatalog.all.map(\.productID))

  /// Bound on one read of the current-entitlements list. It shows no UI, so this matches the bound
  /// the receipt read already uses.
  public nonisolated static let defaultReadDeadlineNanoseconds: UInt64 = 8_000_000_000
  /// Bound on the sync. It can put an Apple Account sign-in sheet in front of the person, so it
  /// allows time to type a password; past it the check answers `failed` with Try again.
  public nonisolated static let defaultSyncDeadlineNanoseconds: UInt64 = 120_000_000_000

  private let store: FreePeriodRestoreStore
  private let productIDs: Set<String>
  private let readDeadline: UInt64
  private let syncDeadline: UInt64
  private var inFlight: Task<FreePeriodRestoreResult, Never>?

  public init(
    store: FreePeriodRestoreStore,
    productIDs: Set<String> = FreePeriodRestoreCheck.restorableProductIDs,
    readDeadlineNanoseconds: UInt64 = FreePeriodRestoreCheck.defaultReadDeadlineNanoseconds,
    syncDeadlineNanoseconds: UInt64 = FreePeriodRestoreCheck.defaultSyncDeadlineNanoseconds
  ) {
    self.store = store
    self.productIDs = productIDs
    self.readDeadline = readDeadlineNanoseconds
    self.syncDeadline = syncDeadlineNanoseconds
  }

  /// Run the check, or join the one already running.
  public func run() async -> FreePeriodRestoreResult {
    if let inFlight { return await inFlight.value }
    let store = self.store, productIDs = self.productIDs
    let readDeadline = self.readDeadline, syncDeadline = self.syncDeadline
    let task = Task<FreePeriodRestoreResult, Never> {
      await Self.check(
        store: store, productIDs: productIDs,
        readDeadline: readDeadline, syncDeadline: syncDeadline)
    }
    inFlight = task
    let result = await task.value
    // Only the caller that started this check clears it, and only if it is still the current one.
    if inFlight == task { inFlight = nil }
    return result
  }

  /// 1. Read the list with no prompt: a purchase already on this device is restored at once.
  /// 2. Otherwise sync with the App Store. Any failure, cancel or timeout is `failed`.
  /// 3. Read again. Only a verified purchase is `restored`, and only a verified empty list after a
  ///    successful sync is `none`; anything else is `failed`.
  nonisolated static func check(
    store: FreePeriodRestoreStore,
    productIDs: Set<String>,
    readDeadline: UInt64,
    syncDeadline: UInt64
  ) async -> FreePeriodRestoreResult {
    let local = await withDeadline(readDeadline) {
      await store.currentEntitlement(matching: productIDs)
    }
    if local == .verified { return .restored }

    let synced = await withDeadline(syncDeadline) { () async -> Bool in
      do {
        try await store.syncWithAppStore()
        return true
      } catch {
        return false
      }
    }
    guard synced == true else { return .failed }

    switch await withDeadline(readDeadline, { await store.currentEntitlement(matching: productIDs) }) {
    case .verified?: return .restored
    case .absent?: return .none
    case .unverified?, nil: return .failed
    }
  }

  /// The web reply for a result. `entitled` keeps the shape every existing reader of the restore
  /// reply understands; `restore` is the conclusive answer.
  public nonisolated static func reply(for result: FreePeriodRestoreResult) -> [String: Any] {
    ["entitled": result == .restored, "restore": result.rawValue]
  }

  /// `operation`'s value, or nil when it has not finished within `nanoseconds`. Unstructured on
  /// purpose: a task group waits for every child, so an App Store call that ignores cancellation
  /// would hold the bridge past its deadline. The late value is simply dropped.
  nonisolated static func withDeadline<T: Sendable>(
    _ nanoseconds: UInt64,
    _ operation: @escaping @Sendable () async -> T
  ) async -> T? {
    let once = ResumeOnce()
    return await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
      Task {
        let value = await operation()
        once.run { continuation.resume(returning: value) }
      }
      Task {
        try? await Task.sleep(nanoseconds: nanoseconds)
        once.run { continuation.resume(returning: nil) }
      }
    }
  }
}

/// Resume-at-most-once guard: a second resume of a continuation is a fatal misuse.
private final class ResumeOnce: @unchecked Sendable {
  private let lock = NSLock()
  private var done = false
  func run(_ body: () -> Void) {
    lock.lock()
    defer { lock.unlock() }
    guard !done else { return }
    done = true
    body()
  }
}
