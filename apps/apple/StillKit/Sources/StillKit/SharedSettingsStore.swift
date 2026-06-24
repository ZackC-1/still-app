import Foundation

// The shared settings store + its pluggable backing (KTD4). Production uses the App Group container
// (so the app, the Safari extension, and the WKWebView agree); tests use an in-memory backing.
// Merge is last-write-wins by `updatedAt`, mirroring the TypeScript SettingsCache.

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
    peek() ?? .default
  }

  /// The stored settings, or nil if nothing has ever been written (unlike `current()`, which folds a
  /// missing/unreadable value into the defaults). The bridge uses this to answer a web `get` with an
  /// empty reply on a fresh install, so the WKWebView UI shows bundled defaults rather than a
  /// spurious `updatedAt: 0` write that could mask a newer value on the other side.
  public func peek() -> StillSettings? {
    guard let data = backing.read(), let settings = try? decoder.decode(StillSettings.self, from: data) else {
      return nil
    }
    return settings
  }

  /// Persist settings as JSON the web UI can also read.
  public func save(_ settings: StillSettings) {
    guard let data = try? encoder.encode(settings) else { return }
    backing.write(data)
  }

  /// Apply an incoming settings set via last-write-wins. Returns true if the store changed.
  @discardableResult
  public func applyRemote(_ incoming: StillSettings) -> Bool {
    guard incoming.updatedAt > current().updatedAt else { return false }
    save(incoming)
    return true
  }
}

/// App Group backing — the real cross-process store shared by the app + Safari extension.
public struct AppGroupBacking: SettingsBacking {
  private let defaults: UserDefaults
  private let key = "still:settings"

  public init?(appGroupId: String) {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return nil }
    self.defaults = defaults
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
