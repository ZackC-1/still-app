// swift-tools-version: 6.0
import PackageDescription

// Shared Swift logic for the Apple app + Safari extension (U17). Kept as a package so the storage
// bridge is unit-testable from the terminal (`swift test`) with no signing, devices, or Xcode
// targets. The app/extension targets depend on this.
let package = Package(
  name: "StillKit",
  // Match the app/extension targets (iOS 15 / macOS 10.14). StillKit only touches Foundation
  // (Codable, UserDefaults, JSON), so it carries no higher floor of its own.
  platforms: [.iOS(.v15), .macOS(.v10_14)],
  products: [
    .library(name: "StillKit", targets: ["StillKit"]),
  ],
  targets: [
    .target(name: "StillKit"),
    .testTarget(name: "StillKitTests", dependencies: ["StillKit"]),
  ],
  swiftLanguageModes: [.v5],
)
