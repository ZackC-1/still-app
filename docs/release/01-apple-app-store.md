# Track 1 — Apple App Store: iOS, macOS and Safari

Current reference for Still 2.0.0, reviewed September 14, 2026. Use the
[dated release status](history/2026-09-14-release-status.md#store-snapshot) for the latest recorded portal
observations. This refresh did not recheck or change the portals. The iOS and macOS submissions
were recorded as version 2.0.0 build 8, waiting for review with manual release.

## Current product and listing

All four services and optional settings sync are free. No purchase or account is needed for
blocking. On iPhone/iPad, Still affects Safari websites, not native social apps. On Mac it runs in
Safari; Chrome and Firefox need their separate extensions. Install on each supported browser/device
and sign in with the same email for optional sync.

Use [listing copy](store-listing-copy.md), [public contacts](public-contact-addresses.md) and the
[current screenshot manifest](screenshots/store-ready/README.md#apple-app-store--iphone-ipad-and-mac).
The owner's later portal wording is intentional: do not overwrite it with repository drafts.
Keep submitted Mac screenshots in their accepted order: controls first, optional sync second.

| Field | Current value / source |
|---|---|
| App / extension | `com.chartash.still` / `com.chartash.still.Extension` |
| App Group / team | `group.com.chartash.still` / `UM9HVDH3P3` |
| App Store ID | `6784061138` |
| Support / privacy | `https://stillapp.fit/support/` / `https://stillapp.fit/privacy/` |
| App download | Free; verify the actual portal price before a future publication change. |
| Legacy Apple product | `still_sync`; preserve identity and historical ownership. |

## In-app-purchase presentation

The September 14 record reports the existing `still_sync` product at zero price and reviewer notes
updated to describe free access. Client paid-tier flags are false; purchase/restore controls are
dormant. No restore is needed for any 2.0.0 feature. Apple may still show an in-app-purchase label
because the product remains configured; that label does not mean the free features need a purchase.

Do not recreate the product, attach paid-upgrade instructions, change its territory availability,
or restore old promotional artwork as a release-cleanup step. App territory availability (142
regions in the owner's record) and IAP availability are separate. Retained RevenueCat/receipt
behavior is documented in [the monetization reference](../monetization-design.md).

## Review instructions

The current reviewer flow is:

1. Install/open Still, follow native onboarding, enable the Safari extension and grant website access.
2. Test all four services signed out. YouTube Shorts links open the normal player; ordinary
   YouTube/Instagram/Facebook content remains; the TikTok website is blocked.
3. Exercise global/per-service controls and persistence. There is no paid upgrade step.
4. Optionally sign in to test free settings sync. Supply review access only in private portal
   fields, matching the deployed review-sign-in configuration. Sign-out leaves blocking available;
   account deletion is in-app, and export help is available through `privacy@stillapp.fit`.
5. Explain the Safari-only mobile boundary and retained legacy purchase product in review notes.

The [auth/reviewer runbook](extension-purchase-deploy-checklist.md) governs fixed-code access.
Do not rotate or disable the shared reviewer code while either submitted platform still needs it.
Never put account credentials in this repository.

## Privacy and assets

Review the retained SDK as well as optional account data. Current declarations cover email,
identifiers, purchase history and synced settings with their actual uses. Purchase analytics is
not itself advertising tracking. Use the published [privacy notice](https://stillapp.fit/privacy/)
and [retention reference](counter-retention.md); do not claim that signed-out Apple users send no
SDK data or that deleting an account erases all billing/provider records.

Preserve the owner-approved submitted screenshots. For a future replacement, capture the actual
candidate and verify dimensions, readability, privacy and platform scope against Apple's
[screenshot reference](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).
A native iPad screenshot is not proof of physical iPad testing.

## Build and submission provenance

The checked-in Xcode project defaults to marketing version 2.0.0, build 7. The submitted packages
are build 8. Follow [Apple build helpers](../../apps/apple/scripts/README.md) and the recorded
artifact manifest for the package being discussed; never infer its build number from current source
alone. Native deployment targets are iOS/iPadOS 15.0 and macOS 12.0.

For a new authorized build: freeze source/public configuration, select an unused build number after
checking portal history, build configured webview/Safari resources, create signed Release archives
and distribution exports, and verify nested identifiers, entitlements, versions and hashes. iOS and
macOS archive/upload/review independently. Do not rebuild, withdraw or resubmit pending artifacts
merely to incorporate later documentation or development-tooling changes.

Before final publication, check each live review state, complete manual release when approved,
and verify the public version, free wording, screenshots and download links. Existing owner tests
remain credited to their actual artifacts. Physical iPad testing is owner-accepted skipped/unverified;
issue #153 retains the hosted account-lifecycle/final-certification work. Do not restart the full
Mac/iPhone test program because an old checklist is unchecked.

## Historical Apple procedures

The complete [previous Apple runbook](../archive/pre-2.0-reference-refresh/docs/release/01-apple-app-store.md)
preserves July rejection details, purchase-first decisions, promoted-IAP artwork history and the
old numbered checklists. Those procedures are not instructions for this free release.
