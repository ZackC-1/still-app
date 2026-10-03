import Foundation

// The shared settings store + its pluggable backing (KTD4). Production uses the App Group container
// (so the app, the Safari extension, and the WKWebView agree); tests use an in-memory backing.
// Merge asks the repoint counter first, then the server sync metadata when present, and falls back
// to last-write-wins by `updatedAt` for old settings-only records. The first-sign-in merge itself is
// decided in the shared core, not here; see the note on `shouldApply`.

public protocol SettingsBacking {
  func read() -> Data?
  func write(_ data: Data)
  func transaction<T>(_ body: (inout Data?) throws -> T) throws -> T
}

extension SettingsBacking {
  public func transaction<T>(_ body: (inout Data?) throws -> T) throws -> T {
    var data = read()
    let original = data
    let result = try body(&data)
    if data != original, let data { write(data) }
    return result
  }
}

public final class SharedSettingsStore {
  private let backing: SettingsBacking
  public let coordinationAvailable: Bool
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(backing: SettingsBacking, coordinationAvailable: Bool = true) {
    self.coordinationAvailable = coordinationAvailable
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
    guard let data = backing.read(), (try? AtomicSettingsRecord.validateRecord(data)) != nil, let record = try? decoder.decode(StoredSettingsRecord.self, from: data) else {
      return nil
    }
    var projected = record
    if let raw = try? JSONDecoder().decode([String: SettingsJSONValue].self, from: data),
      let held = raw["atomic"]?.object?["held"]?.object {
      for (path, value) in held {
        guard case .bool(let on) = value else { continue }
        switch path {
        case "globalOn": projected.settings.globalOn = on
        case "services.youtube": projected.settings.services.youtube = on
        case "services.instagram": projected.settings.services.instagram = on
        case "services.tiktok": projected.settings.services.tiktok = on
        case "services.facebook": projected.settings.services.facebook = on
        default: break
        }
      }
    }
    return projected
  }

  /// Persist settings as JSON the web UI can also read. Both stamps already in the store ride
  /// along: a caller handing over bare settings is saying what the settings are, not that this
  /// device has been repointed at a different account, and dropping `syncEpoch` here would reset
  /// the store to "never repointed" and let the previous account's record win again.
  public func save(_ settings: StillSettings) {
    _ = try? backing.transaction { data in
      let stored = data.flatMap { try? decoder.decode(StoredSettingsRecord.self, from: $0) }
        ?? StoredSettingsRecord(settings: .default, syncMetadata: nil)
      let record = StoredSettingsRecord(settings: settings, syncMetadata: stored.syncMetadata, syncEpoch: stored.syncEpoch)
      data = try preserving(record, over: data)
    }
  }

  public func saveRecord(_ record: StoredSettingsRecord) {
    _ = try? backing.transaction { data in data = try preserving(record, over: data) }
  }

  @discardableResult
  public func applyRemote(_ incoming: StillSettings) -> Bool {
    (try? backing.transaction { data in
      let stored = data.flatMap { try? decoder.decode(StoredSettingsRecord.self, from: $0) }
        ?? StoredSettingsRecord(settings: .default, syncMetadata: nil)
      if let data, AtomicSettingsRecord.isModern(data) { return false }
      guard stored.syncMetadata == nil, incoming.updatedAt > stored.settings.updatedAt else { return false }
      data = try preserving(StoredSettingsRecord(settings: incoming, syncMetadata: nil, syncEpoch: stored.syncEpoch), over: data)
      return true
    }) ?? false
  }

  @discardableResult
  public func applyRecord(_ incoming: StoredSettingsRecord) -> Bool {
    (try? applyEncodedRecord(encoder.encode(incoming)).changed) ?? false
  }

  /// The returned bytes are captured under the same lock as the write, before notifying peers.
  public func applyEncodedRecord(_ incoming: Data) throws -> (data: Data?, changed: Bool) {
    try backing.transaction { data in
      try AtomicSettingsRecord.validateRecord(incoming)
      if let data { try AtomicSettingsRecord.validateRecord(data) }
      let record = try decoder.decode(StoredSettingsRecord.self, from: incoming)
      if let data, (try? decoder.decode(StoredSettingsRecord.self, from: data)) == nil {
        throw AtomicSettingsRecord.Failure.unreadable
      }
      let stored = data.flatMap { try? decoder.decode(StoredSettingsRecord.self, from: $0) }
        ?? StoredSettingsRecord(settings: .default, syncMetadata: nil)
      // A coarse snapshot cannot replace an installation's modern field authority.
      if let data, AtomicSettingsRecord.isModern(data) { return (data, false) }
      guard shouldApply(record, over: stored) else { return (data, false) }
      let resolved = try preserving(record, over: data, incoming: incoming)
      let changed = resolved != data
      data = resolved
      return (data, changed)
    }
  }

