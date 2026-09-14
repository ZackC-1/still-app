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
