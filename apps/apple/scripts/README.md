# Still Apple build and archive commands

Still 2.0 provides free blocking with optional account sync. Both paid-tier flags remain false;
RevenueCat identity plumbing remains active; purchase UI stays dormant. On mobile, blocking applies to
supported websites in Safari, not native social apps.

| Script | Behavior |
|---|---|
| `build.sh [ios-sim\|ios-device\|macos]` | Rebuilds the webview and Safari bundles, then builds the chosen app. Device/macOS commands allow provisioning updates; obtain approval before an external provisioning change. |
| `test.sh` | Runs real StillKit tests and workspace checks. It does not certify physical devices. |
| `archive.sh` | Rebuilds web resources, archives iOS and exports an App Store IPA with an ASC API key. It permits provisioning updates; `UPLOAD=1` additionally uploads. Both external actions require explicit approval. |
| `release-env-guard.sh`, `release-env-state.mjs`, `modern-sync-shipped` | Sourced by `archive.sh` before any build, and run by the Xcode extension-resources phase on Release builds. Refuses to archive when the web and Safari-extension builds disagree about cloud-sync configuration, the modern settings-sync flag or the Apple atomic flag. The state helper uses the real Vite and WXT env loaders and prints state tokens only, never a value. `modern-sync-shipped` says `not-shipped` today; the owner-approved change that ships the flag sets it to `shipped`, after which every archive must keep the flag. Tested by `release-env-guard.test.mjs` (part of `pnpm test:release`, no Xcode). |
| `ExportOptions.plist` | Existing App Store export configuration. |

Use [current release status](../../../docs/release/history/2026-09-14-release-status.md) for submitted
artifacts and [the historical candidate record](../../../docs/release/history/2026-09-08-still-2-certification.md)
for its original hashes/tests. Source defaults are 2.0.0 (7); submitted Apple packages are 2.0.0 (8).
Do not reuse an earlier archive as proof for newer source or rebuild pending packages merely to sync Git.

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

On a Release build the "Copy Safari Web Extension Resources" run-script phase first runs
`scripts/release-env-guard.sh` (the same release-build env guard as `archive.sh`), so these raw
commands refuse to build when the web and Safari-extension builds disagree about cloud-sync
configuration, exactly like the script. It checks both packages' production environments with the
real Vite and WXT loaders and never prints a value; it covers the extension build the phase runs,
and the web bundle you built beforehand must have been built the same way. Node must be on PATH.

These commands do not request provisioning updates or upload. Use unique archive/DerivedData
paths for each candidate. Missing signing profiles/certificates are a gate to resolve against the
concrete candidate, not permission to create or rotate them. Inspect nested extension signatures,
App Groups, versions, and bundled web resources. Development-signed archives do not establish
App Store export readiness.

After signed installation, verify the native webview, Safari extension, App Group propagation,
restart/background behavior, offline free blocking and the approved synthetic-account sync
journeys for the affected candidate. Preserve existing Mac/iPhone evidence and repeat only checks
needed by a change/failure. Physical iPad is owner-accepted skipped/unverified for this release.
Record device/OS, artifact hash and actual results. Deployment, production-account tests, privacy/store publication and submission remain
separate approval gates.
