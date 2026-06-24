// swift-tools-version: 6.0
import PackageDescription

// Shared Swift logic for the Apple app + Safari extension (U17). Kept as a package so the storage
// bridge is unit-testable from the terminal (`swift test`) with no signing, devices, or Xcode
// targets. The app/extension targets depend on this.
let package = Package(
  name: "StillKit",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "StillKit", targets: ["StillKit"]),
  ],
  targets: [
    .target(name: "StillKit"),
    .testTarget(name: "StillKitTests", dependencies: ["StillKit"]),
  ],
  swiftLanguageModes: [.v5],
)
