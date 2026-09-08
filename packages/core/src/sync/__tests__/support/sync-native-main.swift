import Foundation

// Synthetic JSON transport around the production store and bridge, without WebKit or a device.
let store = SharedSettingsStore(backing: InMemoryBacking())
let bridge = SettingsBridge(store: store, notifyChanged: {})
while let line = readLine() {
  guard let bytes = line.data(using: .utf8),
        let body = try? JSONSerialization.jsonObject(with: bytes),
        let reply = bridge.handle(rawBody: body) else {
    print("null")
    continue
  }
  print(reply)
  fflush(stdout)
}
