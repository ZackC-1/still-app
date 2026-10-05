// swift-tools-version: 6.0
import PackageDescription

// Shared Swift logic for the Apple app + Safari extension (U17). Kept as a package so the storage
// bridge is unit-testable from the terminal (`swift test`) with no signing, devices, or Xcode
// targets. The app/extension targets depend on this.
let package = Package(
  name: "StillKit",
  // Match the app/extension deployment targets (iOS 15 / macOS 12). StillKit uses Foundation and
  // Swift concurrency APIs that need at least macOS 10.15.
  platforms: [.iOS(.v15), .macOS(.v12)],
  products: [
    .library(name: "StillKit", targets: ["StillKit"]),
  ],
  targets: [
    .target(name: "StillKit"),
    .testTarget(name: "StillKitTests", dependencies: ["StillKit"]),
  ],
  swiftLanguageModes: [.v5]
)
