import Foundation
import Darwin

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let pause = CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "pause"
let backing = AtomicSettingsBacking(directory: directory, beforeReplace: pause ? {
  print("paused")
  fflush(stdout)
  raise(SIGSTOP)
} : nil)
let store = SharedSettingsStore(backing: backing)
let bridge = SettingsBridge(store: store, notifyChanged: {})
if CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "hold" {
  try backing.transaction { _ in
    print("holding"); fflush(stdout)
    usleep(200_000)
  }
  exit(0)
}
while let line = readLine() {
  if line == "seed" || line.hasPrefix("seed:") {
    store.save(StillSettings(globalOn: true, services: StillServices(), pauses: [], updatedAt: 1))
    _ = try store.initializeAtomic(ownership: line.hasPrefix("seed:") ? String(line.dropFirst(5)) : "unknown")
    print(String(data: store.encodedRecord()!, encoding: .utf8)!)
  } else if line.hasPrefix("replace:") {
    let replacement = Data(line.dropFirst(8).utf8)
    try backing.transaction { $0 = replacement }
    print("replaced")
  } else {
    let raw = try JSONSerialization.jsonObject(with: Data(line.utf8))
    print(bridge.handle(rawBody: raw) ?? "invalid")
  }
  fflush(stdout)
}
