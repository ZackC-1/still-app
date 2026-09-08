# Still Apple build and archive commands

Still 2.0 provides free blocking with optional account sync. Both paid-tier flags remain false;
RevenueCat identity and purchase infrastructure stay dormant. On mobile, blocking applies to
supported websites in Safari, not native social apps.

| Script | Behavior |
|---|---|
| `build.sh [ios-sim\|ios-device\|macos]` | Rebuilds the webview and Safari bundles, then builds the chosen app. Device/macOS commands allow provisioning updates; obtain approval before an external provisioning change. |
| `test.sh` | Runs real StillKit tests and workspace checks. It does not certify physical devices. |
| `archive.sh` | Rebuilds web resources, archives iOS and exports an App Store IPA with an ASC API key. It permits provisioning updates; `UPLOAD=1` additionally uploads. Both external actions require explicit approval. |
| `ExportOptions.plist` | Existing App Store export configuration. |

Use [release certification](../../../docs/release/2026-09-08-still-2-certification.md) for the
candidate, versions, evidence and remaining approval gates. Do not reuse an earlier archive as
proof for newer source.

## Local preparation

```sh
pnpm install --frozen-lockfile
pnpm --filter @still/app-webview build
pnpm --filter @still/ext-safari build
swift test --package-path apps/apple/StillKit
```

Provide only approved public Supabase configuration to the web build. The native RevenueCat
`appl_` key is public client configuration; server keys, signing private keys and credentials must
never enter app resources. Do not copy an entire ignored environment file into a source submission.

For a Release archive using existing local signing material, run from the repository root:

```sh
xcodebuild archive -project apps/apple/Still/Still.xcodeproj \
  -scheme 'Still (iOS)' -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /private/tmp/still-ios-2.0.0.xcarchive
xcodebuild archive -project apps/apple/Still/Still.xcodeproj \
  -scheme 'Still (macOS)' -configuration Release -destination 'generic/platform=macOS' \
  -archivePath /private/tmp/still-macos-2.0.0.xcarchive
```

These commands do not request provisioning updates or upload. Use unique archive/DerivedData
paths for each candidate. Missing signing profiles/certificates are a gate to resolve against the
concrete candidate, not permission to create or rotate them. Inspect nested extension signatures,
App Groups, versions, and bundled web resources. Development-signed archives do not establish
App Store export readiness.

After signed installation, verify the native webview, Safari extension, App Group propagation,
restart/background behavior, offline free blocking and the approved synthetic-account sync
journeys on macOS, physical iPhone and supported iPad. Record device/OS, artifact hash and actual
results. Deployment, production-account tests, privacy/store publication and submission remain
separate approval gates.