  public func encodedRecord() -> Data? { backing.read() }
  public func readCommittedRecord() throws -> Data? { try backing.transaction { $0 } }

  public func atomicCommand(_ command: Data) throws -> (data: Data, changed: Bool) {
    guard coordinationAvailable else { throw AtomicSettingsRecord.Failure.unavailable }
    return try backing.transaction { data in
      let resolved = try AtomicSettingsRecord.command(data, command: command)
      let changed = resolved != data
      data = resolved
      return (resolved, changed)
    }
  }

  /// Actual committed action, never a snapshot diff. No account or entitlement required.
  public func commitIntent(path: String, value: Bool, updatedAt: Int) throws -> (data: Data, changed: Bool) {
    return try backing.transaction { data in
      if !coordinationAvailable, let raw = data, AtomicSettingsRecord.isModern(raw) {
        let result = try AtomicSettingsRecord.hold(raw, path: path, value: value)
        data = result.data
        return result
      }
      let result = try AtomicSettingsRecord.commit(data, path: path, value: value, updatedAt: updatedAt)
      data = result.data
      return result
    }
  }

  /// Bounded source-only migration entry point. Missing marker is unknown, never pristine.
  public func initializeAtomic(ownership: String) throws -> Data {
    guard coordinationAvailable else { throw AtomicSettingsRecord.Failure.unavailable }
    return try backing.transaction { data in
      let result = try AtomicSettingsRecord.initialize(data, ownership: ownership)
      data = result
      return result
    }
  }

  private func preserving(_ record: StoredSettingsRecord, over old: Data?, incoming: Data? = nil) throws -> Data {
    if let old, AtomicSettingsRecord.isModern(old) { return old }
    if let old, (try? decoder.decode(StoredSettingsRecord.self, from: old)) == nil { throw AtomicSettingsRecord.Failure.unreadable }
    var root = old.flatMap { try? JSONDecoder().decode([String: SettingsJSONValue].self, from: $0) } ?? [:]
    var settings = root["settings"]?.object ?? (root["globalOn"] != nil ? root : [:])
    let incomingRoot = incoming.flatMap { try? JSONDecoder().decode([String: SettingsJSONValue].self, from: $0) }
    if let incomingRoot {
      let incomingSettings = incomingRoot["settings"]?.object ?? (incomingRoot["globalOn"] != nil ? incomingRoot : [:])
      settings = preservingMembers(settings, incomingSettings)
      root.merge(incomingRoot) { _, new in new }
    }
    let typed = try JSONDecoder().decode([String: SettingsJSONValue].self, from: encoder.encode(record.settings))
    var services = settings["services"]?.object ?? [:]
    services.merge(typed["services"]!.object!) { _, new in new }
    settings.merge(typed) { _, new in new }
    services.removeValue(forKey: "entitlement")
    settings.removeValue(forKey: "entitlement")
    root.removeValue(forKey: "entitlement")
    settings["services"] = .object(services)
    if root["globalOn"] != nil { root = [:] }
    root["settings"] = .object(settings)
    root["syncMetadata"] = record.syncMetadata.map { try? JSONDecoder().decode(SettingsJSONValue.self, from: encoder.encode($0)) } ?? .null
    if let epoch = record.syncEpoch { root["syncEpoch"] = .number(Double(epoch)) }
    return try encoder.encode(root)
  }

  /// Older full-record writers do not know every member already saved by another host.
  private func preservingMembers(_ old: [String: SettingsJSONValue], _ incoming: [String: SettingsJSONValue]) -> [String: SettingsJSONValue] {
    old.merging(incoming) { previous, next in
      if let previous = previous.object, let next = next.object {
        return .object(preservingMembers(previous, next))
      }
      return next
    }
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
    guard let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier) else {
      return SharedSettingsStore(backing: InMemoryBacking(AppGroupBacking(appGroupId: identifier)?.read()), coordinationAvailable: false)
    }
    let legacy = AppGroupBacking(appGroupId: identifier)
    return SharedSettingsStore(backing: AtomicSettingsBacking(directory: directory, legacyRead: { legacy?.read() }))
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
  private let lock = NSRecursiveLock()
  public init(_ initial: Data? = nil) { self.data = initial }
  public func read() -> Data? { lock.lock(); defer { lock.unlock() }; return data }
  public func write(_ data: Data) { lock.lock(); defer { lock.unlock() }; self.data = data }
  public func transaction<T>(_ body: (inout Data?) throws -> T) throws -> T {
    lock.lock(); defer { lock.unlock() }
    var next = data
    let result = try body(&next)
    data = next
    return result
  }
}
