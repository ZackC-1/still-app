import XCTest
@testable import StillKit

final class SettingsExecutorTests: XCTestCase {
  private final class Events: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    func append(_ value: String) { lock.lock(); defer { lock.unlock() }; values.append(value) }
    func contains(_ value: String) -> Bool { lock.lock(); defer { lock.unlock() }; return values.contains(value) }
    var snapshot: [String] { lock.lock(); defer { lock.unlock() }; return values }
  }

  private final class CountingBacking: SettingsBacking {
    let backing: AtomicSettingsBacking
    let events: Events
    init(directory: URL, events: Events) { backing = AtomicSettingsBacking(directory: directory); self.events = events }
    func read() -> Data? { try? transaction { $0 } }
    func write(_ data: Data) { try? transaction { $0 = data } }
    func transaction<T>(_ body: (inout Data?) throws -> T) throws -> T {
      events.append("transaction")
      return try backing.transaction(body)
    }
  }

  private final class WeakReference<T: AnyObject> {
    weak var value: T?
    init(_ value: T?) { self.value = value }
  }

  private func directory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("still-executor-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }

  private func seed(_ directory: URL) throws -> Data {
    let store = SharedSettingsStore(backing: AtomicSettingsBacking(directory: directory))
    store.save(StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 1))
    _ = try store.initializeAtomic(ownership: "unknown")
    return try XCTUnwrap(store.readCommittedRecord())
  }

  private func object(_ json: String) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
  }

  /// The peer holds the real flock until MainActor's sentinel releases it. A fallback releases it
  /// after one second so the old synchronous path fails the discriminator without hanging tests.
  @MainActor
  func testMainActorSentinelRunsDuringLiveLockWithoutEarlyReplyOrNotification() async throws {
    let dir = try directory(); let before = try seed(dir)
    let locked = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    let events = Events()
    let peerDone = expectation(description: "peer released")
    DispatchQueue.global().async {
      defer { peerDone.fulfill() }
      _ = try? AtomicSettingsBacking(directory: dir).transaction { _ in
        locked.signal(); _ = release.wait(timeout: .now() + 1)
        events.append("released")
      }
    }
    XCTAssertEqual(locked.wait(timeout: .now() + 2), .success)
    let started = expectation(description: "settings lane starts while lock is held")
    let executor = SettingsExecutor {
      XCTAssertFalse(Thread.isMainThread)
      started.fulfill()
      return SettingsBridge(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)),
                            notifyChanged: {
        let bytes = try? Data(contentsOf: dir.appendingPathComponent("still-settings.json"))
        XCTAssertNotEqual(bytes, before, "notification follows durable replacement")
        events.append("notification")
      })
    }
    let reply = expectation(description: "committed reply")
    let sentinel = expectation(description: "actual MainActor sentinel")
    executor.submit(.intent(path: "globalOn", value: false, updatedAt: 10)) { json in
      XCTAssertTrue(Thread.isMainThread)
      XCTAssertTrue(events.contains("released"))
      XCTAssertTrue(events.contains("notification"))
      XCTAssertEqual(try? self.object(json)["status"] as? String, "committed")
      events.append("reply"); reply.fulfill()
    }
    await fulfillment(of: [started], timeout: 3)
    DispatchQueue.main.async {
      XCTAssertTrue(Thread.isMainThread)
      XCTAssertFalse(events.contains("released"), "MainActor must run while the live lock is held")
      XCTAssertFalse(events.contains("reply")); XCTAssertFalse(events.contains("notification"))
      XCTAssertEqual(try? Data(contentsOf: dir.appendingPathComponent("still-settings.json")), before)
      release.signal(); sentinel.fulfill()
    }
    await fulfillment(of: [sentinel, peerDone, reply], timeout: 4)
    let committed = try SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)).readCommittedRecord()
    XCTAssertNotEqual(committed, before)
    XCTAssertEqual(events.snapshot, ["released", "notification", "reply"])
  }

  @MainActor
  func testOldSynchronousHostFailsTheSameMainActorSentinelDiscriminator() async throws {
    let dir = try directory(); _ = try seed(dir)
    let locked = DispatchSemaphore(value: 0), events = Events()
    let peerDone = expectation(description: "live peer completes")
    DispatchQueue.global().async {
      defer { peerDone.fulfill() }
      _ = try? AtomicSettingsBacking(directory: dir).transaction { _ in
        locked.signal(); Thread.sleep(forTimeInterval: 0.2); events.append("released")
      }
    }
    XCTAssertEqual(locked.wait(timeout: .now() + 2), .success)
    let sentinel = expectation(description: "old path sentinel")
    var ranWhileHeld = true
    DispatchQueue.main.async {
      ranWhileHeld = !events.contains("released"); sentinel.fulfill()
    }
    _ = SettingsBridge(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)),
                       notifyChanged: {}).handle(.get)
    await fulfillment(of: [peerDone, sentinel], timeout: 3)
    XCTAssertFalse(ranWhileHeld, "The synchronous control must fail the responsiveness discriminator")
  }

  @MainActor
  func testQueuedIntentsAndInterleavedReadPreserveArrivalAndCommittedMetadata() async throws {
    let dir = try directory(); _ = try seed(dir)
    let executor = SettingsExecutor {
      SettingsBridge(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)), notifyChanged: {})
    }
    let done = expectation(description: "three ordered replies"); done.expectedFulfillmentCount = 3
    var replies: [String] = []
    executor.submit(.intent(path: "globalOn", value: false, updatedAt: 10)) { replies.append($0); done.fulfill() }
    executor.submit(.get) { replies.append($0); done.fulfill() }
    executor.submit(.intent(path: "globalOn", value: true, updatedAt: 10)) { replies.append($0); done.fulfill() }
    await fulfillment(of: [done], timeout: 3)
    let first = try XCTUnwrap(try object(replies[0])["record"] as? [String: Any])
    let reread = try object(replies[1])
    let last = try XCTUnwrap(try object(replies[2])["record"] as? [String: Any])
    XCTAssertTrue(NSDictionary(dictionary: first).isEqual(to: reread))
    let firstSettings = try XCTUnwrap(first["settings"] as? [String: Any])
    let lastSettings = try XCTUnwrap(last["settings"] as? [String: Any])
    XCTAssertEqual(firstSettings["globalOn"] as? Bool, false)
    XCTAssertEqual(lastSettings["globalOn"] as? Bool, true)
    let clocks = try XCTUnwrap(lastSettings["clocks"] as? [String: [String: Int]])
    XCTAssertEqual(clocks["globalOn"]?["localStep"], 2)
    let state = try XCTUnwrap(last["atomic"] as? [String: Any])
    let pending = try XCTUnwrap(state["pending"] as? [[String: Any]])
    XCTAssertEqual(pending.count, 2)
    XCTAssertEqual(Set(pending.compactMap { $0["writeId"] as? String }).count, 2)
  }

  @MainActor
  func testObserverDropsReadPrecedingQueuedMutationAndPublishesFreshReread() async throws {
    let dir = try directory(); _ = try seed(dir)
    let executor = SettingsExecutor {
      SettingsBridge(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)), notifyChanged: {})
    }
    let published = expectation(description: "fresh observation")
    var records: [String] = []
    let observer = SettingsReadObserver(executor: executor) { records.append($0); published.fulfill() }
    observer.refresh()
    executor.submit(.intent(path: "globalOn", value: false, updatedAt: 10)) { _ in }
    await fulfillment(of: [published], timeout: 3)
    XCTAssertEqual(records.count, 1)
    let settings = try XCTUnwrap(try object(records[0])["settings"] as? [String: Any])
    XCTAssertEqual(settings["globalOn"] as? Bool, false)
  }

  @MainActor
  func testConcurrentObserversAndReadRequestsDoNotInvalidateOneAnother() async throws {
    let dir = try directory(); _ = try seed(dir)
    let executor = SettingsExecutor {
      SettingsBridge(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)), notifyChanged: {})
    }
    let published = expectation(description: "both observations and read reply"); published.expectedFulfillmentCount = 3
    let first = SettingsReadObserver(executor: executor) { _ in published.fulfill() }
    let second = SettingsReadObserver(executor: executor) { _ in published.fulfill() }
    first.refresh(); second.refresh(); executor.submit(.get) { _ in published.fulfill() }
    await fulfillment(of: [published], timeout: 3)
  }

  @MainActor
  func testRefreshStormIsBoundedToOneReadAndOneFreshFollowUp() async throws {
    let dir = try directory(); _ = try seed(dir)
    let locked = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    let peerDone = expectation(description: "peer released")
    DispatchQueue.global().async {
      defer { peerDone.fulfill() }
      _ = try? AtomicSettingsBacking(directory: dir).transaction { _ in
        locked.signal(); _ = release.wait(timeout: .now() + 2)
      }
    }
    XCTAssertEqual(locked.wait(timeout: .now() + 2), .success)
    let events = Events()
    let executor = SettingsExecutor {
      SettingsBridge(store: SharedSettingsStore(backing: CountingBacking(directory: dir, events: events)), notifyChanged: {})
    }
    let published = expectation(description: "one latest publication")
    var publications = 0
    let observer = SettingsReadObserver(executor: executor) { _ in publications += 1; published.fulfill() }
    for _ in 0..<200 { observer.refresh() }
    release.signal()
    await fulfillment(of: [peerDone, published], timeout: 4)
    XCTAssertEqual(publications, 1)
    XCTAssertEqual(events.snapshot, ["transaction", "transaction"])
  }

  @MainActor
  func testDarwinNotificationUsesTheSameExecutorAndPublishesOnMainActor() async throws {
    let dir = try directory(); let before = try seed(dir)
    let events = Events()
    let executor = SettingsExecutor {
      SettingsBridge(store: SharedSettingsStore(backing: CountingBacking(directory: dir, events: events)), notifyChanged: {})
    }
    let name = "com.chartash.still.test." + UUID().uuidString
    let published = expectation(description: "Darwin reread")
    let observer = SettingsReadObserver(executor: executor, darwinNotificationName: name) {
      XCTAssertTrue(Thread.isMainThread); XCTAssertEqual(Data($0.utf8), before); published.fulfill()
    }
    CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
    await fulfillment(of: [published], timeout: 3)
    XCTAssertEqual(events.snapshot, ["transaction"])
    observer.invalidate()
  }

  @MainActor
  func testFailedCommitPreservesBytesAndExactReplyWithoutNotification() async throws {
    let dir = try directory(); let before = try seed(dir); let events = Events()
    enum Injected: Error { case replacement }
    let executor = SettingsExecutor {
      SettingsBridge(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir,
        beforeReplace: { throw Injected.replacement })), notifyChanged: { events.append("notification") })
    }
    let done = expectation(description: "failure then read"); done.expectedFulfillmentCount = 2
    executor.submit(.intent(path: "globalOn", value: false, updatedAt: 10)) { XCTAssertEqual($0, ""); done.fulfill() }
    executor.submit(.get) { XCTAssertEqual(Data($0.utf8), before); done.fulfill() }
    await fulfillment(of: [done], timeout: 3)
    XCTAssertEqual(events.snapshot, [])
    XCTAssertEqual(try SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)).readCommittedRecord(), before)
  }

  @MainActor
  func testReadFailureAndEmptyKeepTheirDistinctBridgeResponses() async throws {
    let dir = try directory()
    let unavailable = dir.appendingPathComponent("file")
    try Data([1]).write(to: unavailable)
    let failure = SettingsExecutor {
      SettingsBridge(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: unavailable)), notifyChanged: {})
    }
    let empty = SettingsExecutor { SettingsBridge(store: SharedSettingsStore(backing: InMemoryBacking()), notifyChanged: {}) }
    let done = expectation(description: "empty and unavailable"); done.expectedFulfillmentCount = 3
    let observer = SettingsReadObserver(executor: failure) {
      XCTAssertEqual($0, "{\"status\":\"unavailable\"}"); done.fulfill()
    }
    observer.refresh()
    failure.submit(.atomic(Data("{}".utf8))) { XCTAssertEqual($0, "{\"status\":\"unavailable\"}"); done.fulfill() }
    empty.submit(.get) { XCTAssertEqual($0, ""); done.fulfill() }
    await fulfillment(of: [done], timeout: 3)
  }

  @MainActor
  func testInvalidationRetiresQueuedReadAndDarwinListener() async throws {
    let dir = try directory(); _ = try seed(dir)
    let executor = SettingsExecutor {
      SettingsBridge(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)), notifyChanged: {})
    }
    let name = "com.chartash.still.test." + UUID().uuidString
    var publications = 0
    let observer = SettingsReadObserver(executor: executor, darwinNotificationName: name) { _ in publications += 1 }
    observer.refresh(); observer.invalidate(); observer.refresh()
    CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
    let drained = expectation(description: "queued completion drained")
    executor.submit(.get) { _ in drained.fulfill() }
    await fulfillment(of: [drained], timeout: 3)
    XCTAssertEqual(publications, 0)
  }

  @MainActor
  func testReleasedObserverAndOwnerAreNotRetainedByBlockedReadOrDarwinCallback() async throws {
    final class Owner {}
    let dir = try directory(); _ = try seed(dir)
    let locked = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    let peerDone = expectation(description: "peer released")
    DispatchQueue.global().async {
      defer { peerDone.fulfill() }
      _ = try? AtomicSettingsBacking(directory: dir).transaction { _ in
        locked.signal(); _ = release.wait(timeout: .now() + 2)
      }
    }
    XCTAssertEqual(locked.wait(timeout: .now() + 2), .success)
    let executor = SettingsExecutor {
      SettingsBridge(store: SharedSettingsStore(backing: AtomicSettingsBacking(directory: dir)), notifyChanged: {})
    }
    let name = "com.chartash.still.test." + UUID().uuidString
    var owner: Owner? = Owner(); let weakOwner = WeakReference(owner)
    var observer: SettingsReadObserver? = SettingsReadObserver(executor: executor, darwinNotificationName: name) { [weak owner] _ in
      XCTAssertNil(owner); XCTFail("released observer must never publish")
    }
    let weakObserver = WeakReference(observer)
    observer?.refresh()
    CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
    observer = nil; owner = nil
    XCTAssertNil(weakObserver.value); XCTAssertNil(weakOwner.value)
    release.signal()
    let drained = expectation(description: "late read drained")
    executor.submit(.get) { _ in drained.fulfill() }
    await fulfillment(of: [peerDone, drained], timeout: 4)
    CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
    await Task.yield()
    XCTAssertNil(weakObserver.value)
  }
}
