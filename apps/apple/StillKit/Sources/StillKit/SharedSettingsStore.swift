import Foundation

// The shared settings store + its pluggable backing (KTD4). Production uses the App Group container
// (so the app, the Safari extension, and the WKWebView agree); tests use an in-memory backing.
// Merge asks the repoint counter first, then the server sync metadata when present, and falls back
// to last-write-wins by `updatedAt` for old settings-only records. The first-sign-in merge itself is
// decided in the shared core, not here; see the note on `shouldApply`.

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

  /// Persist settings as JSON the web UI can also read. Both stamps already in the store ride
  /// along: a caller handing over bare settings is saying what the settings are, not that this
  /// device has been repointed at a different account, and dropping `syncEpoch` here would reset
  /// the store to "never repointed" and let the previous account's record win again.
  public func save(_ settings: StillSettings) {
    let stored = currentRecord()
    saveRecord(
      StoredSettingsRecord(
        settings: settings, syncMetadata: stored.syncMetadata, syncEpoch: stored.syncEpoch))
  }

  public func saveRecord(_ record: StoredSettingsRecord) {
    guard let data = try? encoder.encode(record) else { return }
    backing.write(data)
  }

  /// Apply an incoming settings set via last-write-wins. Returns true if the store changed.
  @discardableResult
  public func applyRemote(_ incoming: StillSettings) -> Bool {
    let stored = currentRecord()
    guard stored.syncMetadata == nil, incoming.updatedAt > current().updatedAt else { return false }
    // Same reason as `save`: settings arriving without sync metadata say nothing about which
    // account this device is pointed at, so the repoint counter is carried rather than reset.
    saveRecord(StoredSettingsRecord(settings: incoming, syncMetadata: nil, syncEpoch: stored.syncEpoch))
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
  // The repoint counter is asked first, and a higher one wins outright, because it answers a
  // question the server version cannot: whether the two records are even counting the same
  // account. Sign-in on a shared device repoints this device, and the account it lands on is
  // routinely on a LOWER version than the one the previous person left here. Judging that by
  // version alone is what used to make this container refuse the newcomer's settings, hand the
  // previous person's back through the bridge, and get them published into the newcomer's account.
  //
  // A record with no counter has never been repointed, so it ranks where zero ranks. That is the
  // whole of the tolerance: absence is a position in the order, not an exemption from it, or a
  // record from a build that predates the counter could still displace one that has been
  // repointed. Within one epoch the rules below stand exactly as they were.
  //
  // This is the order the Safari extension's App Group reconcile uses, and the two must agree or
  // whichever one disagrees undoes the other: both arbitrate between two STORED records, so both
  // rank an absent counter at zero. The shared web cache (SettingsCache.applyStoredRecord in
  // packages/core) deliberately differs on exactly that point, because it is judging an incoming
  // record against its own live state rather than against a second stored one; the reason it is
  // softer is recorded there.
  let incomingEpoch = incoming.syncEpoch ?? 0
  let currentEpoch = current.syncEpoch ?? 0
  if incomingEpoch != currentEpoch { return incomingEpoch > currentEpoch }

  switch (incoming.syncMetadata, current.syncMetadata) {
  case let (incomingMeta?, currentMeta?):
    if incomingMeta.version != currentMeta.version { return incomingMeta.version > currentMeta.version }
    if incomingMeta.serverUpdatedAt != currentMeta.serverUpdatedAt {
      return incomingMeta.serverUpdatedAt > currentMeta.serverUpdatedAt
    }
    // Same SERVER base (version + serverUpdatedAt equal) — a local dirty edit stamps only a newer
    // settings.updatedAt and leaves the metadata untouched, so it must win here or a synced user's
    // popup/extension edits would be silently rejected. Mirrors the web SettingsCache, which falls
    // through to settings.updatedAt on an equal-version incoming (cache.ts applyStoredRecord).
    return incoming.settings.updatedAt > current.settings.updatedAt
  case (.some, .none):
    // A synced record always lands over a device-only one, and that is deliberate rather than
    // careless. First sign-in is where a device's own settings meet an account's, and that
    // comparison is made ONCE, in the shared core, which then hands down whichever side won. By
    // the time a record with sync metadata reaches this store the decision has already been taken;
    // re-judging it here on timestamps would reverse it, and the app and the Safari extension
    // would then disagree until the next reconcile. Do not add a comparison to this case.
    //
    // The repoint counter above is asked before this switch and does not re-open that decision. It
    // could only reverse this case for a record carrying a repoint but no sync metadata, and
    // nothing writes one: a repoint is counted by the sign-in that hands this device an account,
    // which is the same moment the metadata arrives.
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
