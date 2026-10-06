import Foundation

/// The app host submits decoded requests on MainActor, in arrival order. The bridge and its
/// mutable store are created and used only on this serial lane; the file lock remains the
/// cross-process authority. The Safari extension can keep using its synchronous bridge.
@MainActor
public final class SettingsExecutor {
  public static let appHost = SettingsExecutor()
  private let worker: Worker
  private var latestSubmission = UUID()

  public init(makeBridge: @escaping @Sendable () -> SettingsBridge = {
    SettingsBridge(store: .appGroup())
  }) {
    worker = Worker(makeBridge: makeBridge)
  }

  public func submit(_ request: BridgeRequest, completion: @escaping @MainActor (String) -> Void) {
    if request != .get { latestSubmission = UUID() }
    worker.submit(request, completion: completion)
  }

  /// Record this launch's first-record fact (owner decision 28) on the settings lane, ahead of any
  /// request submitted afterwards. It only matters to an initialize that finds nothing saved.
  /// First write wins for the process: `appHost` is shared by every window, and a later window's
  /// view controller (macOS) reads the marker after this launch already published it, so its
  /// answer must never replace the launch's own.
  public func prepareFirstRecord(_ kind: AtomicSettingsRecord.FirstRecord) {
    worker.prepareFirstRecord(kind)
  }

  /// A reread must not publish a snapshot preceding a subsequently submitted request. A nil
  /// completion asks the observer to reread after that work; bridge empty/unavailable stay intact.
  fileprivate func readLatest(completion: @escaping @MainActor (String?) -> Void) {
    let ticket = latestSubmission
    worker.submit(.get) { [weak self] json in
      guard let self else { return }
      completion(self.latestSubmission == ticket ? json : nil)
    }
  }

  // This is the only unchecked boundary: all access to bridge (including its construction) is
  // confined to queue, enforced below. Neither SettingsBridge nor SharedSettingsStore is Sendable
  // or exposed to the app's actor. Only decoded Sendable requests and String results cross lanes.
  private final class Worker: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.chartash.still.app-settings", qos: .userInitiated)
    private let makeBridge: @Sendable () -> SettingsBridge
    private var bridge: SettingsBridge?
    private var firstRecord: AtomicSettingsRecord.FirstRecord?

    init(makeBridge: @escaping @Sendable () -> SettingsBridge) { self.makeBridge = makeBridge }

    func prepareFirstRecord(_ kind: AtomicSettingsRecord.FirstRecord) {
      queue.async { [self] in
        guard firstRecord == nil else { return }
        firstRecord = kind
        bridge?.firstRecord = kind
      }
    }

    func submit(_ request: BridgeRequest, completion: @escaping @MainActor (String) -> Void) {
      queue.async { [self] in
        dispatchPrecondition(condition: .onQueue(queue))
        if bridge == nil {
          bridge = makeBridge()
          if let firstRecord { bridge!.firstRecord = firstRecord }
        }
        let json = bridge!.handle(request)
        // FIFO main-queue delivery also preserves reply order when multiple transactions finish
        // before MainActor gets another turn. No UI/reply closure runs on the settings lane.
        DispatchQueue.main.async { completion(json) }
      }
    }
  }
}

/// At most one read and one requested follow-up per observer. Completion captures this observer
/// weakly, so teardown does not retain a controller while a peer holds the file lock.
@MainActor
public final class SettingsReadObserver {
  private let executor: SettingsExecutor
  private let publish: @MainActor (String) -> Void
  private var reading = false
  private var needsRead = false
  private var active = true
  private let darwinNotificationName: String?

  private final class WeakObserver {
    weak var value: SettingsReadObserver?
    init(_ value: SettingsReadObserver) { self.value = value }
  }
  private static var observers: [UInt: WeakObserver] = [:]

  public init(executor: SettingsExecutor, darwinNotificationName: String? = nil,
              publish: @escaping @MainActor (String) -> Void) {
    self.executor = executor
    self.publish = publish
    self.darwinNotificationName = darwinNotificationName
    if let name = darwinNotificationName {
      let pointer = Unmanaged.passUnretained(self).toOpaque()
      Self.observers[UInt(bitPattern: pointer)] = WeakObserver(self)
      CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), pointer,
        { _, observer, _, _, _ in
          guard let observer else { return }
          // Treat the opaque address as an identity ONLY; never dereference a controller or a
          // possibly retired observer on the Darwin callback thread. Resolve weakly on MainActor.
          let key = UInt(bitPattern: observer)
          Task { @MainActor in SettingsReadObserver.observers[key]?.value?.refresh() }
        }, name as CFString, nil, .deliverImmediately)
    }
  }

  deinit {
    if let name = darwinNotificationName {
      let pointer = Unmanaged.passUnretained(self).toOpaque()
      CFNotificationCenterRemoveObserver(CFNotificationCenterGetDarwinNotifyCenter(), pointer,
        CFNotificationName(name as CFString), nil)
      let key = UInt(bitPattern: pointer)
      Task { @MainActor in
        // A new observer could reuse the address before this cleanup runs.
        if Self.observers[key]?.value == nil { Self.observers.removeValue(forKey: key) }
      }
    }
  }

  public func invalidate() {
    active = false
    needsRead = false
    if let name = darwinNotificationName {
      let pointer = Unmanaged.passUnretained(self).toOpaque()
      CFNotificationCenterRemoveObserver(CFNotificationCenterGetDarwinNotifyCenter(), pointer,
        CFNotificationName(name as CFString), nil)
      Self.observers.removeValue(forKey: UInt(bitPattern: pointer))
    }
  }

  public func refresh() {
    guard active else { return }
    needsRead = true
    readIfNeeded()
  }

  private func readIfNeeded() {
    guard active, needsRead, !reading else { return }
    needsRead = false
    reading = true
    executor.readLatest { [weak self] json in
      guard let self, self.active else { return }
      self.reading = false
      if let json, !self.needsRead { self.publish(json) } else { self.needsRead = true }
      self.readIfNeeded()
    }
  }
}
