# Apple apps and Safari extensions

| Folder | Purpose |
|---|---|
| `Still/` | Xcode project with iOS/macOS app targets and their Safari extension targets. Shared and platform folders follow Xcode's conventions. |
| `StillKit/` | Swift package for testable settings, entitlement, trust and onboarding decisions. |
| `scripts/` | Build, test, archive, signing helpers and export configuration. |
| `build/` | Ignored local build/archive output; preserve submitted-release evidence. |

The Xcode targets consume generated bundles from
[app-webview](../../packages/app-webview/README.md) and
[ext-safari](../../packages/ext-safari/README.md). Use the [build guide](scripts/README.md) so
native builds contain current web resources. Do not rearrange Xcode resource paths independently
of the project references and copy phases.

Run pure Swift checks with `swift test --package-path apps/apple/StillKit` from the repository root.
Signing, device validation and submission follow the [Apple release runbook](../../docs/release/01-apple-app-store.md).
On iPhone/iPad, blocking operates in Safari websites, not native social apps.

## Local StoreKit testing (simulator only)

[`Still/Still.storekit`](Still/Still.storekit) lets the iOS app run against local, fake StoreKit
products in the Simulator. It lists the new one-time Still Pro product (`still_pro_v3`) and the
historical, no-longer-sold `still_sync` product, mirroring
[`ApplePurchaseCatalog`](StillKit/Sources/StillKit/ApplePurchaseCatalog.swift), the single source
of truth for product and entitlement identifiers. Nothing in it reaches App Store Connect, and
no real charge is possible.

To use it for a local test run only: in Xcode choose **Product → Scheme → Edit Scheme… → Run →
Options → StoreKit Configuration → Still.storekit**, then run on a Simulator. Keep that choice in
your personal (unshared) scheme. Turn it back to **None** afterwards.

- Xcode applies a StoreKit configuration only to Run and Test from Xcode. Archives and Release
  builds never use it, and the file belongs to no target, so it is never copied into an app.
  `ApplePurchaseCatalogTests` fails if the file joins a target or a build setting, if a shared
  scheme selects it outside a Debug Run/Test action, or if it drifts from the catalog.
- Do not commit a shared scheme for the app targets: Xcode then stops auto-creating the
  `Still (iOS)`/`Still (macOS)` schemes that `scripts/build.sh` and `scripts/archive.sh` use.
- Leave the RevenueCat key out of `Config/Secrets.local.xcconfig` for these runs, so no local
  transaction is sent to RevenueCat. Purchase and Restore stay refused while the paid tier is off;
  use Xcode's **Debug → StoreKit → Manage Transactions** to create, refund or delete test
  transactions.
