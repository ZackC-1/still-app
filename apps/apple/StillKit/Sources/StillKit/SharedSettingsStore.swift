import Foundation

// The shared settings store + its pluggable backing (KTD4). Production uses the App Group container
// (so the app, the Safari extension, and the WKWebView agree); tests use an in-memory backing.
// Merge uses server sync metadata when present, falling back to last-write-wins by `updatedAt` for
// old settings-only records.

public protocol SettingsBacking {
  func read() -> Data?
  func write(_ data: Data)
}

public final class SharedSettingsStore {
  private let backing: SettingsBacking
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(backing: SettingsBacking) {
    self.backing = backing
  }

  /// The current settings, or the defaults if nothing has been written / the data is unreadable.
  public func current() -> StillSettings {
    currentRecord().settings
  }

  public func currentRecord() -> StoredSettingsRecord {
    peekRecord() ?? StoredSettingsRecord(settings: .default, syncMetadata: nil)
  }

  /// The stored settings, or nil if nothing has ever been written (unlike `current()`, which folds a
  /// missing/unreadable value into the defaults). The bridge uses this to answer a web `get` with an
  /// empty reply on a fresh install, so the WKWebView UI shows bundled defaults rather than a
  /// spurious `updatedAt: 0` write that could mask a newer value on the other side.
  public func peek() -> StillSettings? {
    peekRecord()?.settings
  }

  public func peekRecord() -> StoredSettingsRecord? {
    guard let data = backing.read(), let record = try? decoder.decode(StoredSettingsRecord.self, from: data) else {
      return nil
    }
    return record
  }

  /// Persist settings as JSON the web UI can also read.
  public func save(_ settings: StillSettings) {
    saveRecord(StoredSettingsRecord(settings: settings, syncMetadata: currentRecord().syncMetadata))
  }

  public func saveRecord(_ record: StoredSettingsRecord) {
    guard let data = try? encoder.encode(record) else { return }
    backing.write(data)
  }

  /// Apply an incoming settings set via last-write-wins. Returns true if the store changed.
  @discardableResult
  public func applyRemote(_ incoming: StillSettings) -> Bool {
    guard currentRecord().syncMetadata == nil, incoming.updatedAt > current().updatedAt else { return false }
    saveRecord(StoredSettingsRecord(settings: incoming, syncMetadata: nil))
    return true
  }

  @discardableResult
  public func applyRecord(_ incoming: StoredSettingsRecord) -> Bool {
    guard shouldApply(incoming, over: currentRecord()) else { return false }
    saveRecord(incoming)
    return true
  }
}

private func shouldApply(_ incoming: StoredSettingsRecord, over current: StoredSettingsRecord) -> Bool {
  switch (incoming.syncMetadata, current.syncMetadata) {
  case let (incoming?, current?):
    if incoming.version != current.version { return incoming.version > current.version }
    return incoming.serverUpdatedAt > current.serverUpdatedAt
  case (.some, .none):
    return true
  case (.none, .some):
    return false
  case (.none, .none):
    return incoming.settings.updatedAt > current.settings.updatedAt
  }
}

/// The shared App Group identifier — the single source of truth for the app, the Safari extension,
/// and the WKWebView UI. Must match the App Groups capability set on every target's entitlements.
public enum StillAppGroup {
  public static let identifier = "group.com.chartash.still"
}

/// The Darwin notification posted whenever a bridge `set` actually changes the stored settings, so
/// the sibling App-Group process (app ↔ Safari extension) can refresh without polling. Darwin
/// notifications are the only broadcast that crosses the App-Group process boundary
/// (NotificationCenter is per-process); they carry no payload, so observers re-read the store.
public enum StillSettingsChangedNotification {
  public static let name = "com.chartash.still.settings-changed"
}

extension SharedSettingsStore {
  /// The production store backed by the shared App Group container, falling back to an in-memory
  /// backing if the App Group is unavailable (e.g. the entitlement isn't provisioned on this build)
  /// so the WKWebView UI still launches and renders — it just won't persist across processes.
  public static func appGroup(_ identifier: String = StillAppGroup.identifier) -> SharedSettingsStore {
    SharedSettingsStore(backing: AppGroupBacking(appGroupId: identifier) ?? InMemoryBacking())
  }
}

/// App Group backing — the real cross-process store shared by the app + Safari extension. The key
/// selects the lane: settings ("still:settings") or the entitlement record ("still:entitlement").
public struct AppGroupBacking: SettingsBacking {
  private let defaults: UserDefaults
  private let key: String

  public init?(appGroupId: String, key: String = "still:settings") {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return nil }
    self.defaults = defaults
    self.key = key
  }

  public func read() -> Data? { defaults.data(forKey: key) }
  public func write(_ data: Data) { defaults.set(data, forKey: key) }
}

/// In-memory backing for unit tests.
public final class InMemoryBacking: SettingsBacking {
  private var data: Data?
  public init(_ initial: Data? = nil) { self.data = initial }
  public func read() -> Data? { data }
  public func write(_ data: Data) { self.data = data }
}
