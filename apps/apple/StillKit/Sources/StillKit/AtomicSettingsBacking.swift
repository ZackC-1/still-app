import Foundation
import Darwin

/// One lock inode per installation record. Never lock the replaceable data inode: a peer may
/// already have opened it when rename replaces it. The closure reads after acquiring the lock.
public final class AtomicSettingsBacking: SettingsBacking {
  public enum Failure: Error { case lock, replacement, oversized }
  private let directory: URL
  private let name: String
  private let legacyRead: () -> Data?
  private let beforeReplace: (() throws -> Void)?

  public init(directory: URL, name: String = "still-settings", legacyRead: @escaping () -> Data? = { nil },
              beforeReplace: (() throws -> Void)? = nil) {
    self.directory = directory
    self.name = name
    self.legacyRead = legacyRead
    self.beforeReplace = beforeReplace
  }

  public func read() -> Data? { try? transaction { $0 } }
  public func write(_ data: Data) { _ = try? transaction { current in current = data } }

  /// Shared with subsequent native consumers. A failed transaction keeps the previous bytes;
  /// callers must pause unsafe writes rather than infer a fresh installation from a failure.
  public func transaction<T>(_ body: (inout Data?) throws -> T) throws -> T {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let lock = open(directory.appendingPathComponent(name + ".lock").path, O_CREAT | O_RDWR, 0o600)
    guard lock >= 0 else { throw Failure.lock }
    defer { close(lock) }
    var locked: Int32
    repeat { locked = flock(lock, LOCK_EX) } while locked != 0 && errno == EINTR
    guard locked == 0 else { throw Failure.lock }
    defer { flock(lock, LOCK_UN) }
    // An interrupted process can leave its uncommitted temporary file. Owning the same lock
    // proves no live writer is using these uniquely named temporary files now.
    for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      where file.lastPathComponent.hasPrefix(name + ".") && file.pathExtension == "tmp" {
      try? FileManager.default.removeItem(at: file)
    }
    let target = directory.appendingPathComponent(name + ".json")
    let existed = FileManager.default.fileExists(atPath: target.path)
    let old = existed ? try Data(contentsOf: target) : legacyRead()
    var current = old
    let result = try body(&current)
    // Freeze a readable legacy projection into this authority even on the first read/no-op.
    // Subsequent hosts must never keep consulting a separately writable UserDefaults value.
    if (current != old || !existed), let current {
      guard current.count <= 131_072 else { throw Failure.oversized }
      let temporary = directory.appendingPathComponent(name + "." + UUID().uuidString + ".tmp")
      defer { try? FileManager.default.removeItem(at: temporary) }
      let fd = open(temporary.path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
      guard fd >= 0 else { throw Failure.replacement }
      do {
        try current.withUnsafeBytes { bytes in
          var offset = 0
          while offset < bytes.count {
            let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw Failure.replacement }
            offset += count
          }
        }
        guard fsync(fd) == 0 else { throw Failure.replacement }
        try beforeReplace?()
        guard rename(temporary.path, target.path) == 0 else { throw Failure.replacement }
        // Durability of the replacement directory entry is separate from the file's contents.
        let dir = open(directory.path, O_RDONLY)
        if dir >= 0 { _ = fsync(dir); close(dir) }
        close(fd)
      } catch {
        close(fd)
        throw error
      }
    }
    return result
  }
}
